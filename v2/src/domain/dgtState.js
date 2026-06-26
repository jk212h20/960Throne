const chess960 = require('./chess960');

let io;
const state = {
  connected: false,
  lastSeenAt: null,
  fen: null,
  board: null,
  clock: null,
  expectedPosition: null,
  setupOk: false,
  setupMessage: 'No board data yet',
  expectedFen: null,
  setupDiff: [],
};

function init(socketIo) { io = socketIo; }
function emit() { if (io) io.emit('dgt_state', snapshot()); }
function normalizeFen(fen) { return String(fen || '').split(' ')[0]; }
function setExpectedPosition(pos) { state.expectedPosition = pos == null ? null : parseInt(pos, 10); verify(); emit(); }
function clearExpectedPosition() { state.expectedPosition = null; state.setupOk = false; state.setupMessage = 'No expected position'; emit(); }
function update({ fen, board, clock, source = 'relay' }) {
  state.connected = true;
  state.lastSeenAt = new Date().toISOString();
  if (fen) state.fen = normalizeFen(fen);
  if (board) state.board = board;
  if (clock) state.clock = normalizeClock(clock);
  state.source = source;
  verify(); emit(); return snapshot();
}
function normalizeClock(clock) {
  if (!clock) return null;
  return {
    white: Number(clock.white ?? 0),
    black: Number(clock.black ?? 0),
    running: Boolean(clock.running ?? clock.run ?? false),
    activeSide: clock.activeSide || clock.turn || null,
    raw: clock,
  };
}
function parsePlacement(placement) {
  const rows = String(placement || '').split('/');
  const out = [];
  for (const row of rows) {
    for (const ch of row) {
      if (/^[1-8]$/.test(ch)) for (let i = 0; i < parseInt(ch, 10); i++) out.push(null);
      else out.push(ch);
    }
  }
  return out.length === 64 ? out : [];
}
function pieceName(ch) {
  if (!ch) return 'empty';
  const color = ch === ch.toUpperCase() ? 'White' : 'Black';
  const names = { p: 'pawn', r: 'rook', n: 'knight', b: 'bishop', q: 'queen', k: 'king' };
  return `${color} ${names[ch.toLowerCase()] || ch}`;
}
function setupDiff(actualFen, expectedFen) {
  const actual = parsePlacement(actualFen);
  const expected = parsePlacement(expectedFen);
  if (actual.length !== 64 || expected.length !== 64) return [];
  const files = 'abcdefgh';
  const diff = [];
  for (let i = 0; i < 64; i++) {
    if (actual[i] !== expected[i]) diff.push({ square: `${files[i % 8]}${8 - Math.floor(i / 8)}`, expected: expected[i], actual: actual[i], message: `${files[i % 8]}${8 - Math.floor(i / 8)}: expected ${pieceName(expected[i])}, found ${pieceName(actual[i])}` });
  }
  return diff;
}
function verify() {
  state.expectedFen = state.expectedPosition == null ? null : chess960.positionToStartingFen(state.expectedPosition);
  state.setupDiff = [];
  if (state.expectedPosition == null) { state.setupOk = false; state.setupMessage = 'Waiting for game'; return; }
  if (!state.fen) { state.setupOk = false; state.setupMessage = `Set board to position #${state.expectedPosition}`; return; }
  state.setupDiff = setupDiff(normalizeFen(state.fen), state.expectedFen);
  state.setupOk = state.setupDiff.length === 0;
  state.setupMessage = state.setupOk ? `Position #${state.expectedPosition} locked` : `Set board to #${state.expectedPosition}: ${state.setupDiff.length} square${state.setupDiff.length === 1 ? '' : 's'} differ`;
}
function snapshot() {
  const ageMs = state.lastSeenAt ? Date.now() - new Date(state.lastSeenAt).getTime() : null;
  return { ...state, ageMs, stale: ageMs == null || ageMs > 5000 };
}
module.exports = { init, update, setExpectedPosition, clearExpectedPosition, snapshot };
