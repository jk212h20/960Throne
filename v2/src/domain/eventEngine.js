const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const chess960 = require('./chess960');
const dgt = require('./dgtState');
const { config } = require('../config/env');

let io;
let gameStartedAt = null;
let satTimer = null;

function init(socketIo) {
  io = socketIo;
  const game = db.activeGame();
  if (game) gameStartedAt = new Date(game.started_at).getTime();
  ensureVenueCode();
  startSatAccumulator();
  console.log('♛ v2 event engine ready');
}
function broadcast(type, payload = {}) { if (io) io.emit(type, payload); if (io) io.emit('state', getState()); }
function generateVenueCode() { const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
function ensureVenueCode() { if (!db.activeVenueCode()) db.createVenueCode(generateVenueCode()); }
function rotateVenueCode() { const code = generateVenueCode(); db.createVenueCode(code); broadcast('venue_code_updated', { code }); return code; }

function registerPlayer(name) { const token = uuidv4(); const id = db.createPlayer({ name: String(name || '').trim(), sessionToken: token }); return { player: db.getPlayer(id), token }; }
function joinQueue(playerId) {
  if (db.getConfig('event_locked') === '1') return { error: 'Event is locked' };
  const kingId = parseInt(db.getConfig('current_king_id') || '0', 10);
  if (kingId === playerId) return { error: "You're the King" };
  if (db.isPlayerInQueue(playerId)) return { error: 'Already in queue' };
  const queueId = db.addToQueue(playerId);
  broadcast('queue_updated', { queue: db.getQueue() });
  if (!kingId) {
    const first = db.getNextInQueue();
    if (first) { db.removeQueueId(first.id); crownKing(first.player_id); return { success: true, queueId, autoCrowned: true }; }
  } else if (!db.activeGame()) {
    callNextChallenger();
  }
  return { success: true, queueId };
}
function leaveQueue(playerId) { db.removePlayerFromQueue(playerId); broadcast('queue_updated', { queue: db.getQueue() }); return { success: true }; }
function crownKing(playerId) {
  const oldReign = db.currentReign();
  if (oldReign && !oldReign.dethroned_at) db.endReign(oldReign.id, 0);
  db.setConfig('current_game_id', '');
  const reignId = db.startReign(playerId);
  dgt.clearExpectedPosition();
  broadcast('king_crowned', { king: db.getPlayer(playerId), reignId });
  callNextChallenger();
  return { success: true, reignId };
}
async function choosePosition(forced) {
  if (forced != null) return parseInt(forced, 10);
  if (process.env.CHESS960_SOURCE !== 'bitcoin') return chess960.randomPositionNumber();
  try { return (await chess960.fetchBitcoinPosition()).positionNumber; } catch (e) { return chess960.randomPositionNumber(); }
}
async function callNextChallenger(forcedPosition = null) {
  const kingId = parseInt(db.getConfig('current_king_id') || '0', 10);
  if (!kingId || db.activeGame()) return null;
  const next = db.getNextInQueue(); if (!next) { broadcast('queue_empty'); return null; }
  const pos = await choosePosition(forcedPosition);
  const reignId = parseInt(db.getConfig('current_reign_id') || '0', 10) || null;
  const gameId = db.createGame({ kingId, challengerId: next.player_id, position: pos, reignId });
  db.removeQueueId(next.id);
  gameStartedAt = Date.now();
  dgt.setExpectedPosition(pos);
  const game = db.getGame(gameId);
  const payload = { game, position: chess960.positionToDisplay(pos), timeControl: timeControl() };
  broadcast('game_started', payload);
  return game;
}
function timeControl() { return { base: parseInt(db.getConfig('time_control_base') || config.timeControlBase, 10), increment: parseInt(db.getConfig('time_control_increment') || config.timeControlIncrement, 10) }; }
function startSatAccumulator() { if (satTimer) return; satTimer = setInterval(flushSats, 10000); }
function flushSats() {
  const game = db.activeGame(); const reign = db.currentReign();
  if (!game || !reign || !gameStartedAt) return 0;
  const elapsed = Math.max(0, Math.floor((Date.now() - gameStartedAt) / 1000));
  const rate = parseInt(db.getConfig('sat_rate_per_second') || config.satRatePerSecond, 10);
  const target = elapsed * rate;
  const delta = target - (reign.total_sats_earned || 0);
  if (delta > 0) { db.addSats(game.king_id, delta); db.updateReignStats(reign.id, { total_sats_earned: target }); broadcast('sats_tick', { delta, liveSats: target }); }
  return delta;
}
function finalizeGame(gameId, result) {
  flushSats();
  const game = db.getGame(gameId); if (!game) return { error: 'Game not found' };
  const valid = ['king_won', 'challenger_won', 'draw', 'no_show']; if (!valid.includes(result)) return { error: 'Invalid result' };
  const duration = gameStartedAt ? Math.floor((Date.now() - gameStartedAt) / 1000) : 0;
  const gameSats = duration * parseInt(db.getConfig('sat_rate_per_second') || config.satRatePerSecond, 10);
  db.finalizeGame(gameId, result, gameSats);
  dgt.clearExpectedPosition();
  gameStartedAt = null;
  if (result !== 'no_show') updateStats(game, result);
  if (result === 'challenger_won') {
    const reign = db.currentReign(); if (reign) db.endReign(reign.id, duration);
    db.startReign(game.challenger_id);
  }
  broadcast('game_finalized', { gameId, result });
  if (result === 'no_show') callNextChallenger(game.chess960_position); else callNextChallenger();
  return { success: true };
}
function updateStats(game, result) {
  const reign = db.currentReign();
  if (reign) db.updateReignStats(reign.id, { games_played: (reign.games_played || 0) + 1, consecutive_wins: result === 'king_won' || result === 'draw' ? (reign.consecutive_wins || 0) + 1 : reign.consecutive_wins || 0 });
  if (result === 'king_won') { db.run('UPDATE players SET games_played=games_played+1,games_won=games_won+1 WHERE id=?', [game.king_id]); db.run('UPDATE players SET games_played=games_played+1,games_lost=games_lost+1 WHERE id=?', [game.challenger_id]); }
  if (result === 'challenger_won') { db.run('UPDATE players SET games_played=games_played+1,games_lost=games_lost+1 WHERE id=?', [game.king_id]); db.run('UPDATE players SET games_played=games_played+1,games_won=games_won+1 WHERE id=?', [game.challenger_id]); }
  if (result === 'draw') { db.run('UPDATE players SET games_played=games_played+1,games_drawn=games_drawn+1 WHERE id IN (?,?)', [game.king_id, game.challenger_id]); }
}
function reportResult(playerId, result) { const game = db.activeGame(); if (!game) return { error: 'No active game' }; if (playerId !== game.king_id && playerId !== game.challenger_id) return { error: 'Not in current game' }; return finalizeGame(game.id, result); }
function adminReorder(order) { if (!Array.isArray(order) || !order.length) return { error: 'Order required' }; const currentKingId = parseInt(db.getConfig('current_king_id') || '0', 10); const newKing = order[0]; const active = db.activeGame(); if (active && (newKing !== currentKingId || order[1] !== active.challenger_id)) finalizeGame(active.id, 'no_show'); db.reorderQueue(order.slice(1)); if (newKing !== currentKingId) crownKing(newKing); broadcast('queue_updated', { queue: db.getQueue() }); return { success: true }; }
function lockEvent(locked) { db.setConfig('event_locked', locked ? '1' : '0'); broadcast('event_lock', { locked: Boolean(locked) }); return { success: true }; }
function resetEvent() { const backup = db.backup('pre-reset'); db.resetEventData(); dgt.clearExpectedPosition(); gameStartedAt = null; broadcast('event_reset', { backup }); return { success: true, backup }; }
function getState() { flushSats(); const kingId = parseInt(db.getConfig('current_king_id') || '0', 10); const game = db.activeGame(); const reign = db.currentReign(); return { event: { name: db.getConfig('event_name'), day: db.getConfig('event_day'), locked: db.getConfig('event_locked') === '1', venueCode: db.activeVenueCode()?.code || null }, king: kingId ? db.getPlayer(kingId) : null, reign, game, queue: db.getQueue(), recentGames: db.recentGames(8), players: db.listPlayers(), payouts: db.listPayouts(10), dgt: dgt.snapshot(), config: { satRate: parseInt(db.getConfig('sat_rate_per_second') || config.satRatePerSecond, 10), timeControl: timeControl(), dgtClockSwapSides: config.dgtClockSwapSides }, liveSats: reign ? reign.total_sats_earned : 0 } }
module.exports = { init, getState, registerPlayer, joinQueue, leaveQueue, crownKing, callNextChallenger, finalizeGame, reportResult, adminReorder, lockEvent, resetEvent, rotateVenueCode, flushSats };
