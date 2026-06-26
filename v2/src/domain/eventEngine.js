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
  if (game && game.table_started_at) gameStartedAt = new Date(game.table_started_at).getTime();
  ensureVenueCode();
  startSatAccumulator();
  console.log('♛ v2 event engine ready');
}
function shutdown() { if (satTimer) clearInterval(satTimer); satTimer = null; io = null; }
function broadcast(type, payload = {}) { if (io) io.emit(type, payload); if (io) io.emit('state', getState()); }
function generateVenueCode() { const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
function ensureVenueCode() { if (!db.activeVenueCode()) db.createVenueCode(generateVenueCode()); }
function rotateVenueCode() { const code = generateVenueCode(); db.createVenueCode(code); broadcast('venue_code_updated', { code }); return code; }
function isPaused() { return db.getConfig('event_paused') === '1'; }
function setPaused(paused) {
  db.setConfig('event_paused', paused ? '1' : '0');
  broadcast(paused ? 'event_paused' : 'event_resumed', { paused: Boolean(paused) });
  if (!paused && !db.activeGame()) callNextChallenger();
  return { success: true, paused: Boolean(paused) };
}

function registerPlayer(name, opts = {}) { const token = uuidv4(); const id = db.createPlayer({ name: String(name || '').trim(), authType: opts.authType || 'pin', authId: opts.authId || null, sessionToken: token }); return { player: db.getPlayer(id), token }; }
function joinQueue(playerId) {
  if (db.getConfig('event_locked') === '1') return { error: 'Event is locked' };
  const player = db.getPlayer(playerId);
  if (!player) return { error: 'Player not found' };
  if (player.auth_type !== 'lightning') return { error: 'Lightning wallet login required' };
  if (!String(player.name || '').trim()) return { error: 'Display name required' };
  const kingId = parseInt(db.getConfig('current_king_id') || '0', 10);
  if (kingId === playerId) return { error: "You're the King" };
  if (db.isPlayerInQueue(playerId)) return { error: 'Already in queue' };
  const queueId = db.addToQueue(playerId);
  broadcast('queue_updated', { queue: db.getQueue() });
  if (!kingId) {
    const first = db.getNextInQueue();
    if (first) { db.removeQueueId(first.id); crownKing(first.player_id); return { success: true, queueId, autoCrowned: true }; }
  } else if (!db.activeGame() && !isPaused()) {
    callNextChallenger();
  }
  return { success: true, queueId };
}
function leaveQueue(playerId) { db.removePlayerFromQueue(playerId); broadcast('queue_updated', { queue: db.getQueue() }); return { success: true }; }
function adminAddToQueue(playerId) {
  const player = db.getPlayer(playerId);
  if (!player) return { error: 'Player not found' };
  if (player.auth_type !== 'lightning') return { error: 'Lightning wallet login required' };
  if (!String(player.name || '').trim()) return { error: 'Display name required' };
  if (db.isPlayerInQueue(playerId)) return { error: 'Already in queue' };
  const queueId = db.addToQueue(playerId);
  broadcast('queue_updated', { queue: db.getQueue() });
  return { success: true, queueId };
}
function adminRemoveFromQueue(playerId) { db.removePlayerFromQueue(playerId); broadcast('queue_updated', { queue: db.getQueue() }); return { success: true }; }
function crownKing(playerId) {
  const oldReign = db.currentReign();
  if (oldReign && !oldReign.dethroned_at) db.endReign(oldReign.id, 0);
  db.setConfig('current_game_id', '');
  const reignId = db.startReign(playerId);
  dgt.clearExpectedPosition();
  broadcast('king_crowned', { king: db.getPlayer(playerId), reignId });
  if (!isPaused()) callNextChallenger();
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
  if (isPaused()) { broadcast('next_game_paused', { queue: db.getQueue() }); return null; }
  const next = db.getNextInQueue(); if (!next) { broadcast('queue_empty'); return null; }
  const pos = await choosePosition(forcedPosition);
  const reignId = parseInt(db.getConfig('current_reign_id') || '0', 10) || null;
  const gameId = db.createGame({ kingId, challengerId: next.player_id, position: pos, reignId });
  db.removeQueueId(next.id);
  gameStartedAt = null;
  dgt.setExpectedPosition(pos);
  const game = db.getGame(gameId);
  const payload = { game, position: chess960.positionToDisplay(pos), timeControl: timeControl() };
  broadcast('game_called', payload);
  return game;
}
function timeControl() { return { base: parseInt(db.getConfig('time_control_base') || config.timeControlBase, 10), increment: parseInt(db.getConfig('time_control_increment') || config.timeControlIncrement, 10) }; }
function startSatAccumulator() { if (satTimer) return; satTimer = setInterval(flushSats, 10000); }
function flushSats() {
  const game = db.activeGame(); const reign = db.currentReign();
  const startedAt = game?.table_started_at ? new Date(game.table_started_at).getTime() : gameStartedAt;
  if (!game || !reign || !startedAt) return 0;
  gameStartedAt = startedAt;
  const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const rate = parseInt(db.getConfig('sat_rate_per_second') || config.satRatePerSecond, 10);
  const target = elapsed * rate;
  const delta = target - (reign.total_sats_earned || 0);
  if (delta > 0) { db.addSats(game.king_id, delta); db.updateReignStats(reign.id, { total_sats_earned: target }); const king = db.getPlayer(game.king_id); broadcast('sats_tick', { delta, liveSats: target, kingTotal: king ? king.total_sats_earned : target }); }
  return delta;
}
function startTableGame() {
  const game = db.activeGame(); if (!game) return { error: 'No active game' };
  const started = db.startGame(game.id); if (started.error) return started;
  gameStartedAt = new Date(started.table_started_at).getTime();
  broadcast('game_started', { game: started, position: chess960.positionToDisplay(started.chess960_position), timeControl: timeControl() });
  return { success: true, game: started };
}
function finalizeGame(gameId, result) {
  flushSats();
  const game = db.getGame(gameId); if (!game) return { error: 'Game not found' };
  const valid = ['king_won', 'challenger_won', 'draw', 'no_show']; if (!valid.includes(result)) return { error: 'Invalid result' };
  if (result !== 'no_show' && !game.table_started_at) return { error: 'Game has not started at the table' };
  const startedAt = game.table_started_at ? new Date(game.table_started_at).getTime() : gameStartedAt;
  const duration = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
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
  if (!isPaused()) {
    if (result === 'no_show') callNextChallenger(game.chess960_position); else callNextChallenger();
  } else {
    broadcast('next_game_paused', { queue: db.getQueue() });
  }
  return { success: true };
}
function updateStats(game, result) {
  const reign = db.currentReign();
  if (reign) db.updateReignStats(reign.id, { games_played: (reign.games_played || 0) + 1, consecutive_wins: result === 'king_won' || result === 'draw' ? (reign.consecutive_wins || 0) + 1 : reign.consecutive_wins || 0 });
  if (result === 'king_won') { db.run('UPDATE players SET games_played=games_played+1,games_won=games_won+1 WHERE id=?', [game.king_id]); db.run('UPDATE players SET games_played=games_played+1,games_lost=games_lost+1 WHERE id=?', [game.challenger_id]); }
  if (result === 'challenger_won') { db.run('UPDATE players SET games_played=games_played+1,games_lost=games_lost+1 WHERE id=?', [game.king_id]); db.run('UPDATE players SET games_played=games_played+1,games_won=games_won+1 WHERE id=?', [game.challenger_id]); }
  if (result === 'draw') { db.run('UPDATE players SET games_played=games_played+1,games_drawn=games_drawn+1 WHERE id IN (?,?)', [game.king_id, game.challenger_id]); }
}
function reportResult(playerId, result) { const game = db.activeGame(); if (!game) return { error: 'No active game' }; if (!game.table_started_at) return { error: 'Game has not started at the table' }; if (playerId !== game.king_id && playerId !== game.challenger_id) return { error: 'Not in current game' }; return finalizeGame(game.id, result); }
function adminReorder(order) { if (!Array.isArray(order) || !order.length) return { error: 'Order required' }; const currentKingId = parseInt(db.getConfig('current_king_id') || '0', 10); const newKing = order[0]; const active = db.activeGame(); if (active && (newKing !== currentKingId || order[1] !== active.challenger_id)) finalizeGame(active.id, 'no_show'); db.reorderQueue(order.slice(1)); if (newKing !== currentKingId) crownKing(newKing); broadcast('queue_updated', { queue: db.getQueue() }); return { success: true }; }
function adminReorderQueue(order) { if (!Array.isArray(order)) return { error: 'Order required' }; db.reorderQueue(order.map(Number).filter(Boolean)); broadcast('queue_updated', { queue: db.getQueue() }); return { success: true }; }
function lockEvent(locked) { db.setConfig('event_locked', locked ? '1' : '0'); broadcast('event_lock', { locked: Boolean(locked) }); return { success: true }; }
function pauseEvent() { return setPaused(true); }
function resumeEvent() { return setPaused(false); }
function resetEvent() { const backup = db.backup('pre-reset'); db.resetEventData(); dgt.clearExpectedPosition(); gameStartedAt = null; broadcast('event_reset', { backup }); return { success: true, backup }; }
function getState() { flushSats(); const kingId = parseInt(db.getConfig('current_king_id') || '0', 10); const game = db.activeGame(); const reign = db.currentReign(); return { event: { name: db.getConfig('event_name'), day: db.getConfig('event_day'), locked: db.getConfig('event_locked') === '1', paused: isPaused(), venueCode: db.activeVenueCode()?.code || null }, king: kingId ? db.getPlayer(kingId) : null, reign, game, queue: db.getQueue(), recentGames: db.recentGames(8), players: db.listPlayers(), payouts: db.listPayouts(10), dgt: dgt.snapshot(), config: { satRate: parseInt(db.getConfig('sat_rate_per_second') || config.satRatePerSecond, 10), timeControl: timeControl(), dgtClockSwapSides: config.dgtClockSwapSides }, liveSats: reign ? reign.total_sats_earned : 0 } }
function publicState() {
  const s = getState();
  const publicDgt = s.dgt ? { stale: s.dgt.stale, setupOk: s.dgt.setupOk, setupMessage: s.dgt.setupMessage, setupDiff: (s.dgt.setupDiff || []).slice(0, 16).map(d => ({ square: d.square, message: d.message })), fen: s.dgt.fen || null, clock: s.dgt.clock } : {};
  return { event: { day: s.event.day, locked: s.event.locked, paused: s.event.paused, venueCode: s.event.venueCode }, king: s.king ? { id: s.king.id, name: s.king.name, total_sats_earned: s.king.total_sats_earned || 0 } : null, game: s.game ? { id: s.game.id, king_id: s.game.king_id, challenger_id: s.game.challenger_id, king_name: s.game.king_name, challenger_name: s.game.challenger_name, chess960_position: s.game.chess960_position, king_color: s.game.king_color, table_started_at: s.game.table_started_at } : null, queue: s.queue.map(q => ({ player_id: q.player_id, player_name: q.player_name })), dgt: publicDgt, config: s.config, liveSats: s.liveSats };
}
module.exports = { init, shutdown, getState, publicState, registerPlayer, joinQueue, leaveQueue, adminAddToQueue, adminRemoveFromQueue, crownKing, callNextChallenger, startTableGame, finalizeGame, reportResult, adminReorder, adminReorderQueue, lockEvent, pauseEvent, resumeEvent, resetEvent, rotateVenueCode, flushSats };
