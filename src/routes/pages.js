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
        return res.redirect('/player');
    }
    const state = gameEngine.getThoneState();
    res.render('index', { state });
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
