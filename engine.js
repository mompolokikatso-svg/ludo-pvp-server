// ==================================================================
// COPIED FILE — do not edit here.
// This is a byte-for-byte copy of ../www/engine.js.
// To change Ludo rules, edit www/engine.js then run:
//   cp www/engine.js server/engine.js
// ==================================================================
// ludo-pvp/www/engine.js
// Pure Ludo rules engine. No DOM. Usable by client AND future server.

export const PLAYERS = ['red', 'yellow']; // 2-player default
export const COLORS = ['red', 'green', 'yellow', 'blue'];

// 15x15 board. Each cell is null or {color, type} where type is:
// 'track' | 'start' | 'safe' | 'home-run' | 'yard' | 'center'
// We build this once at module load.

// Main track: 52 cells, indexed 0..51, going clockwise.
// Each player's entry index on the main track (where a token lands when leaving yard on a 6):
export const START_INDEX = {
  red:    0,
  green:  13,
  yellow: 26,
  blue:   39,
};

// Home-run squares are color-specific, 5 cells each, leading to center.
// We represent token position as:
//   { zone: 'yard' }
//   { zone: 'track', pos: 0..55 }  // pos = absolute step count from player's start
//       pos 0..50  -> main track  (START_INDEX[color] + pos) % 52
//       pos 51..55 -> home run (5 cells), exact roll required to land on 55 then center
//   { zone: 'home' }  // finished (center)
//
// Actually for clarity we use:
//   yard | track(step 0..50) | home-run(step 51..55) | home
// Token is finished when it reaches step 56 (the center).

export const TRACK_LEN = 52;
export const HOME_RUN_LEN = 5;
export const STEPS_TO_FINISH = TRACK_LEN - 1 + HOME_RUN_LEN; // 51 + 5 = 56
// Wait: step 0 is the player's start square. Step 50 is the last main-track square
// before entering the home run. Step 51..55 are the 5 home-run squares. Step 56 = center.
// So total steps from start to center = 51 + 5 = 56. TOKEN_PATH_LEN = 56.

export const TOKEN_PATH_LEN = 56; // step 0..55, step 56 = finished

// Safe squares on the main track (absolute indices 0..51).
// Standard Ludo: each color's start square and the star just before it are safe.
// We use the common convention: start squares at START_INDEX values are safe,
// plus the "star" squares 8 steps ahead of each start (which are also safe).
function safeSquares() {
  const s = new Set();
  for (const c of COLORS) {
    s.add(START_INDEX[c]);                         // start
    s.add((START_INDEX[c] + 8) % TRACK_LEN);       // star
  }
  return s;
}
export const SAFE = safeSquares();

// ---- Game state ----

export function newGame(players = PLAYERS) {
  if (players.length !== 2) throw new Error('Only 2-player supported for now');
  const tokens = {};
  for (const p of players) {
    tokens[p] = [0, 1, 2, 3].map(i => ({ id: `${p}-${i}`, color: p, zone: 'yard', step: null }));
  }
  return {
    players,
    current: players[0],
    tokens,
    dice: null,
    sixStreak: 0,
    winner: null,
    log: [],
  };
}

// Convert a token's absolute step to a main-track absolute index, or null if not on main track.
function absTrackIndex(token) {
  if (token.zone !== 'track') return null;
  return (START_INDEX[token.color] + token.step) % TRACK_LEN;
}

// Are all 4 tokens of a color finished?
function allHome(state, color) {
  return state.tokens[color].every(t => t.zone === 'home');
}

// Count of finished tokens per color (for UI).
export function homeCount(state, color) {
  return state.tokens[color].filter(t => t.zone === 'home').length;
}

// ---- Dice ----
// For now the CLIENT rolls and passes the value; later the SERVER will roll.
// We validate the value here so a manipulator cannot pass 7.
export function rollDice(value) {
  if (!Number.isInteger(value) || value < 1 || value > 6) throw new Error('bad dice');
  return value;
}

// ---- Move validation ----
// A move is legal if:
//  - it's the current player's turn
//  - no winner yet
//  - dice is set and belongs to current player's pending roll
//  - the token belongs to current player
//  - the resulting step is <= TOKEN_PATH_LEN (i.e. exactly reachable)
//      - from yard: only if dice === 6, resulting step = 0
//      - from track/home-run: step + dice <= 56 (56 = finished)
// We do NOT require the landing square be free (stacking allowed; blocking not enforced
// in this first version, but we capture opponents on non-safe squares).
export function legalMoves(state, color, dice) {
  if (state.winner) return [];
  if (color !== state.current) return [];
  if (!dice) return [];
  const moves = [];
  for (const t of state.tokens[color]) {
    if (t.zone === 'home') continue;
    if (t.zone === 'yard') {
      if (dice === 6) moves.push(t.id);
      continue;
    }
    const next = t.step + dice;
    if (next <= TOKEN_PATH_LEN) moves.push(t.id);
  }
  return moves;
}

// Apply a move. Mutates state. Returns an event object for UI/log.
export function applyMove(state, tokenId, dice) {
  if (state.winner) throw new Error('game over');
  const color = state.current;
  if (!legalMoves(state, color, dice).includes(tokenId)) {
    throw new Error('illegal move');
  }
  const token = state.tokens[color].find(t => t.id === tokenId);
  let captured = null;

  if (token.zone === 'yard') {
    token.zone = 'track';
    token.step = 0;
  } else {
    token.step += dice;
    if (token.step >= TOKEN_PATH_LEN) {
      token.step = TOKEN_PATH_LEN;
      token.zone = 'home';
    } else if (token.step > TRACK_LEN - 1) {
      token.zone = 'home-run';
    } else {
      token.zone = 'track';
    }
  }

  // Capture check (only on main track, non-safe squares)
  if (token.zone === 'track') {
    const myAbs = absTrackIndex(token);
    if (!SAFE.has(myAbs)) {
      for (const p of state.players) {
        if (p === color) continue;
        for (const other of state.tokens[p]) {
          if (other.zone === 'track' && absTrackIndex(other) === myAbs) {
            other.zone = 'yard';
            other.step = null;
            captured = other.id;
          }
        }
      }
    }
  }

  // Win check
  if (allHome(state, color)) state.winner = color;

  // Extra turn on 6 (and on capture, common rule) — we do 6 only for clarity.
  const extra = dice === 6 && !state.winner;
  if (extra) {
    state.sixStreak += 1;
    if (state.sixStreak >= 3) {
      // three 6s in a row => forfeit turn
      state.sixStreak = 0;
      nextTurn(state);
    }
  } else {
    state.sixStreak = 0;
    if (!state.winner) nextTurn(state);
  }

  state.dice = null;

  const ev = { tokenId, color, dice, captured, winner: state.winner, extraTurn: extra };
  state.log.push(ev);
  return ev;
}

export function nextTurn(state) {
  const i = state.players.indexOf(state.current);
  state.current = state.players[(i + 1) % state.players.length];
}

// Called by UI when the dice was rolled and there are no legal moves.
export function passTurn(state, dice) {
  if (legalMoves(state, state.current, dice).length > 0) {
    throw new Error('moves available; cannot pass');
  }
  // A 6 with no moves: give extra turn? Standard rule: still count toward 3-six penalty.
  if (dice === 6) {
    state.sixStreak += 1;
    if (state.sixStreak >= 3) { state.sixStreak = 0; nextTurn(state); }
  } else {
    state.sixStreak = 0;
    nextTurn(state);
  }
  state.dice = null;
  state.log.push({ pass: true, color: state.players[(state.players.indexOf(state.current) + 1) % 2], dice });
}
