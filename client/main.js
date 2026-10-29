import { getToken, login, logout, clearToken, handleRedirect, api, stream } from './lichess.js';
import { mountGame } from './game.js';
import { html, esc, speedOf, flash } from './util.js';

// Lichess's Board API only allows rapid/classical for public seeks; direct challenges can also be blitz.
const RANDOM_CONTROLS = [[10, 0], [10, 5], [15, 10], [30, 0], [30, 20]];
const FRIEND_CONTROLS = [[3, 0], [3, 2], [5, 0], [5, 3], [10, 0], [10, 5], [15, 10], [30, 0]];

const app = document.getElementById('app');
let me = null;
let socket = null;
let iceServers = [];
let cleanup = null;
let routeId = 0;
let seekAbort = null;
let expectingGame = false;

async function init() {
  try {
    await handleRedirect();
  } catch (e) {
    flash(e.message);
  }
  iceServers = (await fetch('/config').then((r) => r.json())).iceServers;
  if (getToken()) {
    try {
      me = await api('/api/account');
    } catch {
      clearToken();
    }
  }
  if (me) {
    socket = io({ auth: { token: getToken() } });
    socket.on('connect_error', (e) => console.warn('socket', e.message));
    watchEvents();
  }
  renderUser();
  addEventListener('hashchange', route);
  route();
}

function renderUser() {
  const box = document.getElementById('user');
  if (!me) {
    box.replaceChildren();
    return;
  }
  box.replaceChildren(html(`<span>${esc(me.username)}</span> <button class="link" id="logout">Log out</button>`));
  box.querySelector('#logout').onclick = async () => {
    await logout();
    location.hash = '#/';
    location.reload();
  };
}

// The Lichess event stream tells us when a game we asked for has started.
async function watchEvents() {
  for (;;) {
    try {
      await stream('/api/stream/event', (event) => {
        if (event.type !== 'gameStart' || !expectingGame) return;
        expectingGame = false;
        location.hash = `#/game/${event.game.gameId ?? event.game.id}`;
      });
    } catch (e) {
      console.warn('event stream', e);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

function route() {
  cleanup?.();
  cleanup = null;
  seekAbort?.abort();
  expectingGame = false;
  const id = ++routeId;
  const [, view, param] = location.hash.split('/');
  if (view === 'game' && param && me) return showGame(param);
  if (view === 'invite' && param) return showInvite(param, id);
  showHome();
}

const tcOptions = (controls) =>
  controls.map(([m, i]) => `<option value="${m}+${i}">${m}+${i} · ${speedOf(m, i)}</option>`).join('');

function loginPrompt() {
  const btn = document.createElement('button');
  btn.className = 'primary big';
  btn.textContent = 'Log in with Lichess';
  btn.onclick = () => login();
  return btn;
}

// ---------- Lobby ----------

function showHome() {
  if (!me) {
    app.replaceChildren(
      html(`
      <section class="hero">
        <h1>Chess you can talk through.</h1>
        <p>Play a friend or a random opponent, with live voice chat during the game.</p>
        <div id="login-slot"></div>
        <p class="muted small">Games are played on lichess.org and count on your Lichess account.</p>
      </section>`),
    );
    app.querySelector('#login-slot').append(loginPrompt());
    return;
  }

  app.replaceChildren(
    html(`
    <div class="cards">
      <section class="card">
        <h2>Random opponent</h2>
        <p class="muted">Get matched with another Lichess player. Lichess allows only rapid and classical here.</p>
        <label>Time control <select id="seek-tc">${tcOptions(RANDOM_CONTROLS)}</select></label>
        <label class="check"><input type="checkbox" id="seek-rated"> Rated</label>
        <button class="primary" id="seek-btn">Find opponent</button>
        <p class="muted" id="seek-status" aria-live="polite"></p>
      </section>
      <section class="card">
        <h2>Play a friend</h2>
        <p class="muted">Create a link and send it to a friend. They'll need a Lichess account.</p>
        <label>Time control <select id="inv-tc">${tcOptions(FRIEND_CONTROLS)}</select></label>
        <label>Your color
          <select id="inv-color"><option value="random">Random</option><option value="white">White</option><option value="black">Black</option></select>
        </label>
        <button class="primary" id="inv-btn">Create invite link</button>
      </section>
      <section class="card wide">
        <h2>Your ongoing games</h2>
        <ul class="games" id="playing"><li class="muted">Loading…</li></ul>
      </section>
    </div>`),
  );
  const $ = (sel) => app.querySelector(sel);

  $('#seek-btn').onclick = async () => {
    if (seekAbort) return seekAbort.abort();
    const [time, increment] = $('#seek-tc').value.split('+');
    const btn = $('#seek-btn');
    const status = $('#seek-status');
    const abort = (seekAbort = new AbortController());
    expectingGame = true;
    btn.textContent = 'Cancel';
    status.textContent = 'Looking for an opponent…';
    try {
      // The seek stays open only while this request is open.
      await stream('/api/board/seek', () => {}, {
        method: 'POST',
        body: new URLSearchParams({ time, increment, rated: $('#seek-rated').checked }),
        signal: abort.signal,
      });
      status.textContent = 'Starting game…';
      setTimeout(() => {
        if (expectingGame && !seekAbort) {
          expectingGame = false;
          status.textContent = 'No opponent found. Try again.';
        }
      }, 8000);
    } catch (e) {
      expectingGame = false;
      status.textContent = e.name === 'AbortError' ? '' : e.message;
    } finally {
      if (seekAbort === abort) seekAbort = null;
      btn.textContent = 'Find opponent';
    }
  };

  $('#inv-btn').onclick = () => {
    const [minutes, increment] = $('#inv-tc').value.split('+').map(Number);
    socket.emit('invite:create', { minutes, increment, color: $('#inv-color').value }, (res) => {
      if (res.error) flash(res.error);
      else location.hash = `#/invite/${res.id}`;
    });
  };

  api('/api/account/playing')
    .then(({ nowPlaying }) => {
      const list = $('#playing');
      if (!list) return;
      if (!nowPlaying.length) {
        list.replaceChildren(html('<li class="muted">No ongoing games.</li>'));
        return;
      }
      list.replaceChildren(
        ...nowPlaying.map((g) => {
          const li = document.createElement('li');
          li.innerHTML = `<a href="#/game/${esc(g.gameId)}">vs ${esc(g.opponent?.username ?? 'Anonymous')}</a>
            <span class="muted">${esc(g.speed)}</span>${g.isMyTurn ? '<span class="badge">Your turn</span>' : ''}`;
          return li;
        }),
      );
    })
    .catch(() => $('#playing')?.replaceChildren(html('<li class="muted">Couldn\'t load games.</li>')));
}

// ---------- Invites ----------

async function showInvite(id, myRoute) {
  app.replaceChildren(html('<section class="card narrow"><p class="muted">Loading invite…</p></section>'));
  const res = await fetch(`/api/invite/${encodeURIComponent(id)}`);
  if (myRoute !== routeId) return;
  if (!res.ok) {
    app.replaceChildren(
      html(`<section class="card narrow"><h2>Invite not found</h2>
        <p>This invite link has expired or was already used.</p><a class="button primary" href="#/">Go to lobby</a></section>`),
    );
    return;
  }
  const invite = await res.json();
  const tc = `${invite.minutes}+${invite.increment} ${speedOf(invite.minutes, invite.increment)}`;

  if (!me) {
    app.replaceChildren(
      html(`<section class="card narrow"><h2>${esc(invite.hostName)} invited you to play</h2>
        <p>${esc(tc)} game, with voice chat. Log in with your Lichess account to accept.</p><div id="login-slot"></div></section>`),
    );
    app.querySelector('#login-slot').append(loginPrompt());
    return;
  }
  if (invite.hostId === me.id) return showInviteHost(id, invite, tc);
  showInviteGuest(id, invite, tc);
}

function showInviteHost(id, invite, tc) {
  const link = `${location.origin}/#/invite/${id}`;
  app.replaceChildren(
    html(`<section class="card narrow">
      <h2>Invite a friend</h2>
      <p>Send this link to your friend. The game starts as soon as they open it and accept.</p>
      <div class="copy"><input readonly id="link" value="${esc(link)}"><button class="primary" id="copy">Copy</button></div>
      <p class="muted">${esc(tc)} · you play ${esc(invite.color)}</p>
      <p id="inv-status" aria-live="polite">Waiting for your friend… Keep this page open.</p>
      <a href="#/">Cancel</a>
    </section>`),
  );
  const $ = (sel) => app.querySelector(sel);
  $('#copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(link);
      $('#copy').textContent = 'Copied!';
    } catch {
      $('#link').select();
    }
  };

  const watch = () => socket.emit('invite:watch', id);
  const onGuest = async ({ guest }) => {
    $('#inv-status').textContent = `${guest} joined. Creating the game…`;
    try {
      const challenge = await api(`/api/challenge/${encodeURIComponent(guest)}`, {
        method: 'POST',
        body: new URLSearchParams({
          'clock.limit': invite.minutes * 60,
          'clock.increment': invite.increment,
          color: invite.color,
          rated: 'false',
        }),
      });
      socket.emit('invite:challenge', { inviteId: id, challengeId: challenge.id ?? challenge.challenge?.id });
    } catch (e) {
      $('#inv-status').textContent = `Couldn't challenge ${guest}: ${e.message}`;
      socket.emit('invite:failed', { inviteId: id, error: e.message });
    }
  };
  const onStarted = ({ gameId }) => (location.hash = `#/game/${gameId}`);

  watch();
  socket.on('connect', watch);
  socket.on('invite:guest', onGuest);
  socket.on('invite:started', onStarted);
  cleanup = () => {
    socket.off('connect', watch);
    socket.off('invite:guest', onGuest);
    socket.off('invite:started', onStarted);
  };
}

function showInviteGuest(id, invite, tc) {
  const yourColor = invite.color === 'white' ? 'black' : invite.color === 'black' ? 'white' : 'a random color';
  app.replaceChildren(
    html(`<section class="card narrow">
      <h2>${esc(invite.hostName)} invited you to play</h2>
      <p>${esc(tc)} · you play ${esc(yourColor)} · voice chat available</p>
      <button class="primary big" id="accept">Accept and play</button>
      <p id="inv-status" aria-live="polite"></p>
    </section>`),
  );
  const $ = (sel) => app.querySelector(sel);

  const onChallenge = async ({ challengeId }) => {
    try {
      await api(`/api/challenge/${encodeURIComponent(challengeId)}/accept`, { method: 'POST' });
      socket.emit('invite:accepted', { inviteId: id, gameId: challengeId });
      location.hash = `#/game/${challengeId}`;
    } catch (e) {
      $('#inv-status').textContent = `Couldn't accept the challenge: ${e.message}`;
      $('#accept').disabled = false;
    }
  };
  const onFailed = ({ error }) => {
    $('#inv-status').textContent = `${invite.hostName} couldn't create the game: ${error}`;
    $('#accept').disabled = false;
  };

  $('#accept').onclick = () => {
    $('#accept').disabled = true;
    $('#inv-status').textContent = `Waiting for ${invite.hostName}…`;
    socket.emit('invite:join', id, (res) => {
      if (res.error) {
        $('#inv-status').textContent = res.error;
        $('#accept').disabled = false;
      }
    });
  };
  socket.on('invite:challenge', onChallenge);
  socket.on('invite:failed', onFailed);
  cleanup = () => {
    socket.off('invite:challenge', onChallenge);
    socket.off('invite:failed', onFailed);
  };
}

// ---------- Game ----------

function showGame(gameId) {
  cleanup = mountGame(app, { gameId, me, socket, iceServers });
}

init();
