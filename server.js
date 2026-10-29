import express from 'express';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Server } from 'socket.io';

const PORT = process.env.PORT || 3000;
const LICHESS = 'https://lichess.org';
const INVITE_TTL_MS = 60 * 60 * 1000;
const COLORS = new Set(['random', 'white', 'black']);

const app = express();
const http = createServer(app);
const io = new Server(http);

app.use(express.static('public'));
app.use('/cg', express.static('node_modules/@lichess-org/chessground/assets'));

// STUN finds a direct path between browsers; TURN relays audio when a direct path is blocked
// (strict NATs, corporate networks). Configure TURN via env vars in production.
app.get('/config', (req, res) => {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(','),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  res.json({ iceServers });
});

// ---------- Invites ----------
// An invite only pairs two Lichess users. The game itself is a Lichess challenge
// that the host's browser sends and the guest's browser accepts.

const invites = new Map();

function getInvite(id) {
  const invite = invites.get(id);
  if (invite && Date.now() - invite.createdAt > INVITE_TTL_MS) {
    invites.delete(id);
    return null;
  }
  return invite ?? null;
}

function publicInvite(invite) {
  const { hostId, hostName, minutes, increment, color } = invite;
  return { hostId, hostName, minutes, increment, color };
}

app.get('/api/invite/:id', (req, res) => {
  const invite = getInvite(req.params.id);
  if (!invite) return res.sendStatus(404);
  res.json(publicInvite(invite));
});

setInterval(() => {
  for (const id of invites.keys()) getInvite(id);
}, 10 * 60 * 1000).unref();

// ---------- Lichess lookups ----------

const gameCache = new Map();

// Returns the Lichess user ids of both players, so only they can join a game's voice room.
async function gamePlayers(gameId) {
  const cached = gameCache.get(gameId);
  if (cached && Date.now() - cached.at < 10_000) return cached.players;
  const res = await fetch(`${LICHESS}/game/export/${gameId}?moves=false&clocks=false&evals=false&opening=false`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return null;
  const game = await res.json();
  const players = [game.players?.white?.user?.id, game.players?.black?.user?.id].filter(Boolean);
  gameCache.set(gameId, { players, at: Date.now() });
  return players;
}

// Every socket must present a Lichess token; we only use it to learn who the user is.
io.use(async (socket, next) => {
  try {
    const res = await fetch(`${LICHESS}/api/account`, {
      headers: { Authorization: `Bearer ${socket.handshake.auth?.token}` },
    });
    if (!res.ok) throw new Error(`account lookup failed: ${res.status}`);
    const account = await res.json();
    socket.data.user = { id: account.id, name: account.username };
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

io.on('connection', (socket) => {
  const user = socket.data.user;

  // ----- invites -----

  socket.on('invite:create', ({ minutes, increment, color } = {}, ack) => {
    if (typeof ack !== 'function') return;
    if (!(Number.isInteger(minutes) && minutes >= 1 && minutes <= 180)) return ack({ error: 'Invalid time' });
    if (!(Number.isInteger(increment) && increment >= 0 && increment <= 60)) return ack({ error: 'Invalid increment' });
    if (!COLORS.has(color)) return ack({ error: 'Invalid color' });
    const id = randomBytes(6).toString('base64url');
    invites.set(id, { id, hostId: user.id, hostName: user.name, minutes, increment, color, createdAt: Date.now() });
    ack({ id });
  });

  // The host keeps the invite page open; this marks them as present.
  socket.on('invite:watch', (id) => {
    const invite = getInvite(id);
    if (invite?.hostId === user.id) socket.join(`invite-host:${id}`);
  });

  socket.on('invite:join', async (id, ack) => {
    if (typeof ack !== 'function') return;
    const invite = getInvite(id);
    if (!invite) return ack({ error: 'This invite has expired.' });
    if (invite.hostId === user.id) return ack({ error: "That's your own invite." });
    const hosts = await io.in(`invite-host:${id}`).fetchSockets();
    if (!hosts.length) return ack({ error: `${invite.hostName} isn't on the invite page right now. Ask them to open it again.` });
    socket.join(`invite-guest:${id}`);
    io.to(`invite-host:${id}`).emit('invite:guest', { guest: user.name });
    ack({ ok: true });
  });

  // Host created the Lichess challenge: pass it to the guest to accept.
  socket.on('invite:challenge', ({ inviteId, challengeId } = {}) => {
    const invite = getInvite(inviteId);
    if (invite?.hostId !== user.id || typeof challengeId !== 'string') return;
    io.to(`invite-guest:${inviteId}`).emit('invite:challenge', { challengeId });
  });

  socket.on('invite:failed', ({ inviteId, error } = {}) => {
    const invite = getInvite(inviteId);
    if (invite?.hostId !== user.id) return;
    io.to(`invite-guest:${inviteId}`).emit('invite:failed', { error: String(error).slice(0, 200) });
  });

  // Guest accepted: the game id is the challenge id. Tell the host and retire the invite.
  socket.on('invite:accepted', ({ inviteId, gameId } = {}) => {
    if (!getInvite(inviteId) || typeof gameId !== 'string') return;
    io.to(`invite-host:${inviteId}`).emit('invite:started', { gameId });
    invites.delete(inviteId);
  });

  // ----- voice signaling -----
  // Audio flows browser-to-browser over WebRTC. This server only relays the
  // offer/answer/ICE messages needed to set up that connection.

  function leaveVoice() {
    const room = socket.data.voiceRoom;
    if (!room) return;
    socket.to(room).emit('voice:peer-left');
    socket.leave(room);
    socket.data.voiceRoom = null;
  }

  socket.on('voice:join', async (gameId, ack) => {
    if (typeof ack !== 'function') return;
    if (typeof gameId !== 'string' || !/^[a-zA-Z0-9]{8}$/.test(gameId)) return ack({ error: 'Invalid game' });
    let players = await gamePlayers(gameId).catch(() => null);
    if (players && !players.includes(user.id)) {
      gameCache.delete(gameId);
      players = await gamePlayers(gameId).catch(() => null);
    }
    if (!players?.includes(user.id)) return ack({ error: 'Only the two players can use voice in this game.' });

    leaveVoice();
    const room = `voice:${gameId}`;
    const others = (await io.in(room).fetchSockets()).filter((s) => s.id !== socket.id);
    // Same user in another tab: that tab gives up its seat.
    for (const s of others.filter((s) => s.data.user.id === user.id)) {
      s.emit('voice:kicked');
      s.leave(room);
      s.data.voiceRoom = null;
    }
    const peer = others.find((s) => s.data.user.id !== user.id);

    socket.join(room);
    socket.data.voiceRoom = room;
    ack({ ok: true });

    if (peer) {
      peer.emit('voice:ready', { initiator: true, peer: user.name });
      socket.emit('voice:ready', { initiator: false, peer: peer.data.user.name });
    }
  });

  socket.on('voice:signal', (data) => {
    if (socket.data.voiceRoom) socket.to(socket.data.voiceRoom).emit('voice:signal', data);
  });

  socket.on('voice:status', ({ muted } = {}) => {
    if (socket.data.voiceRoom) socket.to(socket.data.voiceRoom).emit('voice:peer-status', { muted: !!muted });
  });

  socket.on('voice:leave', leaveVoice);
  socket.on('disconnect', leaveVoice);
});

http.listen(PORT, () => console.log(`Chess Voice running at http://localhost:${PORT}`));
