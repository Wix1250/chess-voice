// Lichess login (OAuth2 + PKCE, no client registration needed) and API helpers.

export const LICHESS = 'https://lichess.org';
const CLIENT_ID = 'chess-voice';
const SCOPES = 'board:play challenge:read challenge:write';
const TOKEN_KEY = 'lichessToken';

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

const redirectUri = () => `${location.origin}/`;

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

export async function login() {
  const verifier = randomString();
  const state = randomString();
  sessionStorage.setItem('pkce', JSON.stringify({ verifier, state, returnTo: location.hash }));
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: base64url(await sha256(verifier)),
    state,
  });
  location.href = `${LICHESS}/oauth?${params}`;
}

// Finishes login when Lichess redirects back with ?code=...
export async function handleRedirect() {
  const params = new URLSearchParams(location.search);
  if (!params.has('code') && !params.has('error')) return;
  const saved = JSON.parse(sessionStorage.getItem('pkce') || 'null');
  sessionStorage.removeItem('pkce');
  history.replaceState(null, '', `/${saved?.returnTo || ''}`);

  if (params.has('error')) throw new Error('Lichess login was cancelled.');
  if (!saved || params.get('state') !== saved.state) throw new Error('Login failed, please try again.');

  const res = await fetch(`${LICHESS}/api/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.get('code'),
      code_verifier: saved.verifier,
      redirect_uri: redirectUri(),
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) throw new Error('Login failed, please try again.');
  setToken((await res.json()).access_token);
}

export async function logout() {
  const token = getToken();
  setToken(null);
  if (token) await fetch(`${LICHESS}/api/token`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
}

export function clearToken() {
  setToken(null);
}

async function request(path, opts = {}) {
  const res = await fetch(LICHESS + path, {
    ...opts,
    headers: { Authorization: `Bearer ${getToken()}`, ...opts.headers },
  });
  if (!res.ok) {
    let message = `Lichess error ${res.status}`;
    try {
      const body = await res.json();
      message = body.error || body.message || message;
      if (typeof message !== 'string') message = JSON.stringify(message);
    } catch {}
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return res;
}

export async function api(path, opts) {
  const res = await request(path, opts);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Reads a newline-delimited JSON stream, calling onLine for each object.
// Resolves when Lichess closes the stream; rejects with AbortError if opts.signal aborts.
export async function stream(path, onLine, opts) {
  const res = await request(path, opts);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) if (line.trim()) onLine(JSON.parse(line));
  }
}
