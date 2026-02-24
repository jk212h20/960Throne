/**
 * API Routes — All JSON endpoints
 */

const express = require('express');
const router = express.Router();
const db = require('../services/database');
const gameEngine = require('../services/gameEngine');
const lightning = require('../services/lightning');
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
// Player Auth
// ============================================================

// Register
router.post('/register', (req, res) => {
    const { name } = req.body;
    if (!name || name.trim().length < 1) {
        return res.status(400).json({ error: 'Name is required' });
    }
    if (name.trim().length > 30) {
        return res.status(400).json({ error: 'Name must be 30 characters or less' });
    }

    const existing = db.getPlayerByName(name.trim());
    if (existing) {
        return res.status(400).json({ error: 'Name already taken. Try logging in instead.' });
    }

    // Generate 4-digit PIN
    const pin = String(Math.floor(1000 + Math.random() * 9000));
    const playerId = db.createPlayer(name.trim(), pin);

    // Create session
    const token = uuidv4();
    db.setPlayerSession(playerId, token);

    res.cookie('session', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' });
    res.json({
        success: true,
        player: { id: playerId, name: name.trim() },
        pin,
        message: `Your PIN is ${pin}. Remember it to log back in!`
    });
});

// Login
router.post('/login', (req, res) => {
    const { name, pin } = req.body;
    if (!name || !pin) {
        return res.status(400).json({ error: 'Name and PIN required' });
    }

    const player = db.getPlayerByName(name.trim());
    if (!player || player.pin !== pin) {
        return res.status(401).json({ error: 'Invalid name or PIN' });
    }

    const token = uuidv4();
    db.setPlayerSession(player.id, token);

    res.cookie('session', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({ success: true, player: { id: player.id, name: player.name } });
});

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
// Admin API
// ============================================================

router.post('/admin/login', (req, res) => {
    const { password } = req.body;
    const adminPassword = process.env.ADMIN_PASSWORD || 'changeme';
    if (password !== adminPassword) {
        return res.status(401).json({ error: 'Invalid admin password' });
    }
    res.cookie('admin_token', adminPassword, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
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

router.get('/admin/players', requireAdmin, (req, res) => {
    res.json({ players: db.getAllPlayers() });
});

router.get('/admin/payouts', requireAdmin, (req, res) => {
    res.json({ payouts: db.getAllPayouts() });
});

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

module.exports = router;
