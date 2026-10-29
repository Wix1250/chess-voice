import { Chessground } from '@lichess-org/chessground';
import { Chess } from 'chess.js';
import { LICHESS, api, stream } from './lichess.js';
import { createVoice } from './voice.js';
import { html, esc } from './util.js';

const STATUS_TEXT = {
  mate: 'Checkmate',
  resign: 'Resignation',
  stalemate: 'Stalemate',
  timeout: 'Opponent left',
  draw: 'Draw',
  outoftime: 'Time out',
  aborted: 'Game aborted',
  noStart: "Game didn't start",
  cheat: 'Cheat detected',
  variantEnd: 'Game over',
};

const VOICE_TEXT = {
  off: 'Click the mic to talk',
  joining: 'Starting mic…',
  waiting: 'Waiting for opponent…',
  connecting: 'Connecting…',
  failed: "Couldn't connect",
};

const PROMOTION_PIECES = [
  ['q', 'queen'],
  ['r', 'rook'],
  ['b', 'bishop'],
  ['n', 'knight'],
];

// Castling may arrive as king-takes-rook; chess.js wants the king's destination square.
const CASTLE_ALIASES = { e1h1: 'e1g1', e1a1: 'e1c1', e8h8: 'e8g8', e8a8: 'e8c8' };

export function mountGame(root, { gameId, me, socket, iceServers }) {
  root.replaceChildren(
    html(`
    <div class="game">
      <div class="board-col">
        <div class="player top"><span class="name" id="top-name">…</span><span class="clock" id="top-clock"></span></div>
        <div class="board-wrap"><div id="board"></div><div class="promo" id="promo" hidden></div></div>
        <div class="player bottom"><span class="name" id="bottom-name">…</span><span class="clock" id="bottom-clock"></span></div>
      </div>
      <aside class="side">
        <section class="panel">
          <p class="status" id="status">Loading game…</p>
          <p class="note" id="note" hidden></p>
          <div class="buttons" id="controls"></div>
        </section>
        <section class="panel voice" id="voice-panel" hidden>
          <button class="mic" id="mic">
            <span class="mic-now" id="mic-now">🎙️</span><span class="mic-next" id="mic-next">🔇</span>
          </button>
          <div class="voice-text">
            <p class="voice-title">Voice chat</p>
            <p class="muted small" id="voice-status"></p>
          </div>
          <button class="speaker" id="speaker" hidden>🔊</button>
          <audio id="remote-audio" autoplay></audio>
        </section>
        <p class="muted small"><a href="${LICHESS}/${esc(gameId)}" target="_blank" rel="noopener">View this game on Lichess ↗</a></p>
      </aside>
    </div>`),
  );
  const $ = (sel) => root.querySelector(sel);

  const abort = new AbortController();
  let initialFen;
  let myColor = null;
  let speed = null;
  let players = null;
  let state = null;
  let stateTime = 0;
  let chess = new Chess();
  let resignArmed = false;

  const board = Chessground($('#board'), {
    coordinates: true,
    movable: { free: false, showDests: true, events: { after: onUserMove } },
    premovable: { enabled: true },
    animation: { duration: 200 },
  });

  // ----- game stream -----

  stream(`/api/board/game/stream/${gameId}`, onMessage, { signal: abort.signal })
    .then(() => {
      if (!state) setStatus('Game not found.');
    })
    .catch((e) => {
      if (e.name !== 'AbortError') setStatus(e.status === 404 ? 'Game not found.' : e.message);
    });

  function onMessage(msg) {
    if (msg.type === 'gameFull') {
      initialFen = msg.initialFen === 'startpos' ? undefined : msg.initialFen;
      speed = msg.speed;
      players = { white: msg.white, black: msg.black };
      myColor = msg.white.id === me.id ? 'white' : msg.black.id === me.id ? 'black' : null;
      board.set({ orientation: myColor ?? 'white' });
      $('#voice-panel').hidden = !myColor;
      renderPlayers();
      applyState(msg.state);
    } else if (msg.type === 'gameState') {
      applyState(msg);
    } else if (msg.type === 'opponentGone') {
      renderOpponentGone(msg);
    }
  }

  function playMove(uci) {
    uci = CASTLE_ALIASES[uci] && chess.get(uci.slice(0, 2))?.type === 'k' ? CASTLE_ALIASES[uci] : uci;
    chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  }

  function legalDests() {
    const dests = new Map();
    for (const m of chess.moves({ verbose: true })) {
      if (!dests.has(m.from)) dests.set(m.from, []);
      dests.get(m.from).push(m.to);
    }
    return dests;
  }

  const isRunning = () => state && (state.status === 'started' || state.status === 'created');
  const moveList = () => (state?.moves ? state.moves.split(' ') : []);

  function applyState(s) {
    state = s;
    stateTime = performance.now();
    chess = new Chess(initialFen);
    const moves = moveList();
    for (const uci of moves) playMove(uci);
    const last = moves.at(-1);
    const turn = chess.turn() === 'w' ? 'white' : 'black';
    const canPlay = isRunning() && !!myColor;
    board.set({
      fen: chess.fen(),
      turnColor: turn,
      lastMove: last ? [last.slice(0, 2), last.slice(2, 4)] : undefined,
      check: chess.inCheck() ? turn : false,
      movable: { color: canPlay ? myColor : undefined, dests: canPlay && turn === myColor ? legalDests() : new Map() },
      premovable: { enabled: canPlay },
    });
    if (!canPlay) board.cancelPremove();
    if (canPlay && turn === myColor) board.playPremove();
    renderStatus();
    renderControls();
    renderClocks();
  }

  async function onUserMove(orig, dest) {
    let uci = orig + dest;
    const piece = chess.get(orig);
    if (piece?.type === 'p' && (dest[1] === '8' || dest[1] === '1')) {
      const role = await choosePromotion(piece.color === 'w' ? 'white' : 'black');
      if (!role) return applyState(state);
      uci += role;
    }
    try {
      await api(`/api/board/game/${gameId}/move/${uci}`, { method: 'POST' });
    } catch (e) {
      setNote(`Move not accepted: ${e.message}`);
      applyState(state);
    }
  }

  function choosePromotion(color) {
    const promo = $('#promo');
    return new Promise((resolve) => {
      promo.replaceChildren(
        ...PROMOTION_PIECES.map(([letter, role]) => {
          const btn = document.createElement('button');
          btn.className = `cg-wrap promo-piece`;
          btn.title = role;
          btn.innerHTML = `<piece class="${role} ${color}"></piece>`;
          btn.onclick = (e) => {
            e.stopPropagation();
            promo.hidden = true;
            resolve(letter);
          };
          return btn;
        }),
      );
      promo.onclick = () => {
        promo.hidden = true;
        resolve(null);
      };
      promo.hidden = false;
    });
  }

  // ----- rendering -----

  function setStatus(text) {
    $('#status').textContent = text;
  }

  function setNote(text, extra) {
    const note = $('#note');
    note.replaceChildren(text);
    if (extra) note.append(' ', extra);
    note.hidden = !text;
  }

  function playerLabel(p) {
    if (!p) return '?';
    const name = p.name ?? (p.aiLevel ? `Stockfish level ${p.aiLevel}` : 'Anonymous');
    return p.rating ? `${name} (${p.rating}${p.provisional ? '?' : ''})` : name;
  }

  function renderPlayers() {
    const bottom = myColor ?? 'white';
    const top = bottom === 'white' ? 'black' : 'white';
    $('#bottom-name').textContent = playerLabel(players[bottom]);
    $('#top-name').textContent = playerLabel(players[top]);
  }

  function renderStatus() {
    if (isRunning()) {
      const turn = chess.turn() === 'w' ? 'white' : 'black';
      setStatus(myColor ? (turn === myColor ? 'Your move' : "Opponent's move") : `${turn === 'white' ? 'White' : 'Black'} to move`);
      return;
    }
    const reason = STATUS_TEXT[state.status] ?? 'Game over';
    let result = '';
    if (state.winner) {
      const winner = state.winner === 'white' ? 'White' : 'Black';
      result = myColor ? (state.winner === myColor ? 'You won' : 'You lost') : `${winner} won`;
    } else if (state.status !== 'aborted' && state.status !== 'noStart') {
      result = 'Draw';
    }
    setStatus(result && result !== reason ? `${result} · ${reason}` : reason);
    setNote('');
  }

  function button(label, onClick, cls = '') {
    const btn = document.createElement('button');
    btn.textContent = label;
    if (cls) btn.className = cls;
    btn.onclick = onClick;
    return btn;
  }

  async function act(path) {
    try {
      await api(`/api/board/game/${gameId}/${path}`, { method: 'POST' });
    } catch (e) {
      setNote(e.message);
    }
  }

  function renderControls() {
    const controls = $('#controls');
    controls.replaceChildren();
    if (!isRunning()) {
      const lobby = document.createElement('a');
      lobby.href = '#/';
      lobby.className = 'button primary';
      lobby.textContent = 'Back to lobby';
      controls.append(lobby);
      return;
    }
    if (!myColor) return;
    if (moveList().length < 2) {
      controls.append(button('Abort game', () => act('abort')));
      return;
    }
    const opponent = myColor === 'white' ? 'black' : 'white';
    const iOffered = state[myColor === 'white' ? 'wdraw' : 'bdraw'];
    const theyOffered = state[opponent === 'white' ? 'wdraw' : 'bdraw'];
    if (theyOffered) {
      controls.append(
        html('<p class="offer">Your opponent offers a draw.</p>'),
        button('Accept draw', () => act('draw/yes'), 'primary'),
        button('Decline', () => act('draw/no')),
      );
    } else {
      const draw = button(iOffered ? 'Draw offered' : 'Offer draw', () => act('draw/yes'));
      draw.disabled = !!iOffered;
      controls.append(draw);
    }
    const resign = button(resignArmed ? 'Click again to resign' : 'Resign', () => {
      if (resignArmed) return act('resign');
      resignArmed = true;
      renderControls();
      setTimeout(() => {
        resignArmed = false;
        if (isRunning()) renderControls();
      }, 3000);
    }, resignArmed ? 'danger' : '');
    controls.append(resign);
  }

  function renderOpponentGone({ gone, claimWinInSeconds }) {
    if (!gone || !isRunning()) return setNote('');
    if (claimWinInSeconds > 0) return setNote(`Your opponent left the game. You can claim victory in ${claimWinInSeconds}s.`);
    setNote('Your opponent left the game.', button('Claim victory', () => act('claim-victory'), 'primary'));
  }

  function formatClock(ms) {
    if (speed === 'correspondence') return '';
    const total = Math.max(0, ms);
    const minutes = Math.floor(total / 60000);
    const seconds = Math.floor((total % 60000) / 1000);
    if (total < 10000) return `${seconds}.${Math.floor((total % 1000) / 100)}`;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  function clockFor(color) {
    let ms = color === 'white' ? state.wtime : state.btime;
    const turn = chess.turn() === 'w' ? 'white' : 'black';
    const ticking = isRunning() && moveList().length >= 2 && turn === color;
    if (ticking) ms -= performance.now() - stateTime;
    return { ms, ticking };
  }

  function renderClocks() {
    if (!state || !players) return;
    const bottom = myColor ?? 'white';
    const top = bottom === 'white' ? 'black' : 'white';
    for (const [pos, color] of [['top', top], ['bottom', bottom]]) {
      const el = $(`#${pos}-clock`);
      const { ms, ticking } = clockFor(color);
      el.textContent = formatClock(ms);
      el.classList.toggle('running', ticking);
      el.classList.toggle('low', ticking && ms < 20000);
    }
  }

  const clockTimer = setInterval(renderClocks, 100);

  // ----- voice -----

  let voiceState = { status: 'off', muted: false, deafened: false };
  const voice = createVoice({
    socket,
    gameId,
    iceServers,
    audioEl: $('#remote-audio'),
    onChange: (v) => {
      voiceState = v;
      renderVoice(v);
    },
  });

  function renderVoice(v) {
    const active = v.status !== 'off';
    const mic = $('#mic');
    // The icon shows the current state; hovering previews what a click will do.
    const [now, next, hint] = !active
      ? [v.error ? '🚫' : '🎙️', '🎙️', 'Join voice']
      : v.muted
        ? ['🔇', '🎙️', 'Unmute']
        : ['🎙️', '🔇', 'Mute'];
    $('#mic-now').textContent = now;
    $('#mic-next').textContent = next;
    mic.dataset.hint = hint;
    mic.setAttribute('aria-label', hint);
    mic.className = `mic ${!active ? 'off' : v.muted ? 'muted' : 'live'}`;

    let text = v.error ?? VOICE_TEXT[v.status];
    if (v.status === 'connected') text = `Talking with ${v.peerName}${v.peerMuted ? ' · their mic is off' : ''}`;
    $('#voice-status').textContent = text;

    const speaker = $('#speaker');
    speaker.hidden = !active;
    speaker.textContent = v.deafened ? '🔈' : '🔊';
    speaker.classList.toggle('muted', v.deafened);
    speaker.title = v.deafened ? 'Unmute opponent' : 'Mute opponent';
    speaker.setAttribute('aria-label', speaker.title);
  }

  renderVoice(voiceState);
  $('#mic').onclick = () => (voiceState.status === 'off' ? voice.join() : voice.setMuted(!voiceState.muted));
  $('#speaker').onclick = () => voice.setDeafened(!voiceState.deafened);

  // Grow the mic's ring with your voice so you can see the mic is picking you up.
  const levelTimer = setInterval(() => $('#mic').style.setProperty('--level', voice.level().toFixed(2)), 60);

  return () => {
    abort.abort();
    clearInterval(clockTimer);
    clearInterval(levelTimer);
    voice.leave();
    board.destroy();
  };
}
