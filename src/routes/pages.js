/**
 * Page Routes — EJS rendered pages
 */

const express = require('express');
const router = express.Router();
const db = require('../services/database');
const gameEngine = require('../services/gameEngine');

// Middleware to attach player to all page renders
function attachPlayer(req, res, next) {
    const token = req.cookies?.session;
    if (token) {
        req.player = db.getPlayerBySession(token);
    }
    next();
}

function attachAdmin(req, res, next) {
    const adminPassword = process.env.ADMIN_PASSWORD || 'changeme';
    const provided = req.cookies?.admin_token;
    req.isAdmin = provided === adminPassword;
    next();
}

router.use(attachPlayer);
router.use(attachAdmin);

// Home — Register / Login
router.get('/', (req, res) => {
    if (req.player) {
        // If they have a venue code, auto-join queue before redirecting
        const code = req.query.code;
        if (code && db.validateVenueCode(code) && !db.isPlayerInQueue(req.player.id)) {
            gameEngine.joinQueue(req.player.id);
        }
        return res.redirect('/player');
    }
    const state = gameEngine.getThoneState();
    const venueCode = req.query.code || '';
    res.render('index', { state, error: null, venueCode });
});

// Register via form POST (sets cookie + redirects server-side)
router.post('/register', (req, res) => {
    const { name } = req.body;
    const code = req.body.venueCode || '';
    
    if (!name || name.trim().length < 1) {
        const state = gameEngine.getThoneState();
        return res.render('index', { state, error: 'Name is required', venueCode: code });
    }
    if (name.trim().length > 30) {
        const state = gameEngine.getThoneState();
        return res.render('index', { state, error: 'Name must be 30 characters or less', venueCode: code });
    }

    const existing = db.getPlayerByName(name.trim());
    if (existing) {
        const state = gameEngine.getThoneState();
        return res.render('index', { state, error: 'Name already taken — use "Already registered?" below', venueCode: code });
    }

    const { v4: uuidv4 } = require('uuid');
    const pin = String(Math.floor(1000 + Math.random() * 9000));
    const playerId = db.createPlayer(name.trim(), pin);
    const token = uuidv4();
    db.setPlayerSession(playerId, token);

    res.cookie('session', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' });

    // If there's a valid venue code, auto-join the queue
    if (code && db.validateVenueCode(code)) {
        const result = gameEngine.joinQueue(playerId);
        // Even if joinQueue fails (e.g. already in queue), just redirect to player
    }

    res.redirect('/player');
});

// Login via form POST
router.post('/login', (req, res) => {
    const { name, pin } = req.body;
    if (!name || !pin) {
        const state = gameEngine.getThoneState();
        return res.render('index', { state, error: 'Enter name and PIN' });
    }

    const player = db.getPlayerByName(name.trim());
    if (!player || player.pin !== pin) {
        const state = gameEngine.getThoneState();
        return res.render('index', { state, error: 'Invalid name or PIN' });
    }

    const { v4: uuidv4 } = require('uuid');
    const token = uuidv4();
    db.setPlayerSession(player.id, token);

    res.cookie('session', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' });

    const code = req.body.venueCode || req.query.code;
    if (code) {
        return res.redirect('/join?code=' + code);
    }
    res.redirect('/player');
});

// Player Dashboard
router.get('/player', (req, res) => {
    if (!req.player) return res.redirect('/');
    const state = gameEngine.getThoneState();
    const games = db.getPlayerGames(req.player.id, 20);
    const queueEntry = db.getQueueEntry(req.player.id);
    const payouts = db.getPlayerPayouts(req.player.id);
    res.render('player', {
        player: req.player,
        state,
        games,
        queueEntry,
        payouts,
    });
});

// Queue view (public)
router.get('/queue', (req, res) => {
    const state = gameEngine.getThoneState();
    res.render('queue', { state, player: req.player });
});

// Throne — Big screen venue dashboard
router.get('/throne', (req, res) => {
    const state = gameEngine.getThoneState();
    res.render('throne', { state });
});

// Game — Active game view (for players in the current game)
router.get('/game', (req, res) => {
    if (!req.player) return res.redirect('/');
    const state = gameEngine.getThoneState();
    res.render('game', { player: req.player, state });
});

// Join queue via venue QR code
router.get('/join', (req, res) => {
    const { code } = req.query;
    if (!req.player) {
        // Store the code and redirect to register
        res.cookie('venue_code', code || '', { maxAge: 10 * 60 * 1000 });
        return res.redirect('/?join=true&code=' + (code || ''));
    }
    res.render('join', { player: req.player, venueCode: code || '' });
});

// Leaderboard
router.get('/leaderboard', (req, res) => {
    const leaderboard = db.getLeaderboard();
    const longestReigns = db.getLongestReigns();
    const stats = db.getEventStats();
    res.render('leaderboard', { leaderboard, longestReigns, stats, player: req.player });
});

// Admin
router.get('/admin', (req, res) => {
    if (!req.isAdmin) {
        return res.render('admin-login');
    }
    const state = gameEngine.getThoneState();
    const players = db.getAllPlayers();
    const notifications = db.getUnresolvedNotifications();
    const config = db.getAllConfig();
    const venueCode = db.getActiveVenueCode();
    const payouts = db.getAllPayouts();
    const recentGames = db.getRecentGames(20);
    res.render('admin', {
        state,
        players,
        notifications,
        config,
        venueCode,
        payouts,
        recentGames,
    });
});

module.exports = router;
