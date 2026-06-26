const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { config } = require('../config/env');

let SQL;
let db;
let saveTimer;

async function initialize(customPath = null) {
  if (!SQL) SQL = await initSqlJs();
  const dbPath = customPath || config.databasePath;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (fs.existsSync(dbPath)) {
    db = new SQL.Database(fs.readFileSync(dbPath));
    console.log(`📦 v2 loaded DB ${dbPath}`);
  } else {
    db = new SQL.Database();
    console.log(`📦 v2 created DB ${dbPath}`);
  }
  db.__path = dbPath;
  createTables();
  migrate();
  seedConfig();
  save();
  if (!saveTimer) saveTimer = setInterval(() => { if (db) save(); }, 30000);
  return api;
}

function conn() { if (!db) throw new Error('DB not initialized'); return db; }
function save() { if (!db) return; fs.writeFileSync(db.__path, Buffer.from(db.export())); }
function shutdown() { save(); if (saveTimer) clearInterval(saveTimer); saveTimer = null; }
function exec(sql, params = []) { const stmt = conn().prepare(sql); stmt.bind(params); const rows = []; while (stmt.step()) rows.push(stmt.getAsObject()); stmt.free(); return rows; }
function get(sql, params = []) { return exec(sql, params)[0] || null; }
function run(sql, params = []) { conn().run(sql, params); save(); }
function scalar(sql, params = []) { const row = get(sql, params); return row ? Object.values(row)[0] : null; }
function insert(sql, params = []) { conn().run(sql, params); const id = scalar('SELECT last_insert_rowid() AS id'); save(); return id; }
function now() { return new Date().toISOString(); }

function createTables() {
  const d = conn();
  d.run(`CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    auth_type TEXT DEFAULT 'pin',
    auth_id TEXT,
    pin TEXT DEFAULT '',
    session_token TEXT,
    sat_balance INTEGER DEFAULT 0,
    reserved_sats INTEGER DEFAULT 0,
    total_sats_earned INTEGER DEFAULT 0,
    total_sats_claimed INTEGER DEFAULT 0,
    games_played INTEGER DEFAULT 0,
    games_won INTEGER DEFAULT 0,
    games_lost INTEGER DEFAULT 0,
    games_drawn INTEGER DEFAULT 0,
    times_as_king INTEGER DEFAULT 0,
    total_reign_seconds REAL DEFAULT 0,
    longest_reign_seconds REAL DEFAULT 0,
    longest_win_streak INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  d.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_players_auth_unique ON players(auth_type, auth_id) WHERE auth_id IS NOT NULL AND auth_id != ''`);
  d.run(`CREATE TABLE IF NOT EXISTS queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER NOT NULL UNIQUE,
    position INTEGER NOT NULL,
    joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(player_id) REFERENCES players(id)
  )`);
  d.run(`CREATE TABLE IF NOT EXISTS reigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    king_id INTEGER NOT NULL,
    crowned_at TEXT DEFAULT CURRENT_TIMESTAMP,
    dethroned_at TEXT,
    total_reign_seconds REAL DEFAULT 0,
    total_sats_earned INTEGER DEFAULT 0,
    consecutive_wins INTEGER DEFAULT 0,
    games_played INTEGER DEFAULT 0,
    FOREIGN KEY(king_id) REFERENCES players(id)
  )`);
  d.run(`CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    king_id INTEGER NOT NULL,
    challenger_id INTEGER NOT NULL,
    chess960_position INTEGER NOT NULL,
    king_color TEXT DEFAULT 'black',
    started_at TEXT DEFAULT CURRENT_TIMESTAMP,
    ended_at TEXT,
    table_started_at TEXT,
    king_reported TEXT,
    challenger_reported TEXT,
    result TEXT,
    sats_earned INTEGER DEFAULT 0,
    reign_id INTEGER,
    FOREIGN KEY(king_id) REFERENCES players(id),
    FOREIGN KEY(challenger_id) REFERENCES players(id),
    FOREIGN KEY(reign_id) REFERENCES reigns(id)
  )`);
  d.run(`CREATE TABLE IF NOT EXISTS payouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER NOT NULL,
    amount_sats INTEGER NOT NULL,
    method TEXT DEFAULT 'lnurl-withdraw',
    invoice TEXT,
    payment_hash TEXT,
    status TEXT DEFAULT 'requested',
    error_message TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,
    FOREIGN KEY(player_id) REFERENCES players(id)
  )`);
  d.run(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  d.run(`CREATE TABLE IF NOT EXISTS venue_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, created_at TEXT DEFAULT CURRENT_TIMESTAMP, expires_at TEXT, is_active INTEGER DEFAULT 1)`);
  d.run(`CREATE TABLE IF NOT EXISTS admin_notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, message TEXT NOT NULL, resolved INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  d.run(`CREATE TABLE IF NOT EXISTS event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, message TEXT NOT NULL, payload TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
}

function migrate() {
  const columns = table => exec(`PRAGMA table_info(${table})`).map(r => r.name);
  if (!columns('players').includes('reserved_sats')) conn().run(`ALTER TABLE players ADD COLUMN reserved_sats INTEGER DEFAULT 0`);
  if (!columns('games').includes('king_color')) conn().run(`ALTER TABLE games ADD COLUMN king_color TEXT DEFAULT 'black'`);
  if (!columns('games').includes('table_started_at')) conn().run(`ALTER TABLE games ADD COLUMN table_started_at TEXT`);
  if (!columns('payouts').includes('method')) conn().run(`ALTER TABLE payouts ADD COLUMN method TEXT DEFAULT 'lnurl-withdraw'`);
  if (!columns('payouts').includes('invoice')) conn().run(`ALTER TABLE payouts ADD COLUMN invoice TEXT`);
  if (!columns('payouts').includes('updated_at')) {
    conn().run(`ALTER TABLE payouts ADD COLUMN updated_at TEXT`);
    conn().run(`UPDATE payouts SET updated_at = COALESCE(created_at, ?) WHERE updated_at IS NULL`, [now()]);
  }
}

function seedConfig() {
  const defaults = {
    current_king_id: '', current_reign_id: '', current_game_id: '',
    sat_rate_per_second: String(config.satRatePerSecond),
    time_control_base: String(config.timeControlBase),
    time_control_increment: String(config.timeControlIncrement),
    event_locked: '0', event_paused: '0', event_name: '960 Throne', event_day: '1'
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (!get('SELECT key FROM config WHERE key=?', [key])) run('INSERT INTO config(key,value) VALUES(?,?)', [key, value]);
  }
}

function log(type, message, payload = null) { run('INSERT INTO event_log(type,message,payload) VALUES(?,?,?)', [type, message, payload ? JSON.stringify(payload) : null]); }
function getConfig(key) { const row = get('SELECT value FROM config WHERE key=?', [key]); return row ? row.value : ''; }
function setConfig(key, value) { run('INSERT OR REPLACE INTO config(key,value) VALUES(?,?)', [key, String(value)]); }

function createPlayer({ name, authType = 'pin', authId = null, pin = '', sessionToken = null }) {
  const id = insert('INSERT INTO players(name,auth_type,auth_id,pin,session_token) VALUES(?,?,?,?,?)', [name, authType, authId, pin, sessionToken]);
  log('player_created', `${name || 'Unnamed player'} registered`, { playerId: id, authType }); return id;
}
function getPlayer(id) { return get('SELECT * FROM players WHERE id=?', [id]); }
function getPlayerByToken(token) { return token ? get('SELECT * FROM players WHERE session_token=?', [token]) : null; }
function getPlayerByAuth(authType, authId) { return authType && authId ? get('SELECT * FROM players WHERE auth_type=? AND auth_id=?', [authType, authId]) : null; }
function listPlayers() { return exec('SELECT * FROM players ORDER BY name COLLATE NOCASE'); }
function touchPlayer(id) { run('UPDATE players SET last_seen_at=? WHERE id=?', [now(), id]); }
function setPlayerToken(id, token) { run('UPDATE players SET session_token=?, last_seen_at=? WHERE id=?', [token, now(), id]); }
function setPlayerName(id, name) { run('UPDATE players SET name=?, last_seen_at=? WHERE id=?', [name, now(), id]); log('player_named', `Player #${id} set display name`, { playerId: id, name }); }

function addToQueue(playerId) {
  const pos = (scalar('SELECT COALESCE(MAX(position),0)+1 FROM queue') || 1);
  const id = insert('INSERT INTO queue(player_id,position) VALUES(?,?)', [playerId, pos]);
  log('queue_join', `Player #${playerId} joined queue`, { playerId, position: pos }); return id;
}
function normalizeQueue() { exec('SELECT id FROM queue ORDER BY position,id').forEach((r, i) => conn().run('UPDATE queue SET position=? WHERE id=?', [i + 1, r.id])); save(); }
function removeQueueId(queueId) { run('DELETE FROM queue WHERE id=?', [queueId]); normalizeQueue(); }
function removePlayerFromQueue(playerId) { run('DELETE FROM queue WHERE player_id=?', [playerId]); normalizeQueue(); }
function isPlayerInQueue(playerId) { return Boolean(get('SELECT id FROM queue WHERE player_id=?', [playerId])); }
function getQueue() { return exec(`SELECT q.*, p.name AS player_name, p.sat_balance FROM queue q JOIN players p ON p.id=q.player_id ORDER BY q.position,q.id`); }
function getNextInQueue() { return getQueue()[0] || null; }
function reorderQueue(playerIds) { conn().run('DELETE FROM queue'); playerIds.forEach((pid, i) => conn().run('INSERT INTO queue(player_id,position) VALUES(?,?)', [pid, i + 1])); save(); log('queue_reorder', 'Queue reordered', { playerIds }); }

function startReign(kingId) {
  const id = insert('INSERT INTO reigns(king_id) VALUES(?)', [kingId]);
  setConfig('current_reign_id', id); setConfig('current_king_id', kingId);
  run('UPDATE players SET times_as_king=times_as_king+1 WHERE id=?', [kingId]);
  log('king_crowned', `Player #${kingId} crowned`, { kingId, reignId: id }); return id;
}
function getReign(id) { return get('SELECT * FROM reigns WHERE id=?', [id]); }
function currentReign() { const id = parseInt(getConfig('current_reign_id') || '0', 10); return id ? getReign(id) : null; }
function endReign(id, seconds = 0) { run('UPDATE reigns SET dethroned_at=?, total_reign_seconds=total_reign_seconds+? WHERE id=?', [now(), seconds, id]); }
function updateReignStats(id, updates) { const keys = Object.keys(updates); run(`UPDATE reigns SET ${keys.map(k => `${k}=?`).join(', ')} WHERE id=?`, [...keys.map(k => updates[k]), id]); }

function createGame({ kingId, challengerId, position, reignId }) {
  const id = insert('INSERT INTO games(king_id,challenger_id,chess960_position,reign_id,king_color) VALUES(?,?,?,?,?)', [kingId, challengerId, position, reignId, 'black']);
  setConfig('current_game_id', id); log('game_called', `Game #${id} called`, { gameId: id, kingId, challengerId, position }); return id;
}
function getGame(id) { return get(`SELECT g.*, k.name AS king_name, c.name AS challenger_name FROM games g JOIN players k ON k.id=g.king_id JOIN players c ON c.id=g.challenger_id WHERE g.id=?`, [id]); }
function startGame(id) { const game = getGame(id); if (!game || game.result) return { error: 'No active game' }; const ts = game.table_started_at || now(); run('UPDATE games SET table_started_at=? WHERE id=?', [ts, id]); log('game_table_started', `Game #${id} started at table`, { gameId: id }); return getGame(id); }
function activeGame() { const id = parseInt(getConfig('current_game_id') || '0', 10); const g = id ? getGame(id) : null; return g && !g.result ? g : null; }
function finalizeGame(id, result, satsEarned = 0) { run('UPDATE games SET result=?, sats_earned=?, ended_at=? WHERE id=?', [result, satsEarned, now(), id]); setConfig('current_game_id', ''); log('game_finalized', `Game #${id}: ${result}`, { gameId: id, result, satsEarned }); }
function recentGames(limit = 10) { return exec(`SELECT g.*, k.name AS king_name, c.name AS challenger_name FROM games g JOIN players k ON k.id=g.king_id JOIN players c ON c.id=g.challenger_id WHERE g.result IS NOT NULL ORDER BY g.id DESC LIMIT ?`, [limit]); }

function addSats(playerId, amount) { run('UPDATE players SET sat_balance=sat_balance+?, total_sats_earned=total_sats_earned+? WHERE id=?', [amount, Math.max(0, amount), playerId]); }
function reservePayout(playerId, amount, method = 'lnurl-withdraw') {
  const p = getPlayer(playerId); if (!p) return { error: 'Player not found' };
  if (amount <= 0) return { error: 'Amount must be positive' };
  if (p.sat_balance < amount) return { error: `Insufficient balance: ${p.sat_balance}` };
  conn().run('UPDATE players SET sat_balance=sat_balance-?, reserved_sats=reserved_sats+? WHERE id=?', [amount, amount, playerId]);
  conn().run('INSERT INTO payouts(player_id,amount_sats,method,status,updated_at) VALUES(?,?,?,?,?)', [playerId, amount, method, 'reserved', now()]);
  save(); const payoutId = get('SELECT id FROM payouts ORDER BY id DESC LIMIT 1').id; log('payout_reserved', `Reserved ${amount} sats`, { payoutId, playerId, amount }); return { payoutId };
}
function payoutPaying(id, invoice = null) { run('UPDATE payouts SET status=?, invoice=?, updated_at=? WHERE id=?', ['paying', invoice, now(), id]); }
function payoutComplete(id, paymentHash = null) {
  const p = get('SELECT * FROM payouts WHERE id=?', [id]);
  if (!p) return { error: 'Payout not found' };
  if (!['reserved', 'paying', 'requested'].includes(p.status)) return { error: `Payout already ${p.status}` };
  conn().run('UPDATE players SET reserved_sats=MAX(0,reserved_sats-?), total_sats_claimed=total_sats_claimed+? WHERE id=?', [p.amount_sats, p.amount_sats, p.player_id]);
  conn().run('UPDATE payouts SET status=?, payment_hash=?, updated_at=?, completed_at=? WHERE id=?', ['completed', paymentHash, now(), now(), id]);
  save(); log('payout_completed', `Completed ${p.amount_sats} sats`, { payoutId: id }); return { success: true };
}
function payoutFail(id, error) {
  const p = get('SELECT * FROM payouts WHERE id=?', [id]);
  if (!p) return { error: 'Payout not found' };
  if (!['reserved', 'paying', 'requested'].includes(p.status)) return { error: `Payout already ${p.status}` };
  conn().run('UPDATE players SET reserved_sats=MAX(0,reserved_sats-?), sat_balance=sat_balance+? WHERE id=?', [p.amount_sats, p.amount_sats, p.player_id]);
  conn().run('UPDATE payouts SET status=?, error_message=?, updated_at=? WHERE id=?', ['failed', error, now(), id]);
  save(); log('payout_failed', `Failed ${p.amount_sats} sats: ${error}`, { payoutId: id }); return { success: true };
}
function listPayouts(limit = 50) { return exec(`SELECT po.*, p.name AS player_name FROM payouts po JOIN players p ON p.id=po.player_id ORDER BY po.id DESC LIMIT ?`, [limit]); }

function activeVenueCode() { return get('SELECT * FROM venue_codes WHERE is_active=1 ORDER BY id DESC LIMIT 1'); }
function validateVenueCode(code) { const active = activeVenueCode(); return Boolean(active && String(active.code).toUpperCase() === String(code || '').trim().toUpperCase()); }
function createVenueCode(code) { run('UPDATE venue_codes SET is_active=0'); const id = insert('INSERT INTO venue_codes(code,is_active) VALUES(?,1)', [code]); log('venue_code', `Venue code rotated: ${code}`, { code }); return id; }
function notifications() { return exec('SELECT * FROM admin_notifications WHERE resolved=0 ORDER BY id DESC LIMIT 25'); }
function notify(type, message) { run('INSERT INTO admin_notifications(type,message) VALUES(?,?)', [type, message]); }
function eventLog(limit = 100) { return exec('SELECT * FROM event_log ORDER BY id DESC LIMIT ?', [limit]); }

function backup(label = 'manual') { save(); const dir = path.dirname(db.__path); const stamp = new Date().toISOString().replace(/[:.]/g, '-'); const out = path.join(dir, `throne-v2-${label}-${stamp}.db`); fs.copyFileSync(db.__path, out); return out; }
function resetEventData() {
  conn().run('DELETE FROM queue');
  conn().run('DELETE FROM games');
  conn().run('DELETE FROM reigns');
  conn().run('DELETE FROM admin_notifications');
  // Preserve identity and claimable balances across events. The reset clears only
  // this-event competitive counters so leaderboards/winnings counters start fresh.
  conn().run('UPDATE players SET total_sats_earned=0,games_played=0,games_won=0,games_lost=0,games_drawn=0,times_as_king=0,total_reign_seconds=0,longest_reign_seconds=0,longest_win_streak=0');
  conn().run(`UPDATE config SET value='' WHERE key IN ('current_king_id','current_reign_id','current_game_id')`);
  setConfig('event_paused', '0');
  save();
  log('event_reset', 'Event data reset; player identities and balances preserved');
}

const api = { initialize, shutdown, save, backup, resetEventData, exec, get, run, log, getConfig, setConfig, createPlayer, getPlayer, getPlayerByToken, getPlayerByAuth, listPlayers, touchPlayer, setPlayerToken, setPlayerName, addToQueue, removeQueueId, removePlayerFromQueue, isPlayerInQueue, getQueue, getNextInQueue, reorderQueue, startReign, getReign, currentReign, endReign, updateReignStats, createGame, getGame, startGame, activeGame, finalizeGame, recentGames, addSats, reservePayout, payoutPaying, payoutComplete, payoutFail, listPayouts, activeVenueCode, validateVenueCode, createVenueCode, notifications, notify, eventLog };
module.exports = api;
