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
  if (game) dgt.setExpectedPosition(game.chess960_position);
  if (game && game.table_started_at) gameStartedAt = parseTimeMs(game.table_started_at);
  ensureVenueCode();
  ensureEventStartedAt();
  startSatAccumulator();
  console.log('♛ v2 event engine ready');
}
function shutdown() { if (satTimer) clearInterval(satTimer); satTimer = null; io = null; }
function parseTimeMs(value) {
  if (!value) return 0;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return new Date(value.replace(' ', 'T') + 'Z').getTime();
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}
function ensureEventStartedAt() {
  let started = db.getConfig('event_started_at');
  if (parseTimeMs(started)) return started;
  const rate = parseInt(db.getConfig('sat_rate_per_second') || config.satRatePerSecond, 10);
  const awarded = db.eventTotalSatsEarned();
  const backfillMs = rate > 0 ? Math.floor(awarded / rate) * 1000 : 0;
  started = new Date(Date.now() - backfillMs).toISOString();
  db.setConfig('event_started_at', started);
  return started;
}
function broadcast(type, payload = {}) { if (io) io.emit(type, payload); if (io) io.emit('state', publicState()); }
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
async function adminSetPairing({ kingId, challengerId, position = null } = {}) {
  const king = db.getPlayer(parseInt(kingId, 10));
  const challenger = db.getPlayer(parseInt(challengerId, 10));
  if (!king || !challenger) return { error: 'King and challenger are required' };
  if (king.id === challenger.id) return { error: 'King and challenger must be different players' };
  if (king.auth_type !== 'lightning' || challenger.auth_type !== 'lightning') return { error: 'Both players must have Lightning login' };
  flushSats();
  const current = db.activeGame();
  if (current) db.finalizeGame(current.id, 'admin_replaced', current.sats_earned || 0);
  const currentKingId = parseInt(db.getConfig('current_king_id') || '0', 10);
  let reignId = parseInt(db.getConfig('current_reign_id') || '0', 10) || null;
  if (currentKingId !== king.id || !reignId) {
    const oldReign = db.currentReign();
    if (oldReign && !oldReign.dethroned_at) db.endReign(oldReign.id, Math.max(0, Math.floor((Date.now() - parseTimeMs(oldReign.crowned_at)) / 1000)));
    reignId = db.startReign(king.id);
  }
  db.removePlayerFromQueue(king.id);
  db.removePlayerFromQueue(challenger.id);
  const pos = await choosePosition(position);
  const gameId = db.createGame({ kingId: king.id, challengerId: challenger.id, position: pos, reignId });
  gameStartedAt = null;
  dgt.setExpectedPosition(pos);
  const game = db.getGame(gameId);
  broadcast('admin_pairing_set', { game, position: chess960.positionToDisplay(pos) });
  return { success: true, game };
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
function startSatAccumulator() { if (satTimer) return; satTimer = setInterval(flushSats, 1000); }
function flushSats() {
  const game = db.activeGame(); const reign = db.currentReign();
  const rate = parseInt(db.getConfig('sat_rate_per_second') || config.satRatePerSecond, 10);
  const eventStartedAt = parseTimeMs(ensureEventStartedAt());
  if (!eventStartedAt || rate <= 0) return 0;
  const eventElapsed = Math.max(0, Math.floor((Date.now() - eventStartedAt) / 1000));
  const eventTarget = eventElapsed * rate;
  const eventAwarded = db.eventTotalSatsEarned();
  const delta = eventTarget - eventAwarded;
  let gameTarget = game?.sats_earned || 0;
  if (game?.table_started_at) {
    const tableStartedAt = parseTimeMs(game.table_started_at);
    gameStartedAt = tableStartedAt;
    const gameElapsed = Math.max(0, Math.floor((Date.now() - tableStartedAt) / 1000));
    gameTarget = gameElapsed * rate;
    if (gameTarget > (game.sats_earned || 0)) db.run('UPDATE games SET sats_earned=? WHERE id=?', [gameTarget, game.id]);
  }
  if (delta > 0 && reign) {
    const reignTotal = (reign.total_sats_earned || 0) + delta;
    db.addSats(reign.king_id, delta);
    db.updateReignStats(reign.id, { total_sats_earned: reignTotal });
    const eventTotalSats = db.eventTotalSatsEarned();
    const king = db.getPlayer(reign.king_id);
    broadcast('sats_tick', { delta, liveSats: reignTotal, gameSats: gameTarget, kingTotal: king ? king.total_sats_earned : reignTotal, eventTotalSats, eventElapsed });
  }
  return Math.max(0, delta);
}
function dgtStartReadiness(dgtSnapshot) {
  if (!dgtSnapshot || dgtSnapshot.stale) return { ok: false, reason: 'dgt_stale' };
  if (!dgtSnapshot.setupOk) return { ok: false, reason: 'setup_not_ready' };
  if (!dgtSnapshot.clock || !dgtSnapshot.clock.running) return { ok: false, reason: 'clock_not_running' };
  const base = timeControl().base;
  const resetTolerance = 5;
  if (base > 0 && (Number(dgtSnapshot.clock.white) < base - resetTolerance || Number(dgtSnapshot.clock.black) < base - resetTolerance)) return { ok: false, reason: 'clock_not_reset' };
  return { ok: true };
}
function startTableGame(options = {}) {
  const game = db.activeGame(); if (!game) return { error: 'No active game' };
  if (game.table_started_at) return { success: true, game };
  const readiness = dgtStartReadiness(options.dgtSnapshot || dgt.snapshot());
  if (!readiness.ok) return { error: readiness.reason };
  const started = db.startGame(game.id); if (started.error) return started;
  gameStartedAt = parseTimeMs(started.table_started_at);
  broadcast('game_started', { game: started, position: chess960.positionToDisplay(started.chess960_position), timeControl: timeControl() });
  return { success: true, game: started };
}
function maybeAutoStartFromDgt(dgtSnapshot) {
  const game = db.activeGame();
  if (!game || game.table_started_at) return { started: false, reason: 'no_unstarted_game' };
  const readiness = dgtStartReadiness(dgtSnapshot);
  if (!readiness.ok) return { started: false, reason: readiness.reason };
  const r = startTableGame({ dgtSnapshot });
  return r.error ? { started: false, error: r.error } : { started: true, game: r.game };
}
function finalizeGame(gameId, result) {
  flushSats();
  const game = db.getGame(gameId); if (!game) return { error: 'Game not found' };
  const valid = ['king_won', 'challenger_won', 'draw', 'no_show']; if (!valid.includes(result)) return { error: 'Invalid result' };
  if (result !== 'no_show' && !game.table_started_at) return { error: 'Game has not started at the table' };
  const startedAt = game.table_started_at ? parseTimeMs(game.table_started_at) : gameStartedAt;
  const duration = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
  const gameSats = duration * parseInt(db.getConfig('sat_rate_per_second') || config.satRatePerSecond, 10);
  db.finalizeGame(gameId, result, gameSats);
  dgt.clearExpectedPosition();
  gameStartedAt = null;
  if (result !== 'no_show') updateStats(game, result);
  if (result === 'challenger_won') {
    const reign = db.currentReign();
    if (reign) db.endReign(reign.id, Math.max(0, Math.floor((Date.now() - parseTimeMs(reign.crowned_at)) / 1000)));
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
function getState() { flushSats(); const kingId = parseInt(db.getConfig('current_king_id') || '0', 10); const game = db.activeGame(); const reign = db.currentReign(); return { event: { name: db.getConfig('event_name'), day: db.getConfig('event_day'), locked: db.getConfig('event_locked') === '1', paused: isPaused(), venueCode: db.activeVenueCode()?.code || null }, king: kingId ? db.getPlayer(kingId) : null, reign, game, queue: db.getQueue(), recentGames: db.recentGames(8), players: db.listPlayers(), payouts: db.listPayouts(10), dgt: dgt.snapshot(), config: { satRate: parseInt(db.getConfig('sat_rate_per_second') || config.satRatePerSecond, 10), timeControl: timeControl(), dgtClockSwapSides: config.dgtClockSwapSides }, liveSats: reign ? reign.total_sats_earned : 0, eventTotalSats: db.eventTotalSatsEarned() } }
function publicState() {
  const s = getState();
  const publicDgt = s.dgt ? { stale: s.dgt.stale, setupOk: s.dgt.setupOk, setupMessage: s.dgt.setupMessage, setupDiff: (s.dgt.setupDiff || []).slice(0, 64).map(d => ({ square: d.square, message: d.message })), fen: s.dgt.fen || null, clock: s.dgt.clock } : {};
  return { event: { day: s.event.day, locked: s.event.locked, paused: s.event.paused, venueCode: s.event.venueCode }, king: s.king ? { id: s.king.id, name: s.king.name, total_sats_earned: s.king.total_sats_earned || 0 } : null, game: s.game ? { id: s.game.id, king_id: s.game.king_id, challenger_id: s.game.challenger_id, king_name: s.game.king_name, challenger_name: s.game.challenger_name, chess960_position: s.game.chess960_position, king_color: s.game.king_color, table_started_at: s.game.table_started_at } : null, queue: s.queue.map(q => ({ player_id: q.player_id, player_name: q.player_name })), dgt: publicDgt, config: s.config, liveSats: s.liveSats, eventTotalSats: s.eventTotalSats };
}
module.exports = { init, shutdown, getState, publicState, registerPlayer, joinQueue, leaveQueue, adminAddToQueue, adminRemoveFromQueue, crownKing, adminSetPairing, callNextChallenger, startTableGame, maybeAutoStartFromDgt, finalizeGame, reportResult, adminReorder, adminReorderQueue, lockEvent, pauseEvent, resumeEvent, resetEvent, rotateVenueCode, flushSats };
