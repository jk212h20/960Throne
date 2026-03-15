/**
 * API Routes — All JSON endpoints
 */

const express = require('express');
const router = express.Router();
const db = require('../services/database');
const gameEngine = require('../services/gameEngine');
const lightning = require('../services/lightning');
const auth = require('../services/auth');
const telegram = require('../services/telegram');
const chess960 = require('../services/chess960');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');

// ============================================================
// Auth middleware
// ============================================================

function requirePlayer(req, res, next) {
    const token = req.cookies?.session || req.headers['x-session-token'];
    if (!token) return res.status(401).json({ error: 'Not logged in' });
    const player = db.getPlayerBySession(token);
    if (!player) return res.status(401).json({ error: 'Invalid session' });
    req.player = player;
    next();
}

function requireAdmin(req, res, next) {
    const adminPassword = process.env.ADMIN_PASSWORD || 'changeme';
    const provided = req.cookies?.admin_token || req.headers['x-admin-token'];
    if (provided !== adminPassword) {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

// ============================================================
// Player Auth (Lightning login via /api/auth/* routes below)
// ============================================================

// Logout
router.post('/logout', (req, res) => {
    res.clearCookie('session');
    res.json({ success: true });
});

// Get current player
router.get('/me', requirePlayer, (req, res) => {
    const player = req.player;
    const queueEntry = db.getQueueEntry(player.id);
    const games = db.getPlayerGames(player.id, 10);
    const payouts = db.getPlayerPayouts(player.id);
    res.json({ player, queueEntry, games, payouts });
});

// ============================================================
// Queue
// ============================================================

router.post('/queue/join', requirePlayer, (req, res) => {
    const { venueCode } = req.body;

    // Validate venue code
    if (!db.validateVenueCode(venueCode)) {
        return res.status(403).json({ error: 'Invalid or expired venue code. Scan the QR at the venue to join.' });
    }

    const result = gameEngine.joinQueue(req.player.id);
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

router.post('/queue/leave', requirePlayer, (req, res) => {
    const result = gameEngine.leaveQueue(req.player.id);
    res.json(result);
});

router.get('/queue', (req, res) => {
    res.json({ queue: db.getQueue() });
});

// ============================================================
// Game
// ============================================================

router.post('/game/report', requirePlayer, (req, res) => {
    const { result } = req.body;
    if (!result) return res.status(400).json({ error: 'Result is required' });

    const outcome = gameEngine.reportResult(req.player.id, result);
    if (outcome.error) return res.status(400).json(outcome);
    res.json(outcome);
});

router.get('/game/active', (req, res) => {
    const game = db.getActiveGame();
    res.json({ game });
});

// ============================================================
// Throne State
// ============================================================

router.get('/throne', (req, res) => {
    res.json(gameEngine.getThoneState());
});

// ============================================================
// Leaderboard & Stats
// ============================================================

router.get('/leaderboard', (req, res) => {
    res.json({
        leaderboard: db.getLeaderboard(),
        longestReigns: db.getLongestReigns(),
        stats: db.getEventStats()
    });
});

// ============================================================
// Sat Claims (Lightning payouts)
// ============================================================

router.post('/claim', requirePlayer, async (req, res) => {
    const { lightningAddress, amount } = req.body;
    const player = req.player;

    if (!lightningAddress) {
        return res.status(400).json({ error: 'Lightning address required (e.g., user@walletofsatoshi.com)' });
    }

    const claimAmount = amount ? parseInt(amount) : player.sat_balance;
    if (claimAmount <= 0) {
        return res.status(400).json({ error: 'No sats to claim' });
    }
    if (claimAmount > player.sat_balance) {
        return res.status(400).json({ error: `Insufficient balance. You have ${player.sat_balance} sats.` });
    }
    if (claimAmount < 10) {
        return res.status(400).json({ error: 'Minimum claim is 10 sats' });
    }

    // Check if Lightning is configured
    const lnStatus = await lightning.isConfigured();
    if (!lnStatus.configured) {
        return res.status(503).json({ error: 'Lightning payments not available. Ask an admin to claim manually.' });
    }

    // Create payout record
    const payoutId = db.createPayout(player.id, claimAmount, lightningAddress);

    try {
        const payResult = await lightning.payLightningAddress(
            lightningAddress,
            claimAmount,
            `960 Throne payout for ${player.name}`
        );

        // Success — deduct from balance
        db.deductSatsFromPlayer(player.id, claimAmount);
        db.updatePayout(payoutId, {
            payment_hash: payResult.paymentHash,
            status: 'completed',
            completed_at: new Date().toISOString()
        });

        res.json({
            success: true,
            amount: claimAmount,
            paymentHash: payResult.paymentHash,
            message: `⚡ ${claimAmount} sats sent to ${lightningAddress}!`
        });
    } catch (err) {
        db.updatePayout(payoutId, {
            status: 'failed',
            error_message: err.message
        });
        res.status(500).json({
            error: `Payment failed: ${err.message}`,
            hint: err.message.includes('Bolt12') ? 'Try a different wallet (WoS, Alby, Coinos)' : undefined
        });
    }
});

// ============================================================
// Auth — Lightning Login (LNURL-auth) + extensible strategies
// ============================================================

// Generate a new auth challenge (returns QR code data for scanning)
router.get('/auth/lightning', async (req, res) => {
    try {
        const challenge = auth.createChallenge('lightning');
        
        // Generate QR code as data URL
        const qrDataUrl = await QRCode.toDataURL(challenge.encodedUrl, {
            width: 400,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' },
        });

        res.json({
            k1: challenge.k1,
            lnurl: challenge.encodedUrl,
            qr: qrDataUrl,
            deepLink: challenge.deepLink,
        });
    } catch (err) {
        console.error('Auth challenge error:', err);
        res.status(500).json({ error: 'Failed to generate auth challenge' });
    }
});

// LNURL-auth callback — wallet hits this URL with sig + key
router.get('/auth/lightning/callback', (req, res) => {
    const { k1, sig, key, tag } = req.query;

    if (!k1 || !sig || !key) {
        return res.json({ status: 'ERROR', reason: 'Missing required parameters (k1, sig, key)' });
    }

    // Verify the signature
    const result = auth.processCallback(k1, { sig, key });

    if (!result.success) {
        return res.json({ status: 'ERROR', reason: result.error });
    }

    // Signature valid — find or create the player
    const authId = result.authId;
    let player = db.getPlayerByAuthId('lightning', authId);
    let isNewPlayer = false;

    if (!player) {
        // New player — create account with lightning auth
        const playerId = db.createPlayerWithAuth('lightning', authId);
        player = db.getPlayerById(playerId);
        isNewPlayer = true;
    }

    // Create session
    const token = uuidv4();
    db.setPlayerSession(player.id, token);
    auth.completeChallenge(k1, token);

    // LNURL spec requires { status: "OK" } response
    return res.json({ status: 'OK' });
});

// Poll auth status — frontend polls this to know when wallet has completed auth
router.get('/auth/status', (req, res) => {
    const { k1 } = req.query;
    if (!k1) return res.status(400).json({ error: 'k1 required' });

    const status = auth.getChallengeStatus(k1);

    if (status.status === 'complete' && status.sessionToken) {
        // Auth complete — set session cookie and return success
        res.cookie('session', status.sessionToken, { 
            httpOnly: true, 
            maxAge: 10 * 365 * 24 * 60 * 60 * 1000, // 10 years — effectively never expires
            path: '/' 
        });

        // Check if player needs to set a name
        const player = db.getPlayerBySession(status.sessionToken);
        const needsName = !player || !player.name;

        // Clean up the challenge
        auth.consumeChallenge(k1);

        return res.json({ 
            status: 'complete', 
            needsName,
            player: player ? { id: player.id, name: player.name } : null,
        });
    }

    return res.json({ status: status.status });
});

// Set display name after Lightning auth (for new players)
router.post('/auth/set-name', requirePlayer, (req, res) => {
    const { name } = req.body;
    
    if (!name || name.trim().length < 1) {
        return res.status(400).json({ error: 'Name is required' });
    }
    if (name.trim().length > 30) {
        return res.status(400).json({ error: 'Name must be 30 characters or less' });
    }

    // Check name isn't taken
    const existing = db.getPlayerByName(name.trim());
    if (existing && existing.id !== req.player.id) {
        return res.status(400).json({ error: 'Name already taken. Choose a different name.' });
    }

    db.setPlayerName(req.player.id, name.trim());
    res.json({ success: true, name: name.trim() });
});

// Set/update email (optional, for account recovery)
router.post('/auth/set-email', requirePlayer, (req, res) => {
    const { email } = req.body;
    
    if (email && email.trim()) {
        // Basic email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email.trim())) {
            return res.status(400).json({ error: 'Invalid email address' });
        }
        if (email.trim().length > 255) {
            return res.status(400).json({ error: 'Email too long' });
        }
        db.setPlayerEmail(req.player.id, email.trim());
        res.json({ success: true, email: email.trim() });
    } else {
        // Allow clearing email
        db.setPlayerEmail(req.player.id, null);
        res.json({ success: true, email: null });
    }
});

// ============================================================
// Telegram — Player notification linking
// ============================================================

// Generate a link code for the player to connect their Telegram
router.post('/telegram/link', requirePlayer, (req, res) => {
    if (!telegram.isConfigured()) {
        return res.status(503).json({ error: 'Telegram bot not configured' });
    }
    const { code, deepLink } = telegram.generateLinkCode(req.player.id);
    const botUsername = telegram.getBotUsername();
    res.json({ 
        code, 
        deepLink: botUsername ? `https://t.me/${botUsername}?start=${code}` : deepLink,
        botUsername 
    });
});

// Check if the player's Telegram is linked
router.get('/telegram/status', requirePlayer, (req, res) => {
    const linked = !!req.player.telegram_chat_id;
    res.json({ 
        linked, 
        configured: telegram.isConfigured(),
        botUsername: telegram.getBotUsername()
    });
});

// Unlink Telegram
router.post('/telegram/unlink', requirePlayer, (req, res) => {
    telegram.unlinkPlayer(req.player.id);
    res.json({ success: true });
});

// ============================================================
// Admin API
// ============================================================

router.post('/admin/login', (req, res) => {
    const { password } = req.body;
    const adminPassword = process.env.ADMIN_PASSWORD || 'changeme';
    if (password !== adminPassword) {
        return res.status(401).json({ error: 'Invalid admin password' });
    }
    res.cookie('admin_token', adminPassword, { httpOnly: true, maxAge: 10 * 365 * 24 * 60 * 60 * 1000, path: '/' });
    res.json({ success: true });
});

router.post('/admin/crown', requireAdmin, (req, res) => {
    const { playerId } = req.body;
    if (!playerId) return res.status(400).json({ error: 'Player ID required' });
    const result = gameEngine.crownKing(parseInt(playerId));
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

router.post('/admin/start-game', requireAdmin, (req, res) => {
    const result = gameEngine.startGame();
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

router.post('/admin/override-result', requireAdmin, (req, res) => {
    const { gameId, result } = req.body;
    if (!gameId || !result) return res.status(400).json({ error: 'Game ID and result required' });
    const outcome = gameEngine.adminOverrideResult(parseInt(gameId), result);
    if (outcome.error) return res.status(400).json(outcome);
    res.json(outcome);
});

router.post('/admin/remove-challenger', requireAdmin, (req, res) => {
    const outcome = gameEngine.adminRemoveChallenger();
    if (outcome.error) return res.status(400).json(outcome);
    res.json(outcome);
});

router.post('/admin/undo-game', requireAdmin, (req, res) => {
    const { gameId } = req.body;
    if (!gameId) return res.status(400).json({ error: 'Game ID required' });
    const outcome = gameEngine.adminUndoGame(parseInt(gameId));
    if (outcome.error) return res.status(400).json(outcome);
    res.json(outcome);
});

router.post('/admin/set-challenger', requireAdmin, (req, res) => {
    const { playerId } = req.body;
    if (!playerId) return res.status(400).json({ error: 'Player ID required' });
    const outcome = gameEngine.adminSetChallenger(parseInt(playerId));
    if (outcome.error) return res.status(400).json(outcome);
    res.json(outcome);
});

router.post('/admin/event-active', requireAdmin, (req, res) => {
    const { active } = req.body;
    gameEngine.setEventActive(!!active);
    res.json({ success: true, active: !!active });
});

router.post('/admin/rotate-venue-code', requireAdmin, (req, res) => {
    const code = gameEngine.rotateVenueCode();
    res.json({ success: true, code });
});

router.get('/admin/venue-code', requireAdmin, (req, res) => {
    const code = db.getActiveVenueCode();
    res.json({ code });
});

router.post('/admin/queue/remove', requireAdmin, (req, res) => {
    const { playerId } = req.body;
    if (!playerId) return res.status(400).json({ error: 'Player ID required' });
    gameEngine.adminRemoveFromQueue(parseInt(playerId));
    res.json({ success: true });
});

router.post('/admin/queue/add', requireAdmin, (req, res) => {
    const { playerId } = req.body;
    if (!playerId) return res.status(400).json({ error: 'Player ID required' });
    const result = gameEngine.adminAddToQueue(parseInt(playerId));
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

router.get('/admin/notifications', requireAdmin, (req, res) => {
    res.json({ notifications: db.getUnresolvedNotifications() });
});

router.post('/admin/notifications/resolve', requireAdmin, (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Notification ID required' });
    db.resolveNotification(parseInt(id));
    res.json({ success: true });
});

router.get('/admin/config', requireAdmin, (req, res) => {
    res.json({ config: db.getAllConfig() });
});

router.post('/admin/config', requireAdmin, (req, res) => {
    const { key, value } = req.body;
    if (!key || value === undefined) return res.status(400).json({ error: 'Key and value required' });
    db.setConfig(key, value);
    res.json({ success: true });
});

// Merge two player accounts (for locked-out players who created a new account)
router.post('/admin/merge-accounts', requireAdmin, (req, res) => {
    const { targetPlayerId, sourcePlayerId } = req.body;
    if (!targetPlayerId || !sourcePlayerId) {
        return res.status(400).json({ error: 'Both targetPlayerId and sourcePlayerId required' });
    }
    try {
        const result = db.mergeAccounts(parseInt(targetPlayerId), parseInt(sourcePlayerId));
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.get('/admin/players', requireAdmin, (req, res) => {
    res.json({ players: db.getAllPlayers() });
});

router.get('/admin/payouts', requireAdmin, (req, res) => {
    res.json({ payouts: db.getAllPayouts() });
});

// Scheduled Reset
router.post('/admin/schedule-reset', requireAdmin, (req, res) => {
    const { resetAt, password } = req.body;
    // Double-check password for this high-security action
    const adminPassword = process.env.ADMIN_PASSWORD || 'changeme';
    if (password !== adminPassword) {
        return res.status(403).json({ error: 'Password required to schedule a reset' });
    }
    if (!resetAt) return res.status(400).json({ error: 'resetAt (ISO datetime) required' });
    const result = gameEngine.scheduleReset(resetAt);
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

router.post('/admin/cancel-reset', requireAdmin, (req, res) => {
    const result = gameEngine.cancelReset();
    res.json(result);
});

router.get('/admin/scheduled-reset', requireAdmin, (req, res) => {
    const reset = gameEngine.getScheduledReset();
    res.json({ reset });
});

router.get('/admin/accounting', requireAdmin, (req, res) => {
    // Flush accumulated sats to DB so audit compares fresh values (not up to 10s stale)
    gameEngine.flushAccumulatedSats();
    const satRate = parseInt(db.getConfig('sat_rate_per_second') || '21');
    const audit = db.getAccountingAudit(satRate);
    res.json(audit);
});

// Public Venue QR Image (no auth — used by throne display page)
router.get('/venue-qr.png', async (req, res) => {
    const code = db.getActiveVenueCode();
    if (!code) return res.status(404).send('No active venue code');
    
    const baseUrl = process.env.BASE_URL || 'http://localhost:3960';
    const joinUrl = `${baseUrl}/join?code=${code.code}`;
    
    const pngBuffer = await QRCode.toBuffer(joinUrl, {
        width: 600,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
    });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-cache');
    res.send(pngBuffer);
});

// Venue Code QR Image (admin, with JSON option)
router.get('/admin/venue-qr', requireAdmin, async (req, res) => {
    const code = db.getActiveVenueCode();
    if (!code) return res.status(404).json({ error: 'No active venue code' });
    
    const baseUrl = process.env.BASE_URL || 'http://localhost:3960';
    const joinUrl = `${baseUrl}/join?code=${code.code}`;
    
    const format = req.query.format || 'json';
    
    if (format === 'png') {
        // Return raw PNG image
        const pngBuffer = await QRCode.toBuffer(joinUrl, {
            width: 600,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' },
        });
        res.set('Content-Type', 'image/png');
        return res.send(pngBuffer);
    }
    
    // Return data URL + metadata
    const qrDataUrl = await QRCode.toDataURL(joinUrl, {
        width: 600,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
    });
    
    res.json({ 
        code: code.code,
        url: joinUrl,
        qr: qrDataUrl,
        expiresAt: code.expires_at
    });
});

// ============================================================
// Bitcoin Chess960 Position
// ============================================================

router.get('/bitcoin-position', async (req, res) => {
    try {
        const btcPos = await chess960.fetchBitcoinPosition();
        res.json(btcPos);
    } catch (err) {
        console.error('Bitcoin position fetch error:', err.message);
        res.status(502).json({ error: 'Failed to fetch Bitcoin block data' });
    }
});

// ============================================================
// Admin — Lightning
// ============================================================

router.get('/admin/lightning-status', requireAdmin, async (req, res) => {
    const status = await lightning.isConfigured();
    if (status.configured) {
        try {
            const balance = await lightning.getChannelBalance();
            status.channelBalance = balance;
        } catch (e) {
            status.balanceError = e.message;
        }
    }
    res.json(status);
});

// ============================================================
// DGT Board (LiveChessCloud)
// ============================================================

const dgtBoard = require('../services/dgtBoard');

// Get DGT board state (public — for live views)
router.get('/dgt/state', (req, res) => {
    res.json(dgtBoard.getState());
});

// Set DGT tournament ID (admin only)
router.post('/admin/dgt/tournament', requireAdmin, (req, res) => {
    const { tournamentId } = req.body;
    const state = dgtBoard.setTournament(tournamentId || '');
    res.json({ success: true, state });
});

module.exports = router;
