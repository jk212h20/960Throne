/**
 * Telegram notification service for 960 Throne
 * 
 * Two roles:
 * 1. Admin notifications (game events → admin's chat ID from env)
 * 2. Player notifications (on-deck, game started → player's linked Telegram)
 * 
 * Players link their Telegram by sending a unique code to the bot via deep link.
 * The server polls /getUpdates to match codes to player accounts.
 */

const https = require('https');
const crypto = require('crypto');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3960';

// In-memory store for pending link codes: { code: { playerId, createdAt } }
const pendingLinkCodes = new Map();

// Track the last update_id we've processed (for /getUpdates offset)
let lastUpdateId = 0;

// Reference to database module (set via init())
let db = null;

// Polling interval handle
let pollTimer = null;

// ============================================================
// Initialization
// ============================================================

/**
 * Initialize the Telegram service with the database module.
 * Starts polling for /getUpdates if bot token is configured.
 * Awaits getBotInfo() so botUsername is available before any deep links are generated.
 */
async function init(dbModule) {
    db = dbModule;

    if (!BOT_TOKEN) {
        console.log('📱 Telegram: No bot token configured — notifications disabled');
        return;
    }

    // Fetch bot username first (needed for deep links)
    await getBotInfo();
    
    // Start polling for incoming messages (link codes from players)
    startPolling();
    console.log('📱 Telegram: Bot polling started');
}

// ============================================================
// Core: Send Message
// ============================================================

/**
 * Send a Telegram message to a specific chat ID.
 * @param {string} chatId - Telegram chat ID
 * @param {string} text - Message text (supports HTML)
 * @param {string} [parseMode='HTML'] - Parse mode
 * @returns {Promise<boolean>}
 */
async function sendMessage(chatId, text, parseMode = 'HTML') {
    if (!BOT_TOKEN) return false;
    if (!chatId) return false;

    const payload = JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true
    });

    return new Promise((resolve) => {
        const options = {
            hostname: 'api.telegram.org',
            path: `/bot${BOT_TOKEN}/sendMessage`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (!parsed.ok) {
                        console.error('Telegram API error:', parsed.description);
                        resolve(false);
                    } else {
                        resolve(true);
                    }
                } catch (e) {
                    console.error('Telegram response parse error:', e.message);
                    resolve(false);
                }
            });
        });

        req.on('error', (e) => {
            console.error('Telegram request error:', e.message);
            resolve(false);
        });

        req.setTimeout(10000, () => {
            console.warn('Telegram request timed out');
            req.destroy();
            resolve(false);
        });

        req.write(payload);
        req.end();
    });
}

// ============================================================
// Admin Notifications
// ============================================================

/**
 * Send a notification to the admin (env TELEGRAM_CHAT_ID).
 */
async function notifyAdmin(message) {
    if (!ADMIN_CHAT_ID) return false;
    return sendMessage(ADMIN_CHAT_ID, `🏰 960 Throne: ${message}`);
}

// ============================================================
// Player Linking — Deep Link Flow
// ============================================================

/**
 * Generate a unique link code for a player to connect their Telegram.
 * Returns { code, deepLink, botUsername } for the UI to display.
 */
function generateLinkCode(playerId) {
    // Clean up any existing code for this player
    for (const [code, data] of pendingLinkCodes) {
        if (data.playerId === playerId) {
            pendingLinkCodes.delete(code);
        }
    }

    // Generate a short random code
    const code = 'T' + crypto.randomBytes(4).toString('hex').toUpperCase(); // e.g. T1A2B3C4D
    pendingLinkCodes.set(code, {
        playerId,
        createdAt: Date.now()
    });

    // Clean up codes older than 10 minutes
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    for (const [c, data] of pendingLinkCodes) {
        if (data.createdAt < tenMinutesAgo) {
            pendingLinkCodes.delete(c);
        }
    }

    // Deep link: t.me/BotUsername?start=CODE
    // If botUsername isn't cached yet, return null (API route will handle it)
    const deepLink = (BOT_TOKEN && botUsername) ? `https://t.me/${botUsername}?start=${code}` : null;

    return { code, deepLink };
}

/**
 * Unlink a player's Telegram account.
 */
function unlinkPlayer(playerId) {
    if (!db) return false;
    db.setPlayerTelegramChatId(playerId, null);
    return true;
}

// ============================================================
// Polling — Listen for /start commands from players
// ============================================================

let botUsername = null; // Cached bot username for deep links

function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    // Poll every 3 seconds
    pollTimer = setInterval(pollUpdates, 3000);
    // Do an immediate poll (getBotInfo already called in init)
    pollUpdates();
}

function stopPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

/**
 * Get bot info (username) for deep link generation.
 */
async function getBotInfo() {
    if (!BOT_TOKEN) return;

    return new Promise((resolve) => {
        const options = {
            hostname: 'api.telegram.org',
            path: `/bot${BOT_TOKEN}/getMe`,
            method: 'GET'
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.ok && parsed.result) {
                        botUsername = parsed.result.username;
                        console.log(`📱 Telegram bot: @${botUsername}`);
                    }
                } catch (e) { /* ignore */ }
                resolve();
            });
        });

        req.on('error', () => resolve());
        req.setTimeout(5000, () => { req.destroy(); resolve(); });
        req.end();
    });
}

/**
 * Poll /getUpdates for new messages containing /start codes.
 */
async function pollUpdates() {
    if (!BOT_TOKEN || !db) return;

    return new Promise((resolve) => {
        const params = `offset=${lastUpdateId + 1}&timeout=0&allowed_updates=["message"]`;
        const options = {
            hostname: 'api.telegram.org',
            path: `/bot${BOT_TOKEN}/getUpdates?${params}`,
            method: 'GET'
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.ok && parsed.result) {
                        for (const update of parsed.result) {
                            lastUpdateId = Math.max(lastUpdateId, update.update_id);
                            processUpdate(update);
                        }
                    }
                } catch (e) {
                    // Silently ignore parse errors
                }
                resolve();
            });
        });

        req.on('error', () => resolve());
        req.setTimeout(10000, () => { req.destroy(); resolve(); });
        req.end();
    });
}

/**
 * Process a single Telegram update — look for /start LINK_CODE messages.
 */
function processUpdate(update) {
    if (!update.message || !update.message.text) return;

    const text = update.message.text.trim();
    const chatId = String(update.message.chat.id);
    const fromUser = update.message.from;

    // Handle /start with a link code
    if (text.startsWith('/start ')) {
        const code = text.split(' ')[1];
        if (code && pendingLinkCodes.has(code)) {
            const { playerId } = pendingLinkCodes.get(code);
            pendingLinkCodes.delete(code);

            // Link the player's Telegram chat ID
            db.setPlayerTelegramChatId(playerId, chatId);

            const player = db.getPlayerById(playerId);
            const playerName = player ? player.name : `Player #${playerId}`;

            // Confirm to the user
            sendMessage(chatId,
                `✅ <b>Linked!</b>\n\nYou're now connected as <b>${escapeHtml(playerName)}</b> on 960 Throne.\n\n` +
                `You'll get notifications when:\n` +
                `• ⚔️ You're next up to play\n` +
                `• 🎮 Your game starts\n` +
                `• 👑 You become King\n\n` +
                `To unlink, go to your player dashboard.`
            );

            console.log(`📱 Telegram linked: ${playerName} → chat ${chatId}`);
            return;
        }
    }

    // Handle bare /start (no code) — welcome message
    if (text === '/start') {
        sendMessage(chatId,
            `🏰 <b>960 Throne Bot</b>\n\n` +
            `This bot sends you game notifications when you're playing 960 Throne.\n\n` +
            `To link your account, go to your player dashboard at:\n` +
            `${BASE_URL}/player\n\n` +
            `Then tap "🔔 Get Telegram Notifications" and follow the instructions.`
        );
        return;
    }

    // Handle /unlink command
    if (text === '/unlink') {
        // Find player by this chat ID and unlink
        if (db) {
            const player = db.getPlayerByTelegramChatId(chatId);
            if (player) {
                db.setPlayerTelegramChatId(player.id, null);
                sendMessage(chatId, `🔕 Unlinked! You won't receive 960 Throne notifications anymore.`);
                console.log(`📱 Telegram unlinked: ${player.name} (chat ${chatId})`);
            } else {
                sendMessage(chatId, `No linked account found for this chat.`);
            }
        }
        return;
    }
}

// ============================================================
// Player Notifications — Game Events
// ============================================================

/**
 * Notify a player that they're on deck (next to play).
 * @param {number} playerId
 * @param {number} timeoutSeconds - seconds until they get skipped
 */
async function notifyOnDeck(playerId, timeoutSeconds) {
    const chatId = getPlayerChatId(playerId);
    if (!chatId) return false;

    const player = db.getPlayerById(playerId);
    const name = player ? player.name : 'Player';

    return sendMessage(chatId,
        `⚔️ <b>You're up next, ${escapeHtml(name)}!</b>\n\n` +
        `Head to the board — your game is about to start!\n\n` +
        `🏰 ${BASE_URL}/game`
    );
}

/**
 * Notify a player that their game has started.
 * @param {number} playerId
 * @param {string} opponentName
 * @param {number} positionNumber - Chess960 position
 * @param {string} color - 'white' or 'black'
 */
async function notifyGameStarted(playerId, opponentName, positionNumber, color) {
    const chatId = getPlayerChatId(playerId);
    if (!chatId) return false;

    const colorEmoji = color === 'white' ? '⬜' : '⬛';

    return sendMessage(chatId,
        `🎮 <b>Game Started!</b>\n\n` +
        `You're playing ${colorEmoji} ${color} against <b>${escapeHtml(opponentName)}</b>\n` +
        `Position #${positionNumber}\n\n` +
        `🏰 ${BASE_URL}/game`
    );
}

/**
 * Notify a player that they've become King.
 * @param {number} playerId
 */
async function notifyBecameKing(playerId) {
    const chatId = getPlayerChatId(playerId);
    if (!chatId) return false;

    return sendMessage(chatId,
        `👑 <b>You're the new King!</b>\n\n` +
        `Defend your throne and earn sats!\n\n` +
        `🏰 ${BASE_URL}/player`
    );
}

/**
 * Notify a player about their queue position (when they're #2 or #3).
 * @param {number} playerId
 * @param {number} position
 */
async function notifyQueuePosition(playerId, position) {
    const chatId = getPlayerChatId(playerId);
    if (!chatId) return false;

    return sendMessage(chatId,
        `📋 <b>You're #${position} in line</b>\n\n` +
        `Get ready — you'll be up soon!\n\n` +
        `🏰 ${BASE_URL}/player`
    );
}

// ============================================================
// Helpers
// ============================================================

/**
 * Get a player's Telegram chat ID (from DB).
 * Returns null if not linked.
 */
function getPlayerChatId(playerId) {
    if (!db) return null;
    const player = db.getPlayerById(playerId);
    return player ? player.telegram_chat_id : null;
}

/**
 * Get the bot username for deep link generation.
 * May be null if bot info hasn't been fetched yet.
 */
function getBotUsername() {
    return botUsername;
}

/**
 * Check if the Telegram bot is configured.
 */
function isConfigured() {
    return !!BOT_TOKEN;
}

/**
 * Check if a player has Telegram linked.
 */
function isPlayerLinked(playerId) {
    return !!getPlayerChatId(playerId);
}

function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

module.exports = {
    init,
    sendMessage,
    notifyAdmin,
    generateLinkCode,
    unlinkPlayer,
    getBotUsername,
    isConfigured,
    isPlayerLinked,
    // Player notifications
    notifyOnDeck,
    notifyGameStarted,
    notifyBecameKing,
    notifyQueuePosition,
    // Polling control
    stopPolling,
};
