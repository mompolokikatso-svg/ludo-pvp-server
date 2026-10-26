// ludo-pvp/server/index.js — Phase 3.1c: HTTP + WebSocket server
// HTTP routes: POST /register
// WebSocket: existing Ludo game protocol (newGame, joinGame, rollDice, move)
// Single-process; both HTTP and WS share the same port? No — HTTP is on
// 3002 for now, WebSocket stays on 3001, to keep concerns separate.

import http from 'http';
import { WebSocketServer } from 'ws';
import bcrypt from 'bcryptjs';
import { supabase } from './supabase.js';
import * as E from './engine.js';
import { verifyJwt, sha256Hex, newSessionToken } from './auth.js';
import { JWT_SECRET } from './supabase.js';

// ---------- HTTP server (register / login later) ----------

const HTTP_PORT = Number(process.env.PORT || 3002);
const HTTP_HOST = '0.0.0.0';

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 10_000) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function handleRegister(req, res) {
  let body;
  try { body = await readJson(req); }
  catch (e) { return sendJson(res, 400, { error: 'bad_body', message: e.message }); }

  const username = String(body.username || '').trim().toLowerCase();
  const email    = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  if (!/^[a-z0-9_]{3,20}$/.test(username))
    return sendJson(res, 400, { error: 'bad_username',
      message: 'username must be 3-20 chars, a-z 0-9 _' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return sendJson(res, 400, { error: 'bad_email' });
  if (password.length < 8 || password.length > 72)
    return sendJson(res, 400, { error: 'bad_password',
      message: 'password must be 8-72 characters' });

  let hash;
  try { hash = await bcrypt.hash(password, 10); }
  catch (e) { return sendJson(res, 500, { error: 'hash_failed' }); }

  const { data, error } = await supabase
    .from('users')
    .insert({ username, email, password_hash: hash })
    .select('id, username, email, created_at')
    .single();

  if (error) {
    // Postgres unique_violation
    if (error.code === '23505') {
      const m = /duplicate key value violates unique constraint "([^"]+)"/.exec(error.message) || [];
      const which = m[1] || '';
      if (which.includes('username')) return sendJson(res, 409, { error: 'username_taken' });
      if (which.includes('email'))    return sendJson(res, 409, { error: 'email_taken' });
      return sendJson(res, 409, { error: 'duplicate', detail: which });
    }
    return sendJson(res, 500, { error: 'db_error', message: error.message });
  }

  return sendJson(res, 201, { ok: true, user: data });
}

async function handleLogin(req, res) {
  let body;
  try { body = await readJson(req); }
  catch (e) { return sendJson(res, 400, { error: 'bad_body', message: e.message }); }

  const idf = String(body.username_or_email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!idf || !password) return sendJson(res, 400, { error: 'missing_fields' });

  // Look up by username OR email. Username is lowercase in the DB; email too.
  // We try both via two queries to use the unique indexes.
  let user = null, lookupErr = null;
  {
    const { data, error } = await supabase
      .from('users')
      .select('id, username, email, password_hash')
      .eq('username', idf)
      .maybeSingle();
    if (error) lookupErr = error;
    else if (data) user = data;
  }
  if (!user) {
    const { data, error } = await supabase
      .from('users')
      .select('id, username, email, password_hash')
      .eq('email', idf)
      .maybeSingle();
    if (error) lookupErr = lookupErr || error;
    else if (data) user = data;
  }
  if (lookupErr) return sendJson(res, 500, { error: 'db_error' });
  if (!user) return sendJson(res, 401, { error: 'invalid_credentials' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return sendJson(res, 401, { error: 'invalid_credentials' });

  const token = newSessionToken(JWT_SECRET);
  const tokenHash = sha256Hex(token);
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

  const { error: insErr } = await supabase.from('sessions').insert({
    user_id: user.id,
    token_hash: tokenHash,
    expires_at: expiresAt,
  });
  if (insErr) return sendJson(res, 500, { error: 'session_insert_failed' });

  // Update last_login_at (non-fatal if it fails).
  await supabase.from('users').update({ last_login_at: new Date().toISOString() }).eq('id', user.id);

  return sendJson(res, 200, {
    ok: true,
    token,
    expires_at: expiresAt,
    user: { id: user.id, username: user.username, email: user.email },
  });
}

async function handleMe(req, res) {
  const auth = String(req.headers['authorization'] || '');
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return sendJson(res, 401, { error: 'missing_token' });
  const token = m[1];
  const claims = verifyJwt(token, JWT_SECRET);
  if (!claims) return sendJson(res, 401, { error: 'bad_token' });
  const tokenHash = sha256Hex(token);

  const { data: sess, error: sErr } = await supabase
    .from('sessions')
    .select('id, user_id, expires_at, revoked_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (sErr) return sendJson(res, 500, { error: 'db_error' });
  if (!sess || sess.revoked_at) return sendJson(res, 401, { error: 'session_invalid' });
  if (new Date(sess.expires_at).getTime() < Date.now()) return sendJson(res, 401, { error: 'session_expired' });

  const { data: user, error: uErr } = await supabase
    .from('users')
    .select('id, username, email, created_at, last_login_at')
    .eq('id', sess.user_id)
    .maybeSingle();
  if (uErr || !user) return sendJson(res, 401, { error: 'user_not_found' });

  return sendJson(res, 200, { ok: true, user });
}

const httpServer = http.createServer(async (req, res) => {
  // Basic CORS for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'POST' && req.url === '/login') {
    try { return await handleLogin(req, res); }
    catch (e) { console.error('[http] /login error', e); return sendJson(res, 500, { error: 'server_error' }); }
  }
  if (req.method === 'GET' && req.url === '/me') {
    try { return await handleMe(req, res); }
    catch (e) { console.error('[http] /me error', e); return sendJson(res, 500, { error: 'server_error' }); }
  }
  if (req.method === 'POST' && req.url === '/register') {
    try { return await handleRegister(req, res); }
    catch (e) { console.error('[http] /register error', e); return sendJson(res, 500, { error: 'server_error' }); }
  }
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'GET' && req.url === '/ping') {
    return sendJson(res, 200, { ok: true, at: new Date().toISOString() });
  }
  return sendJson(res, 404, { error: 'not_found' });
});

httpServer.listen(HTTP_PORT, HTTP_HOST, () => {
  console.log(`[http] listening on http://${HTTP_HOST}:${HTTP_PORT}`);
});

// ---------- WebSocket server (unchanged from Stage 2) ----------

const wss = new WebSocketServer({ server: httpServer });

let nextClientId = 1;
let nextGameId = 1;
const clients = new Map();
const games = new Map();
const clientToGame = new Map();

function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
function sendError(ws, error, extra = {}) { send(ws, { type: 'error', error, ...extra }); }
function serverDie() {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return 1 + (buf[0] % 6);
}

wss.on('listening', () => console.log('[server] ws attached to http server'));

wss.on('connection', (ws, req) => {
  const clientId = nextClientId++;
  clients.set(clientId, ws);
  ws.__auth = null; // { userId, username, email } once authenticated
  console.log(`[connect] #${clientId} from ${req.socket.remoteAddress} (total: ${clients.size})`);
  send(ws, { type: 'welcome', id: clientId });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return sendError(ws, 'bad_json'); }
    handleWsMessage(clientId, ws, msg).catch(err => console.error('[ws] handler error', err));
  });

  ws.on('close', () => {
    clients.delete(clientId);
    const gameId = clientToGame.get(clientId);
    if (gameId) {
      const g = games.get(gameId);
      if (g) {
        g.players = g.players.filter(p => p !== clientId);
        if (g.players.length === 0) { games.delete(gameId); console.log(`[game ${gameId}] deleted (no players)`); }
      }
      clientToGame.delete(clientId);
    }
    console.log(`[disconnect] #${clientId} (remaining: ${clients.size})`);
  });
  ws.on('error', (err) => console.log(`[error] #${clientId}:`, err.message));
});

async function handleWsMessage(clientId, ws, msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return sendError(ws, 'bad_message');
  switch (msg.type) {
    case 'echo':     return send(ws, { type: 'echo', from: clientId, payload: msg });
    case 'auth':     return onAuth(clientId, ws, msg);
    case 'newGame':  return onNewGame(clientId, ws);
    case 'joinGame': return onJoinGame(clientId, ws, msg);
    case 'rollDice': return onRollDice(clientId, ws);
    case 'move':     return onMove(clientId, ws, msg);
    case 'getState': return onGetState(clientId, ws);
    default:         return sendError(ws, 'unknown_type', { got: msg.type });
  }
}

async function onAuth(clientId, ws, msg) {
  const token = typeof msg.token === 'string' ? msg.token : '';
  if (!token) return sendError(ws, 'auth_missing_token');
  const claims = verifyJwt(token, JWT_SECRET);
  if (!claims) return sendError(ws, 'auth_bad_token');
  const tokenHash = sha256Hex(token);

  const { data: sess, error: sErr } = await supabase
    .from('sessions')
    .select('id, user_id, expires_at, revoked_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (sErr) return sendError(ws, 'auth_db_error');
  if (!sess || sess.revoked_at) return sendError(ws, 'auth_session_invalid');
  if (new Date(sess.expires_at).getTime() < Date.now()) return sendError(ws, 'auth_session_expired');

  const { data: user, error: uErr } = await supabase
    .from('users')
    .select('id, username, email')
    .eq('id', sess.user_id)
    .maybeSingle();
  if (uErr || !user) return sendError(ws, 'auth_user_missing');

  ws.__auth = { userId: user.id, username: user.username, email: user.email };
  console.log(`[auth] #${clientId} = ${user.username} (${user.id})`);
  send(ws, { type: 'authed', user: { id: user.id, username: user.username, email: user.email } });
}

function requireAuth(ws, what) {
  if (!ws.__auth) {
    sendError(ws, 'unauthorized', { action: what });
    return false;
  }
  return true;
}

function onNewGame(clientId, ws) {
  if (!requireAuth(ws, 'newGame')) return;
  if (clientToGame.has(clientId)) return sendError(ws, 'already_in_game', { gameId: clientToGame.get(clientId) });
  const gameId = nextGameId++;
  const state = E.newGame(['red', 'yellow']);
  games.set(gameId, { state, lastDice: null, players: [clientId], users: [ws.__auth.userId, null] });
  clientToGame.set(clientId, gameId);
  console.log(`[game ${gameId}] created by #${clientId}`);
  send(ws, { type: 'gameCreated', gameId, yourColor: 'red', state: publicState(state) });
}
async function onJoinGame(clientId, ws, msg) {
  if (!requireAuth(ws, 'joinGame')) return;
  if (clientToGame.has(clientId)) return sendError(ws, 'already_in_game', { gameId: clientToGame.get(clientId) });
  const gameId = msg && msg.gameId;
  if (!Number.isInteger(gameId)) return sendError(ws, 'bad_gameId');
  const g = games.get(gameId);
  if (!g) return sendError(ws, 'game_not_found', { gameId });
  if (g.players.length >= 2) return sendError(ws, 'game_full', { gameId });
  g.players.push(clientId);
  if (!g.users) g.users = [null, null];
  g.users[1] = ws.__auth.userId;
  clientToGame.set(clientId, gameId);
  const myColor = g.players[0] === clientId ? 'red' : 'yellow';
  console.log(`[game ${gameId}] #${clientId} joined as ${myColor} (players: ${g.players.length})`);
  // Record the match now that both players are present.
  if (!g.matchId && g.users && g.users[0] && g.users[1]) {
    try {
      const { data, error } = await supabase.from('matches').insert({
        game: 'ludo',
        red_user_id: g.users[0],
        yellow_user_id: g.users[1],
      }).select('id').single();
      if (error) {
        console.warn('[db] match insert failed:', error.message);
      } else {
        g.matchId = data.id;
        g.moveSeq = 0;
        console.log(`[game ${gameId}] match row created ${g.matchId}`);
      }
    } catch (e) {
      console.warn('[db] match insert threw:', e.message);
    }
  }
  send(ws, { type: 'joined', gameId, yourColor: myColor, state: publicState(g.state) });
  broadcast(gameId, { type: 'opponentJoined', gameId, state: publicState(g.state) });
}
function onGetState(clientId, ws) {
  const gameId = clientToGame.get(clientId);
  if (!gameId) return sendError(ws, 'not_in_game');
  const g = games.get(gameId);
  if (!g) return sendError(ws, 'game_gone');
  send(ws, { type: 'state', gameId, state: publicState(g.state) });
}
function onRollDice(clientId, ws) {
  const gameId = clientToGame.get(clientId);
  if (!gameId) return sendError(ws, 'not_in_game');
  const g = games.get(gameId);
  if (!g) return sendError(ws, 'game_gone');
  if (g.state.winner) return sendError(ws, 'game_over');
  const myColor = g.players[0] === clientId ? 'red' : 'yellow';
  if (g.state.current !== myColor) return sendError(ws, 'not_your_turn', { current: g.state.current });
  if (g.lastDice) return sendError(ws, 'dice_already_rolled', { pendingDice: g.lastDice });
  const value = serverDie();
  g.lastDice = value;
  const moves = E.legalMoves(g.state, myColor, value);
  console.log(`[game ${gameId}] #${clientId} rolled ${value}; legal=${moves.length}`);
  if (moves.length === 0) {
    E.passTurn(g.state, value);
    g.lastDice = null;
    return broadcast(gameId, { type: 'update', dice: value, moves: [], autoPassed: true, state: publicState(g.state) });
  }
  broadcast(gameId, { type: 'update', dice: value, moves, state: publicState(g.state) });
}
async function onMove(clientId, ws, msg) {
  const gameId = clientToGame.get(clientId);
  if (!gameId) return sendError(ws, 'not_in_game');
  const g = games.get(gameId);
  if (!g) return sendError(ws, 'game_gone');
  if (g.state.winner) return sendError(ws, 'game_over');
  if (!g.lastDice) return sendError(ws, 'no_dice_rolled');
  const myColor = g.players[0] === clientId ? 'red' : 'yellow';
  if (g.state.current !== myColor) return sendError(ws, 'not_your_turn', { current: g.state.current });
  const tokenId = msg.tokenId;
  if (typeof tokenId !== 'string') return sendError(ws, 'bad_tokenId');
  const legal = E.legalMoves(g.state, myColor, g.lastDice);
  if (!legal.includes(tokenId)) return sendError(ws, 'illegal_move', { tokenId, legal });
  try {
    const ev = E.applyMove(g.state, tokenId, g.lastDice);
    g.lastDice = null;
    console.log(`[game ${gameId}] #${clientId} moved ${tokenId}, dice=${ev.dice}, captured=${ev.captured}`);

    // Persist the move (best-effort — gameplay is not blocked by DB failures).
    if (g.matchId) {
      try {
        const seq = g.moveSeq ?? 0;
        g.moveSeq = seq + 1;
        const { error: mErr } = await supabase.from('moves').insert({
          match_id: g.matchId,
          seq,
          color: ev.color,
          dice: ev.dice,
          token_id: ev.tokenId,
          captured: ev.captured || null,
          state_after: publicState(g.state),
        });
        if (mErr) console.warn('[db] move insert failed:', mErr.message);
      } catch (e) {
        console.warn('[db] move insert threw:', e.message);
      }
    }

    // Finalize the match row if a winner just appeared.
    if (ev.winner && g.matchId && !g.matchFinalized) {
      g.matchFinalized = true;
      try {
        const { error: finErr } = await supabase.from('matches').update({
          winner: ev.winner,
          finished_at: new Date().toISOString(),
        }).eq('id', g.matchId);
        if (finErr) console.warn('[db] match finalize failed:', finErr.message);
        else console.log(`[game ${gameId}] match finalized — winner=${ev.winner}`);
      } catch (e) {
        console.warn('[db] match finalize threw:', e.message);
      }
    }
    broadcast(gameId, { type: 'update', moved: tokenId, event: ev, state: publicState(g.state) });
  } catch (err) {
    sendError(ws, 'engine_error', { message: err.message });
  }
}
function publicState(state) {
  return { players: state.players, current: state.current, winner: state.winner, tokens: state.tokens };
}
function broadcast(gameId, obj) {
  const g = games.get(gameId);
  if (!g) return;
  const payload = JSON.stringify(obj);
  for (const pid of g.players) {
    const ws = clients.get(pid);
    if (ws && ws.readyState === 1) { try { ws.send(payload); } catch {} }
  }
}

globalThis.__loginWired = true;

globalThis.__wsAuthWired = true;

globalThis.__recordMatchesWired = true;

globalThis.__renderPrep = true;

process.on('SIGINT', () => {
  console.log('[server] shutting down');
  httpServer.close();
  wss.close(() => process.exit(0));
});
