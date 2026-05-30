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
function verify() {
  if (state.expectedPosition == null) { state.setupOk = false; state.setupMessage = 'Waiting for game'; return; }
  if (!state.fen) { state.setupOk = false; state.setupMessage = `Set board to position #${state.expectedPosition}`; return; }
  const expected = chess960.positionToStartingFen(state.expectedPosition);
  state.setupOk = normalizeFen(state.fen) === expected;
  state.setupMessage = state.setupOk ? `Position #${state.expectedPosition} locked` : `Set board to #${state.expectedPosition}`;
}
function snapshot() {
  const ageMs = state.lastSeenAt ? Date.now() - new Date(state.lastSeenAt).getTime() : null;
  return { ...state, ageMs, stale: ageMs == null || ageMs > 5000 };
}
module.exports = { init, update, setExpectedPosition, clearExpectedPosition, snapshot };
