/**
 * Database service — SQLite via sql.js
 * Handles all data storage for 960 Throne
 */

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DATABASE_PATH || './data/throne.db';

let db = null;

// ============================================================
// Initialization
// ============================================================

async function initialize() {
    const SQL = await initSqlJs();
    const dbDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }

    if (fs.existsSync(DB_PATH)) {
        const buffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(buffer);
        console.log('📦 Loaded existing database');
    } else {
        db = new SQL.Database();
        console.log('📦 Created new database');
    }

    createTables();
    migrateSchema();
    seedConfig();
    save();
    return db;
}

function save() {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
}

// Auto-save every 30 seconds
setInterval(() => {
    if (db) save();
}, 30000);

/**
 * Create a timestamped backup of the database file.
 * Returns the backup file path.
 */
function backupDatabase(label = 'backup') {
    if (!db) return null;
    save(); // Ensure latest data is on disk
    const dbDir = path.dirname(DB_PATH);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(dbDir, `throne_${label}_${timestamp}.db`);
    const data = db.export();
    fs.writeFileSync(backupPath, Buffer.from(data));
    console.log(`💾 Database backed up to ${backupPath}`);
    return backupPath;
}

/**
 * Export the current in-memory database as a Buffer.
 * Safe read-only operation — no disk writes, no locking.
 */
function getExportBuffer() {
    if (!db) return null;
    return Buffer.from(db.export());
}

/**
 * Reset all event data for a clean run.
 * Keeps: player accounts (name, auth), config settings
 * Resets: all stats, sats, games, reigns, queue, notifications, payouts
 */
function resetEventData() {
    // Reset player stats but keep accounts
    db.run(`UPDATE players SET 
        sat_balance = 0,
        total_sats_earned = 0,
        total_sats_claimed = 0,
        games_played = 0,
        games_won = 0,
        games_lost = 0,
        games_drawn = 0,
        times_as_king = 0,
        total_reign_seconds = 0,
        longest_reign_seconds = 0,
        longest_win_streak = 0
    `);

    // Clear event tables
    db.run(`DELETE FROM games`);
    db.run(`DELETE FROM reigns`);
    db.run(`DELETE FROM queue`);
    db.run(`DELETE FROM admin_notifications`);
    db.run(`DELETE FROM payouts`);

    // Reset state config
    setConfig('current_king_id', '');
    setConfig('current_reign_id', '');
    setConfig('current_game_id', '');

    save();
    console.log('🧹 Event data reset complete — all stats, games, and reigns cleared');
}

function createTables() {
    db.run(`
        CREATE TABLE IF NOT EXISTS players (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            pin TEXT DEFAULT '',
            auth_type TEXT DEFAULT 'pin',
            auth_id TEXT,
            session_token TEXT,
            sat_balance INTEGER DEFAULT 0,
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
            created_at TEXT DEFAULT (datetime('now')),
            last_seen_at TEXT DEFAULT (datetime('now'))
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id INTEGER NOT NULL,
            position INTEGER NOT NULL,
            status TEXT DEFAULT 'waiting',
            timeout_count INTEGER DEFAULT 0,
            on_deck_since TEXT,
            joined_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (player_id) REFERENCES players(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS games (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            king_id INTEGER NOT NULL,
            challenger_id INTEGER NOT NULL,
            chess960_position INTEGER NOT NULL,
            started_at TEXT DEFAULT (datetime('now')),
            ended_at TEXT,
            king_reported TEXT,
            challenger_reported TEXT,
            result TEXT,
            sats_earned INTEGER DEFAULT 0,
            reign_id INTEGER,
            FOREIGN KEY (king_id) REFERENCES players(id),
            FOREIGN KEY (challenger_id) REFERENCES players(id),
            FOREIGN KEY (reign_id) REFERENCES reigns(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS reigns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            king_id INTEGER NOT NULL,
            crowned_at TEXT DEFAULT (datetime('now')),
            dethroned_at TEXT,
            total_reign_seconds REAL DEFAULT 0,
            total_sats_earned INTEGER DEFAULT 0,
            consecutive_wins INTEGER DEFAULT 0,
            games_played INTEGER DEFAULT 0,
            FOREIGN KEY (king_id) REFERENCES players(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS payouts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id INTEGER NOT NULL,
            amount_sats INTEGER NOT NULL,
            lightning_address TEXT,
            payment_hash TEXT,
            status TEXT DEFAULT 'pending',
            error_message TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            completed_at TEXT,
            FOREIGN KEY (player_id) REFERENCES players(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS venue_codes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL UNIQUE,
            created_at TEXT DEFAULT (datetime('now')),
            expires_at TEXT,
            is_active INTEGER DEFAULT 1
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS admin_notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            message TEXT NOT NULL,
            game_id INTEGER,
            resolved INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);

    // Board names for multi-board viewer (stream operator assigns player names to DGT boards)
    db.run(`
        CREATE TABLE IF NOT EXISTS board_names (
            board_num INTEGER PRIMARY KEY,
            serial_nr TEXT,
            white_name TEXT DEFAULT '',
            black_name TEXT DEFAULT ''
        )
    `);

    // Board ordering — maps serial numbers to display positions
    db.run(`
        CREATE TABLE IF NOT EXISTS board_order (
            serial_nr TEXT PRIMARY KEY,
            sort_position INTEGER NOT NULL
        )
    `);

    // Player name history for autocomplete
    db.run(`
        CREATE TABLE IF NOT EXISTS board_name_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            used_count INTEGER DEFAULT 1,
            last_used_at TEXT DEFAULT (datetime('now'))
        )
    `);
}

function migrateSchema() {
    // Add auth_type and auth_id columns if they don't exist (for existing databases)
    try {
        const tableInfo = db.exec(`PRAGMA table_info(players)`);
        if (tableInfo.length > 0) {
            const columns = tableInfo[0].values.map(row => row[1]);
            if (!columns.includes('auth_type')) {
                db.run(`ALTER TABLE players ADD COLUMN auth_type TEXT DEFAULT 'pin'`);
                console.log('🔧 Migration: Added auth_type column to players');
            }
            if (!columns.includes('auth_id')) {
                db.run(`ALTER TABLE players ADD COLUMN auth_id TEXT`);
                console.log('🔧 Migration: Added auth_id column to players');
            }
            if (!columns.includes('email')) {
                db.run(`ALTER TABLE players ADD COLUMN email TEXT`);
                console.log('🔧 Migration: Added email column to players');
            }
            if (!columns.includes('telegram_chat_id')) {
                db.run(`ALTER TABLE players ADD COLUMN telegram_chat_id TEXT`);
                console.log('🔧 Migration: Added telegram_chat_id column to players');
            }
        }

        // Games table migrations
        const gamesInfo = db.exec(`PRAGMA table_info(games)`);
        if (gamesInfo.length > 0) {
            const gameCols = gamesInfo[0].values.map(row => row[1]);
            if (!gameCols.includes('king_color')) {
                db.run(`ALTER TABLE games ADD COLUMN king_color TEXT`);
                console.log('🔧 Migration: Added king_color column to games');
            }
        }
    } catch (err) {
        console.log('Migration check (non-critical):', err.message);
    }
}

function seedConfig() {
    const defaults = {
        sat_rate_per_second: '21',
        time_control_base: '180',
        time_control_increment: '2',
        queue_timeout_seconds: '30',
        winner_only_confirm_delay: '60',
        venue_code_rotation_minutes: '30',
        event_active: 'false',
        current_king_id: '',
        current_reign_id: '',
        current_game_id: '',
    };

    for (const [key, value] of Object.entries(defaults)) {
        const existing = db.exec(`SELECT value FROM config WHERE key = ?`, [key]);
        if (existing.length === 0 || existing[0].values.length === 0) {
            db.run(`INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)`, [key, value]);
        }
    }
}

// ============================================================
// Config helpers
// ============================================================

function getConfig(key) {
    const result = db.exec(`SELECT value FROM config WHERE key = ?`, [key]);
    if (result.length === 0 || result[0].values.length === 0) return null;
    return result[0].values[0][0];
}

function setConfig(key, value) {
    db.run(`INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`, [key, String(value)]);
    save();
}

function getAllConfig() {
    const result = db.exec(`SELECT key, value FROM config ORDER BY key`);
    if (result.length === 0) return {};
    const config = {};
    for (const row of result[0].values) {
        config[row[0]] = row[1];
    }
    return config;
}

// ============================================================
// Player operations
// ============================================================

function createPlayer(name, pin) {
    db.run(`INSERT INTO players (name, pin) VALUES (?, ?)`, [name, pin]);
    const result = db.exec(`SELECT last_insert_rowid()`);
    const id = result[0].values[0][0];
    save();
    return id;
}

function createPlayerWithAuth(authType, authId) {
    db.run(`INSERT INTO players (auth_type, auth_id, pin) VALUES (?, ?, '')`, [authType, authId]);
    const result = db.exec(`SELECT last_insert_rowid()`);
    const id = result[0].values[0][0];
    save();
    return id;
}

function getPlayerByAuthId(authType, authId) {
    const result = db.exec(`SELECT * FROM players WHERE auth_type = ? AND auth_id = ?`, [authType, authId]);
    if (result.length === 0 || result[0].values.length === 0) return null;
    return rowToObject(result[0]);
}

function setPlayerName(playerId, name) {
    db.run(`UPDATE players SET name = ? WHERE id = ?`, [name, playerId]);
    save();
}

function setPlayerEmail(playerId, email) {
    db.run(`UPDATE players SET email = ? WHERE id = ?`, [email || null, playerId]);
    save();
}

function setPlayerTelegramChatId(playerId, chatId) {
    db.run(`UPDATE players SET telegram_chat_id = ? WHERE id = ?`, [chatId || null, playerId]);
    save();
}

function getPlayerByTelegramChatId(chatId) {
    const result = db.exec(`SELECT * FROM players WHERE telegram_chat_id = ?`, [chatId]);
    if (result.length === 0 || result[0].values.length === 0) return null;
    return rowToObject(result[0]);
}

// Merge two player accounts: absorb source into target, delete source
function mergeAccounts(targetPlayerId, sourcePlayerId) {
    const target = getPlayerById(targetPlayerId);
    const source = getPlayerById(sourcePlayerId);
    if (!target || !source) throw new Error('Both players must exist');
    if (targetPlayerId === sourcePlayerId) throw new Error('Cannot merge a player with themselves');

    // Transfer sat balance
    db.run(`UPDATE players SET sat_balance = sat_balance + ? WHERE id = ?`, [source.sat_balance, targetPlayerId]);

    // Reassign all games where source was king or challenger
    db.run(`UPDATE games SET king_id = ? WHERE king_id = ?`, [targetPlayerId, sourcePlayerId]);
    db.run(`UPDATE games SET challenger_id = ? WHERE challenger_id = ?`, [targetPlayerId, sourcePlayerId]);

    // Reassign reigns, queue, payouts
    db.run(`UPDATE reigns SET king_id = ? WHERE king_id = ?`, [targetPlayerId, sourcePlayerId]);
    db.run(`UPDATE queue SET player_id = ? WHERE player_id = ?`, [targetPlayerId, sourcePlayerId]);
    db.run(`UPDATE payouts SET player_id = ? WHERE player_id = ?`, [targetPlayerId, sourcePlayerId]);

    // Recalculate aggregate stats from games
    const stats = db.exec(`
        SELECT 
            COUNT(*) as games_played,
            SUM(CASE WHEN (king_id = ? AND result = 'king_won') OR (challenger_id = ? AND result = 'challenger_won') THEN 1 ELSE 0 END) as games_won,
            SUM(CASE WHEN (king_id = ? AND result = 'challenger_won') OR (challenger_id = ? AND result = 'king_won') THEN 1 ELSE 0 END) as games_lost,
            SUM(CASE WHEN result = 'draw' THEN 1 ELSE 0 END) as games_drawn,
            SUM(CASE WHEN king_id = ? THEN 1 ELSE 0 END) as times_as_king,
            COALESCE(SUM(CASE WHEN king_id = ? THEN sats_earned ELSE 0 END), 0) as total_sats_earned
        FROM games 
        WHERE (king_id = ? OR challenger_id = ?) AND result IS NOT NULL AND result != 'no_show'
    `, [targetPlayerId, targetPlayerId, targetPlayerId, targetPlayerId, targetPlayerId, targetPlayerId, targetPlayerId, targetPlayerId]);

    if (stats.length > 0 && stats[0].values.length > 0) {
        const s = stats[0].values[0];
        db.run(`UPDATE players SET games_played = ?, games_won = ?, games_lost = ?, games_drawn = ?, times_as_king = ?, total_sats_earned = ? WHERE id = ?`,
            [s[0], s[1], s[2], s[3], s[4], s[5], targetPlayerId]);
    }

    // Delete source player
    db.run(`DELETE FROM players WHERE id = ?`, [sourcePlayerId]);
    save();

    return { success: true, message: `Merged player #${sourcePlayerId} (${source.name}) into #${targetPlayerId} (${target.name})` };
}


function getPlayerById(id) {
    const result = db.exec(`SELECT * FROM players WHERE id = ?`, [id]);
    if (result.length === 0 || result[0].values.length === 0) return null;
    return rowToObject(result[0]);
}

function getPlayerByName(name) {
    const result = db.exec(`SELECT * FROM players WHERE LOWER(name) = LOWER(?)`, [name]);
    if (result.length === 0 || result[0].values.length === 0) return null;
    return rowToObject(result[0]);
}

function getPlayerBySession(token) {
    const result = db.exec(`SELECT * FROM players WHERE session_token = ?`, [token]);
    if (result.length === 0 || result[0].values.length === 0) return null;
    return rowToObject(result[0]);
}

function setPlayerSession(playerId, token) {
    db.run(`UPDATE players SET session_token = ?, last_seen_at = datetime('now') WHERE id = ?`, [token, playerId]);
    save();
}

function updatePlayerStats(playerId, updates) {
    const sets = [];
    const values = [];
    for (const [key, value] of Object.entries(updates)) {
        sets.push(`${key} = ?`);
        values.push(value);
    }
    values.push(playerId);
    db.run(`UPDATE players SET ${sets.join(', ')} WHERE id = ?`, values);
    save();
}

function addSatsToPlayer(playerId, sats) {
    db.run(`UPDATE players SET sat_balance = sat_balance + ?, total_sats_earned = total_sats_earned + ? WHERE id = ?`, [sats, sats, playerId]);
    save();
}

function deductSatsFromPlayer(playerId, sats) {
    db.run(`UPDATE players SET sat_balance = sat_balance - ?, total_sats_claimed = total_sats_claimed + ? WHERE id = ?`, [sats, sats, playerId]);
    save();
}

function getAllPlayers() {
    const result = db.exec(`SELECT * FROM players ORDER BY total_sats_earned DESC`);
    if (result.length === 0) return [];
    return rowsToObjects(result[0]);
}

function getLeaderboard() {
    const result = db.exec(`
        SELECT id, name, total_sats_earned, games_played, games_won, games_lost, games_drawn,
               times_as_king, total_reign_seconds, longest_reign_seconds, longest_win_streak
        FROM players 
        WHERE games_played > 0
        ORDER BY total_sats_earned DESC
        LIMIT 50
    `);
    if (result.length === 0) return [];
    return rowsToObjects(result[0]);
}

// ============================================================
// Queue operations
// ============================================================

function addToQueue(playerId) {
    // Get max position
    const maxResult = db.exec(`SELECT COALESCE(MAX(position), 0) FROM queue WHERE status IN ('waiting', 'on_deck')`);
    const maxPos = maxResult[0].values[0][0];
    db.run(`INSERT INTO queue (player_id, position, status, timeout_count) VALUES (?, ?, 'waiting', 0)`, [playerId, maxPos + 1]);
    const result = db.exec(`SELECT last_insert_rowid()`);
    const id = result[0].values[0][0];
    save();
    return id;
}

function insertIntoQueue(playerId, position) {
    // Bump all existing entries at or after the target position
    db.run(`UPDATE queue SET position = position + 1 WHERE position >= ? AND status IN ('waiting', 'on_deck')`, [position]);
    // Insert at the target position
    db.run(`INSERT INTO queue (player_id, position, status, timeout_count) VALUES (?, ?, 'waiting', 0)`, [playerId, position]);
    const result = db.exec(`SELECT last_insert_rowid()`);
    const id = result[0].values[0][0];
    save();
    return id;
}

function getQueue() {
    const result = db.exec(`
        SELECT q.*, p.name as player_name 
        FROM queue q 
        JOIN players p ON q.player_id = p.id 
        WHERE q.status IN ('waiting', 'on_deck')
        ORDER BY q.position ASC
    `);
    if (result.length === 0) return [];
    return rowsToObjects(result[0]);
}

function getQueueEntry(playerId) {
    const result = db.exec(`
        SELECT q.*, p.name as player_name
        FROM queue q 
        JOIN players p ON q.player_id = p.id 
        WHERE q.player_id = ? AND q.status IN ('waiting', 'on_deck')
    `, [playerId]);
    if (result.length === 0 || result[0].values.length === 0) return null;
    return rowToObject(result[0]);
}

function getNextInQueue() {
    const result = db.exec(`
        SELECT q.*, p.name as player_name
        FROM queue q 
        JOIN players p ON q.player_id = p.id 
        WHERE q.status = 'waiting'
        ORDER BY q.position ASC
        LIMIT 1
    `);
    if (result.length === 0 || result[0].values.length === 0) return null;
    return rowToObject(result[0]);
}

function getOnDeckPlayer() {
    const result = db.exec(`
        SELECT q.*, p.name as player_name
        FROM queue q 
        JOIN players p ON q.player_id = p.id 
        WHERE q.status = 'on_deck'
        LIMIT 1
    `);
    if (result.length === 0 || result[0].values.length === 0) return null;
    return rowToObject(result[0]);
}

function setOnDeck(queueId) {
    db.run(`UPDATE queue SET status = 'on_deck', on_deck_since = datetime('now') WHERE id = ?`, [queueId]);
    save();
}

function removeFromQueue(queueId) {
    db.run(`DELETE FROM queue WHERE id = ?`, [queueId]);
    // Recompact positions
    const queue = getQueue();
    queue.forEach((entry, index) => {
        db.run(`UPDATE queue SET position = ? WHERE id = ?`, [index + 1, entry.id]);
    });
    save();
}

function sendToBackOfQueue(queueId) {
    const entry = db.exec(`SELECT * FROM queue WHERE id = ?`, [queueId]);
    if (entry.length === 0 || entry[0].values.length === 0) return;
    const obj = rowToObject(entry[0]);
    
    const maxResult = db.exec(`SELECT COALESCE(MAX(position), 0) FROM queue WHERE status IN ('waiting', 'on_deck')`);
    const maxPos = maxResult[0].values[0][0];
    
    db.run(`UPDATE queue SET status = 'waiting', position = ?, on_deck_since = NULL, timeout_count = ? WHERE id = ?`, 
        [maxPos + 1, obj.timeout_count + 1, queueId]);
    
    // Recompact positions
    const queue = getQueue();
    queue.forEach((entry, index) => {
        db.run(`UPDATE queue SET position = ? WHERE id = ?`, [index + 1, entry.id]);
    });
    save();
}

function resetOnDeckToWaiting() {
    db.run(`UPDATE queue SET status = 'waiting', on_deck_since = NULL WHERE status = 'on_deck'`);
    save();
}

function moveToFrontOfQueue(queueId) {
    // Set this entry's position to 0 (before everyone), then recompact
    db.run(`UPDATE queue SET position = 0 WHERE id = ?`, [queueId]);
    const queue = getQueue();
    queue.forEach((entry, index) => {
        db.run(`UPDATE queue SET position = ? WHERE id = ?`, [index + 1, entry.id]);
    });
    save();
}

function removePlayerFromQueue(playerId) {
    db.run(`DELETE FROM queue WHERE player_id = ? AND status IN ('waiting', 'on_deck')`, [playerId]);
    // Recompact
    const queue = getQueue();
    queue.forEach((entry, index) => {
        db.run(`UPDATE queue SET position = ? WHERE id = ?`, [index + 1, entry.id]);
    });
    save();
}

function isPlayerInQueue(playerId) {
    const result = db.exec(`SELECT id FROM queue WHERE player_id = ? AND status IN ('waiting', 'on_deck')`, [playerId]);
    return result.length > 0 && result[0].values.length > 0;
}

/**
 * Replace the entire queue with a new ordered list of player IDs.
 * Clears all existing queue entries and inserts the given players in order.
 * @param {number[]} playerIds - Array of player IDs in desired queue order
 */
function reorderQueue(playerIds) {
    // Clear the entire queue
    db.run(`DELETE FROM queue WHERE status IN ('waiting', 'on_deck')`);
    // Insert each player in order
    playerIds.forEach((playerId, index) => {
        db.run(`INSERT INTO queue (player_id, position, status, timeout_count) VALUES (?, ?, 'waiting', 0)`, [playerId, index + 1]);
    });
    save();
}

// ============================================================
// Game operations
// ============================================================

function createGame(kingId, challengerId, chess960Position, reignId, kingColor = null) {
    // King always plays black
    kingColor = 'black';
    db.run(`INSERT INTO games (king_id, challenger_id, chess960_position, reign_id, king_color) VALUES (?, ?, ?, ?, ?)`,
        [kingId, challengerId, chess960Position, reignId, kingColor]);
    const result = db.exec(`SELECT last_insert_rowid()`);
    const id = result[0].values[0][0];
    save();
    return id;
}

function getGameById(id) {
    const result = db.exec(`
        SELECT g.*, 
               k.name as king_name, 
               c.name as challenger_name
        FROM games g
        JOIN players k ON g.king_id = k.id
        JOIN players c ON g.challenger_id = c.id
        WHERE g.id = ?
    `, [id]);
    if (result.length === 0 || result[0].values.length === 0) return null;
    return rowToObject(result[0]);
}

function getActiveGame() {
    const gameId = getConfig('current_game_id');
    if (!gameId) return null;
    return getGameById(parseInt(gameId));
}

function reportGameResult(gameId, reporterId, result) {
    const game = getGameById(gameId);
    if (!game) return null;

    if (reporterId === game.king_id) {
        db.run(`UPDATE games SET king_reported = ? WHERE id = ?`, [result, gameId]);
    } else if (reporterId === game.challenger_id) {
        db.run(`UPDATE games SET challenger_reported = ? WHERE id = ?`, [result, gameId]);
    }
    save();

    // Re-fetch to check both reports
    return getGameById(gameId);
}

function clearGameReports(gameId) {
    db.run(`UPDATE games SET king_reported = NULL, challenger_reported = NULL WHERE id = ?`, [gameId]);
    save();
}

function finalizeGame(gameId, result, satsEarned) {
    db.run(`UPDATE games SET result = ?, sats_earned = ?, ended_at = datetime('now') WHERE id = ?`,
        [result, satsEarned, gameId]);
    save();
}

function getRecentGames(limit = 20) {
    const result = db.exec(`
        SELECT g.*, 
               k.name as king_name, 
               c.name as challenger_name
        FROM games g
        JOIN players k ON g.king_id = k.id
        JOIN players c ON g.challenger_id = c.id
        WHERE g.result IS NOT NULL
        ORDER BY g.ended_at DESC
        LIMIT ?
    `, [limit]);
    if (result.length === 0) return [];
    return rowsToObjects(result[0]);
}

function getPlayerGames(playerId, limit = 50) {
    const result = db.exec(`
        SELECT g.*, 
               k.name as king_name, 
               c.name as challenger_name
        FROM games g
        JOIN players k ON g.king_id = k.id
        JOIN players c ON g.challenger_id = c.id
        WHERE (g.king_id = ? OR g.challenger_id = ?) AND g.result IS NOT NULL
        ORDER BY g.ended_at DESC
        LIMIT ?
    `, [playerId, playerId, limit]);
    if (result.length === 0) return [];
    return rowsToObjects(result[0]);
}

// ============================================================
// Reign operations
// ============================================================

function createReign(kingId, crownedAt = null) {
    if (crownedAt) {
        db.run(`INSERT INTO reigns (king_id, crowned_at) VALUES (?, ?)`, [kingId, crownedAt]);
    } else {
        db.run(`INSERT INTO reigns (king_id) VALUES (?)`, [kingId]);
    }
    const result = db.exec(`SELECT last_insert_rowid()`);
    const id = result[0].values[0][0];
    save();
    return id;
}

function getReignById(id) {
    const result = db.exec(`
        SELECT r.*, p.name as king_name
        FROM reigns r
        JOIN players p ON r.king_id = p.id
        WHERE r.id = ?
    `, [id]);
    if (result.length === 0 || result[0].values.length === 0) return null;
    return rowToObject(result[0]);
}

function updateReign(reignId, updates) {
    const sets = [];
    const values = [];
    for (const [key, value] of Object.entries(updates)) {
        sets.push(`${key} = ?`);
        values.push(value);
    }
    values.push(reignId);
    db.run(`UPDATE reigns SET ${sets.join(', ')} WHERE id = ?`, values);
    save();
}

function endReign(reignId, totalSeconds, totalSats, dethronedAt = null) {
    if (dethronedAt) {
        db.run(`UPDATE reigns SET dethroned_at = ?, total_reign_seconds = ?, total_sats_earned = ? WHERE id = ?`,
            [dethronedAt, totalSeconds, totalSats, reignId]);
    } else {
        db.run(`UPDATE reigns SET dethroned_at = datetime('now'), total_reign_seconds = ?, total_sats_earned = ? WHERE id = ?`,
            [totalSeconds, totalSats, reignId]);
    }
    save();
}

function getLongestReigns(limit = 10) {
    const result = db.exec(`
        SELECT r.*, p.name as king_name
        FROM reigns r
        JOIN players p ON r.king_id = p.id
        WHERE r.dethroned_at IS NOT NULL
        ORDER BY r.total_reign_seconds DESC
        LIMIT ?
    `, [limit]);
    if (result.length === 0) return [];
    return rowsToObjects(result[0]);
}

function getCurrentReign() {
    const reignId = getConfig('current_reign_id');
    if (!reignId) return null;
    return getReignById(parseInt(reignId));
}

// ============================================================
// Venue Code operations
// ============================================================

function createVenueCode(code, expiresAt) {
    // Deactivate all existing codes
    db.run(`UPDATE venue_codes SET is_active = 0`);
    db.run(`INSERT INTO venue_codes (code, expires_at) VALUES (?, ?)`, [code, expiresAt]);
    save();
}

function getActiveVenueCode() {
    const result = db.exec(`
        SELECT * FROM venue_codes 
        WHERE is_active = 1 
        ORDER BY created_at DESC 
        LIMIT 1
    `);
    if (result.length === 0 || result[0].values.length === 0) return null;
    return rowToObject(result[0]);
}

function validateVenueCode(code) {
    const active = getActiveVenueCode();
    if (!active) return false;
    if (active.code !== code) return false;
    // Don't check expires_at here — if the code is is_active=1, it's valid.
    // Expiry only controls when rotation happens, not validation.
    // The throne page displays the active code's QR, so rejecting an active
    // code due to expiry creates an impossible "invalid code" state.
    return true;
}

// ============================================================
// Notification operations
// ============================================================

function createNotification(type, message, gameId = null) {
    db.run(`INSERT INTO admin_notifications (type, message, game_id) VALUES (?, ?, ?)`,
        [type, message, gameId]);
    save();
}

function getUnresolvedNotifications() {
    const result = db.exec(`
        SELECT * FROM admin_notifications 
        WHERE resolved = 0 
        ORDER BY created_at DESC
    `);
    if (result.length === 0) return [];
    return rowsToObjects(result[0]);
}

function resolveNotification(id) {
    db.run(`UPDATE admin_notifications SET resolved = 1 WHERE id = ?`, [id]);
    save();
}

function resolveAllNotifications() {
    db.run(`UPDATE admin_notifications SET resolved = 1 WHERE resolved = 0`);
    save();
}

// ============================================================
// Payout operations
// ============================================================

function createPayout(playerId, amountSats, lightningAddress) {
    db.run(`INSERT INTO payouts (player_id, amount_sats, lightning_address) VALUES (?, ?, ?)`,
        [playerId, amountSats, lightningAddress]);
    const result = db.exec(`SELECT last_insert_rowid()`);
    const id = result[0].values[0][0];
    save();
    return id;
}

function updatePayout(payoutId, updates) {
    const sets = [];
    const values = [];
    for (const [key, value] of Object.entries(updates)) {
        sets.push(`${key} = ?`);
        values.push(value);
    }
    values.push(payoutId);
    db.run(`UPDATE payouts SET ${sets.join(', ')} WHERE id = ?`, values);
    save();
}

function getPayoutById(payoutId) {
    const result = db.exec(`SELECT * FROM payouts WHERE id = ?`, [payoutId]);
    if (!result.length || !result[0].values.length) return null;
    const cols = result[0].columns;
    const row = result[0].values[0];
    const obj = {};
    cols.forEach((c, i) => obj[c] = row[i]);
    return obj;
}

function getPlayerPayouts(playerId) {
    const result = db.exec(`SELECT * FROM payouts WHERE player_id = ? ORDER BY created_at DESC`, [playerId]);
    if (result.length === 0) return [];
    return rowsToObjects(result[0]);
}

function getAllPayouts() {
    const result = db.exec(`
        SELECT p.*, pl.name as player_name
        FROM payouts p
        JOIN players pl ON p.player_id = pl.id
        ORDER BY p.created_at DESC
    `);
    if (result.length === 0) return [];
    return rowsToObjects(result[0]);
}

function getPendingPayouts() {
    const result = db.exec(`
        SELECT p.*, pl.name as player_name
        FROM payouts p
        JOIN players pl ON p.player_id = pl.id
        WHERE p.status = 'pending' OR p.status = 'paying'
        ORDER BY p.created_at ASC
    `);
    if (result.length === 0) return [];
    return rowsToObjects(result[0]);
}

function getReconciledFailedPayouts() {
    const result = db.exec(`
        SELECT p.*, pl.name as player_name
        FROM payouts p
        JOIN players pl ON p.player_id = pl.id
        WHERE p.status = 'failed' AND p.error_message LIKE 'Reconciled%'
        ORDER BY p.created_at ASC
    `);
    if (result.length === 0) return [];
    return rowsToObjects(result[0]);
}

function getCompletedPayouts() {
    const result = db.exec(`
        SELECT p.*, pl.name as player_name
        FROM payouts p
        JOIN players pl ON p.player_id = pl.id
        WHERE p.status = 'completed'
        ORDER BY p.created_at ASC
    `);
    if (result.length === 0) return [];
    return rowsToObjects(result[0]);
}

/**
 * Reverse a payout that was falsely marked completed.
 * Restores the player's sat_balance and total_sats_claimed, marks payout as 'reversed'.
 */
function refundPayout(payoutId, amountSats, playerId, reason) {
    db.run(`UPDATE players SET sat_balance = sat_balance + ?, total_sats_claimed = total_sats_claimed - ? WHERE id = ?`,
        [amountSats, amountSats, playerId]);
    db.run(`UPDATE payouts SET status = 'reversed', error_message = ? WHERE id = ?`,
        [reason || 'Reversed: LND payment actually failed', payoutId]);
    save();
}

// ============================================================
// Stats
// ============================================================

function getTimelineData() {
    // Get all finalized games in chronological order with reign info
    const gamesResult = db.exec(`
        SELECT g.id, g.king_id, g.challenger_id, g.chess960_position, g.king_color,
               g.started_at, g.ended_at, g.result, g.sats_earned, g.reign_id,
               k.name as king_name, c.name as challenger_name
        FROM games g
        JOIN players k ON g.king_id = k.id
        JOIN players c ON g.challenger_id = c.id
        WHERE g.result IS NOT NULL AND g.result != 'no_show'
        ORDER BY g.started_at ASC
    `);
    const games = gamesResult.length > 0 ? rowsToObjects(gamesResult[0]) : [];

    // Get all reigns in chronological order
    const reignsResult = db.exec(`
        SELECT r.id, r.king_id, r.crowned_at, r.dethroned_at,
               r.total_reign_seconds, r.total_sats_earned, r.consecutive_wins, r.games_played,
               p.name as king_name
        FROM reigns r
        JOIN players p ON r.king_id = p.id
        ORDER BY r.crowned_at ASC
    `);
    const reigns = reignsResult.length > 0 ? rowsToObjects(reignsResult[0]) : [];

    // Summary stats
    const totalGames = games.length;
    const totalKings = reigns.length;
    const longestReign = reigns.reduce((max, r) => 
        (r.total_reign_seconds || 0) > (max?.total_reign_seconds || 0) ? r : max, null);
    const mostWinsInReign = reigns.reduce((max, r) =>
        (r.consecutive_wins || 0) > (max?.consecutive_wins || 0) ? r : max, null);

    return { games, reigns, totalGames, totalKings, longestReign, mostWinsInReign };
}

function getEventStats() {
    const totalGames = db.exec(`SELECT COUNT(*) FROM games WHERE result IS NOT NULL`);
    const totalPlayers = db.exec(`SELECT COUNT(*) FROM players WHERE games_played > 0`);
    const totalSats = db.exec(`SELECT COALESCE(SUM(total_sats_earned), 0) FROM players`);
    const totalReigns = db.exec(`SELECT COUNT(*) FROM reigns`);
    const uniqueKings = db.exec(`SELECT COUNT(DISTINCT king_id) FROM reigns`);
    
    return {
        totalGames: totalGames[0]?.values[0][0] || 0,
        totalPlayers: totalPlayers[0]?.values[0][0] || 0,
        totalSatsDistributed: totalSats[0]?.values[0][0] || 0,
        totalReigns: totalReigns[0]?.values[0][0] || 0,
        uniqueKings: uniqueKings[0]?.values[0][0] || 0,
    };
}

/**
 * Accounting audit: verify total sats credited to players matches
 * total throne-occupied seconds × sat_rate.
 * Returns detailed breakdown for admin.
 */
function getAccountingAudit(satRate) {
    // Sum of all sats credited to players (total_sats_earned)
    const playerSatsResult = db.exec(`SELECT COALESCE(SUM(total_sats_earned), 0) FROM players`);
    const claimedSatsResult = db.exec(`SELECT COALESCE(SUM(total_sats_claimed), 0) FROM players`);
    const totalSatsClaimed = claimedSatsResult[0]?.values[0][0] || 0;
    const totalPlayerSats = playerSatsResult[0]?.values[0][0] || 0;

    // Sum of all completed reign sats
    const completedReignsResult = db.exec(`SELECT COALESCE(SUM(total_sats_earned), 0), COALESCE(SUM(total_reign_seconds), 0), COUNT(*) FROM reigns WHERE dethroned_at IS NOT NULL`);
    const completedReignSats = completedReignsResult[0]?.values[0][0] || 0;
    const completedReignSeconds = completedReignsResult[0]?.values[0][1] || 0;
    const completedReignCount = completedReignsResult[0]?.values[0][2] || 0;

    // Current active reign
    const currentReignId = getConfig('current_reign_id');
    let activeReignSats = 0;
    let activeReignSeconds = 0;
    if (currentReignId) {
        const reign = getReignById(parseInt(currentReignId));
        if (reign && !reign.dethroned_at) {
            activeReignSeconds = (Date.now() - new Date(reign.crowned_at).getTime()) / 1000;
            activeReignSats = Math.floor(activeReignSeconds) * satRate;
        }
    }

    // Expected total = sum of per-reign sats (each reign floors seconds individually)
    // This matches how sats are actually credited: Math.floor(reignSeconds) * satRate per reign.
    // Using Math.floor(totalSeconds) * satRate would overestimate due to accumulated fractional seconds.
    const totalThroneSeconds = completedReignSeconds + activeReignSeconds;
    const expectedTotalSats = completedReignSats + activeReignSats;

    // Discrepancy = expected - actual (positive = player got too few)
    const discrepancy = expectedTotalSats - totalPlayerSats;

    return {
        totalPlayerSats,
        totalSatsClaimed,
        completedReignSats,
        completedReignCount,
        completedReignSeconds: Math.floor(completedReignSeconds),
        activeReignSats,
        activeReignSeconds: Math.floor(activeReignSeconds),
        totalThroneSeconds: Math.floor(totalThroneSeconds),
        expectedTotalSats,
        discrepancy,
        isClean: discrepancy === 0, // with per-reign accounting, there should be zero discrepancy
    };
}

// ============================================================
// Board Name operations (multi-board viewer)
// ============================================================

function setBoardNames(boardNum, whiteName, blackName, serialNr) {
    db.run(`INSERT OR REPLACE INTO board_names (board_num, serial_nr, white_name, black_name) VALUES (?, ?, ?, ?)`,
        [boardNum, serialNr || '', whiteName || '', blackName || '']);
    // Track names for autocomplete
    if (whiteName) addNameToHistory(whiteName);
    if (blackName) addNameToHistory(blackName);
    save();
}

function getBoardNames(boardNum) {
    const result = db.exec(`SELECT * FROM board_names WHERE board_num = ?`, [boardNum]);
    if (result.length === 0 || result[0].values.length === 0) return null;
    return rowToObject(result[0]);
}

function getAllBoardNames() {
    const result = db.exec(`SELECT * FROM board_names ORDER BY board_num`);
    if (result.length === 0) return [];
    return rowsToObjects(result[0]);
}

function clearAllBoardNames() {
    db.run(`DELETE FROM board_names`);
    save();
}

function addNameToHistory(name) {
    const trimmed = name.trim();
    if (!trimmed) return;
    db.run(`INSERT INTO board_name_history (name, used_count, last_used_at) VALUES (?, 1, datetime('now'))
            ON CONFLICT(name) DO UPDATE SET used_count = used_count + 1, last_used_at = datetime('now')`,
        [trimmed]);
}

function searchNameHistory(query) {
    if (!query || query.length < 1) return [];
    const result = db.exec(`SELECT name FROM board_name_history WHERE name LIKE ? ORDER BY used_count DESC, last_used_at DESC LIMIT 10`,
        ['%' + query + '%']);
    if (result.length === 0) return [];
    return result[0].values.map(r => r[0]);
}

// ============================================================
// Board Order operations (custom serial → position mapping)
// ============================================================

/**
 * Get custom board order. Returns { serialNr: sortPosition } map.
 * Empty = no custom order (use default alphabetical serial sort).
 */
function getBoardOrder() {
    const result = db.exec(`SELECT serial_nr, sort_position FROM board_order ORDER BY sort_position`);
    if (result.length === 0) return {};
    const order = {};
    result[0].values.forEach(row => { order[row[0]] = row[1]; });
    return order;
}

/**
 * Save custom board order. Takes array of serial numbers in desired order.
 * Clears existing order and inserts new positions.
 */
function saveBoardOrder(orderedSerials) {
    db.run(`DELETE FROM board_order`);
    orderedSerials.forEach((serial, i) => {
        db.run(`INSERT INTO board_order (serial_nr, sort_position) VALUES (?, ?)`, [serial, i + 1]);
    });
    save();
}

function clearBoardOrder() {
    db.run(`DELETE FROM board_order`);
    save();
}

// ============================================================
// Utility helpers
// ============================================================

function rowToObject(result) {
    if (!result || !result.columns || !result.values || result.values.length === 0) return null;
    const obj = {};
    result.columns.forEach((col, i) => {
        obj[col] = result.values[0][i];
    });
    return obj;
}

function rowsToObjects(result) {
    if (!result || !result.columns || !result.values) return [];
    return result.values.map(row => {
        const obj = {};
        result.columns.forEach((col, i) => {
            obj[col] = row[i];
        });
        return obj;
    });
}

module.exports = {
    initialize,
    save,
    backupDatabase,
    resetEventData,
    getConfig,
    setConfig,
    getAllConfig,
    
    // Players
    createPlayer,
    createPlayerWithAuth,
    getPlayerByAuthId,
    setPlayerName,
    setPlayerEmail,
    setPlayerTelegramChatId,
    getPlayerByTelegramChatId,
    mergeAccounts,
    getPlayerById,
    getPlayerByName,
    getPlayerBySession,
    setPlayerSession,
    updatePlayerStats,
    addSatsToPlayer,
    deductSatsFromPlayer,
    getAllPlayers,
    getLeaderboard,
    
    // Queue
    addToQueue,
    insertIntoQueue,
    getQueue,
    getQueueEntry,
    getNextInQueue,
    getOnDeckPlayer,
    setOnDeck,
    removeFromQueue,
    sendToBackOfQueue,
    moveToFrontOfQueue,
    resetOnDeckToWaiting,
    removePlayerFromQueue,
    isPlayerInQueue,
    reorderQueue,
    
    // Games
    createGame,
    getGameById,
    getActiveGame,
    reportGameResult,
    clearGameReports,
    finalizeGame,
    getRecentGames,
    getPlayerGames,
    
    // Reigns
    createReign,
    getReignById,
    updateReign,
    endReign,
    getLongestReigns,
    getCurrentReign,
    
    // Venue codes
    createVenueCode,
    getActiveVenueCode,
    validateVenueCode,
    
    // Notifications
    createNotification,
    getUnresolvedNotifications,
    resolveNotification,
    resolveAllNotifications,
    
    // Payouts
    createPayout,
    updatePayout,
    getPayoutById,
    getPlayerPayouts,
    getAllPayouts,
    getPendingPayouts,
    getReconciledFailedPayouts,
    getCompletedPayouts,
    refundPayout,
    
    // Stats
    getEventStats,
    getAccountingAudit,
    getTimelineData,

    // Backup
    getExportBuffer,

    // Board Names
    setBoardNames,
    getBoardNames,
    getAllBoardNames,
    clearAllBoardNames,
    searchNameHistory,

    // Board Order
    getBoardOrder,
    saveBoardOrder,
    clearBoardOrder,
};
