/**
 * Page Routes — EJS rendered pages
 * Auth is handled via Lightning login (LNURL-auth) through API routes
 */

const express = require('express');
const router = express.Router();
const db = require('../services/database');
const gameEngine = require('../services/gameEngine');
const chess960 = require('../services/chess960');
const dgtBoard = require('../services/dgtBoard');

// Middleware to attach player to all page renders
function attachPlayer(req, res, next) {
    const token = req.cookies?.session;
    if (token) {
        req.player = db.getPlayerBySession(token);
    }
    next();
}

function attachAdmin(req, res, next) {
    const dbPassword = db.getConfig('admin_password_override');
    const adminPassword = dbPassword || process.env.ADMIN_PASSWORD || 'changeme';
    const provided = req.cookies?.admin_token;
    req.isAdmin = provided === adminPassword;
    next();
}

router.use(attachPlayer);
router.use(attachAdmin);

// Home — Lightning Login
router.get('/', (req, res) => {
    if (req.player) {
        // If player has no name yet, redirect to set-name
        if (!req.player.name) {
            const code = req.query.code || '';
            return res.redirect('/set-name' + (code ? '?code=' + code : ''));
        }
        // Check current game state to route player appropriately
        const state = gameEngine.getThoneState();

        // If player is in an active game (king or challenger), go straight to game page
        if (state.game && (state.game.king_id === req.player.id || state.game.challenger_id === req.player.id)) {
            return res.redirect('/game');
        }

        // If they have a venue code, auto-join queue before redirecting
        // (joinQueue already guards against king/duplicate, but skip the call for clarity)
        const code = req.query.code;
        const isKing = state.king && state.king.id === req.player.id;
        if (code && db.validateVenueCode(code) && !isKing && !db.isPlayerInQueue(req.player.id)) {
            gameEngine.joinQueue(req.player.id);
        }
        return res.redirect('/player');
    }
    const state = gameEngine.getThoneState();
    const venueCode = req.query.code || '';
    res.render('index', { state, error: null, venueCode });
});

// Set name page (for new Lightning auth users who haven't chosen a name yet)
router.get('/set-name', (req, res) => {
    if (!req.player) return res.redirect('/');
    if (req.player.name) return res.redirect('/player');
    res.render('set-name');
});

// Player Dashboard
router.get('/player', (req, res) => {
    if (!req.player) return res.redirect('/');
    if (!req.player.name) return res.redirect('/set-name');
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

// Throne — Big screen venue dashboard (admin password protected, shows QR code)
router.get('/throne', (req, res) => {
    if (!req.isAdmin) {
        return res.render('admin-login', { returnTo: '/throne' });
    }
    const state = gameEngine.getThoneState();
    const dgt = dgtBoard.getState();
    const showCode = db.getConfig('show_venue_code') === 'true';
    res.render('throne', { state, dgt, showVenueCode: true, showVenueCodeText: showCode });
});

// Live — Public web version of throne (no QR code, shows "Watch live" URL instead)
router.get('/live', (req, res) => {
    const state = gameEngine.getThoneState();
    const dgt = dgtBoard.getState();
    res.render('throne', { state, dgt, showVenueCode: false });
});

// Watch — Public page with YouTube livestream + game info sidebar
router.get('/watch', (req, res) => {
    const state = gameEngine.getThoneState();
    const dgt = dgtBoard.getState();
    const youtubeId = db.getConfig('youtube_stream_id') || 'yPAvYs5Hj6c';
    res.render('watch', { state, dgt, youtubeId });
});

// Board — Just the live board, nothing else (public, embeddable)
router.get('/board', (req, res) => {
    const dgt = dgtBoard.getState();
    const state = gameEngine.getThoneState();
    res.render('board', { dgt, game: state.game });
});

// Multi-board index — shows all connected DGT boards (public)
router.get('/boards', (req, res) => {
    const boards = dgtBoard.getAllMultiBoardStates();
    res.render('boards', { boards });
});

// Single board stream view — clean full-screen board + clock for OBS capture (public)
router.get('/boards/:boardId', (req, res) => {
    const boardId = req.params.boardId;
    const boardState = dgtBoard.getMultiBoardState(boardId);
    res.render('board-stream', { boardId, boardState });
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
        // Store the code and redirect to login
        res.cookie('venue_code', code || '', { maxAge: 10 * 60 * 1000 });
        return res.redirect('/?join=true&code=' + (code || ''));
    }
    // If player is in an active game, go straight to game page
    const state = gameEngine.getThoneState();
    if (state.game && (state.game.king_id === req.player.id || state.game.challenger_id === req.player.id)) {
        return res.redirect('/game');
    }
    // If player is already in the queue, go to player dashboard (shows position + leave button)
    if (db.isPlayerInQueue(req.player.id)) {
        return res.redirect('/player');
    }
    // If they have a valid venue code, auto-join and redirect to player dashboard
    if (code && db.validateVenueCode(code)) {
        gameEngine.joinQueue(req.player.id);
        return res.redirect('/player');
    }
    res.render('join', { player: req.player, venueCode: code || '' });
});

// Round Position — Shows current Bitcoin-derived Chess960 position with lock schedule (public)
router.get('/position', (req, res) => {
    res.render('position');
});

// Event Timeline (public)
router.get('/timeline', (req, res) => {
    const timeline = db.getTimelineData();
    const state = gameEngine.getThoneState();

    // Pre-compute Chess960 piece arrays for all unique positions used in games
    const positionPieces = {};
    timeline.games.forEach(g => {
        if (!positionPieces[g.chess960_position]) {
            positionPieces[g.chess960_position] = chess960.positionFromNumber(g.chess960_position);
        }
    });

    res.render('timeline', {
        timeline,
        positionPieces,
        currentKing: state.king,
        liveSats: state.liveSats,
        player: req.player,
    });
});

// Leaderboard
router.get('/leaderboard', (req, res) => {
    const leaderboard = db.getLeaderboard();
    const longestReigns = db.getLongestReigns();
    const stats = db.getEventStats();
    const state = gameEngine.getThoneState();
    res.render('leaderboard', { leaderboard, longestReigns, stats, player: req.player, state });
});

// Multi-board LiveChess viewer — served from Railway, connects to localhost LiveChess on the laptop
router.get('/multi-board', (req, res) => {
    res.sendFile(require('path').join(__dirname, '../../dgt-relay/multi-board-viewer.html'));
});

// Multi-board direct USB viewer — served from Railway, uses Web Serial API on the laptop
router.get('/multi-board-direct', (req, res) => {
    res.sendFile(require('path').join(__dirname, '../../dgt-relay/multi-board-direct.html'));
});

// DGT Board Relay page (admin-protected)
router.get('/admin/dgt-relay', (req, res) => {
    if (!req.isAdmin) {
        return res.render('admin-login', { returnTo: '/admin/dgt-relay' });
    }
    const relaySecret = process.env.DGT_RELAY_SECRET || process.env.ADMIN_PASSWORD || 'changeme';
    const serverUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.render('dgt-relay', { relaySecret, serverUrl });
});

// Report Results — dedicated page for reporting game results (admin-protected)
router.get('/report', (req, res) => {
    if (!req.isAdmin) {
        return res.render('admin-login', { returnTo: '/report' });
    }
    const state = gameEngine.getThoneState();
    const relaySecret = process.env.DGT_RELAY_SECRET || process.env.ADMIN_PASSWORD || 'changeme';
    const serverUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.render('report', { state, relaySecret, serverUrl });
});

// Admin Stream Management
router.get('/admin/stream', (req, res) => {
    if (!req.isAdmin) {
        return res.render('admin-login', { returnTo: '/admin/stream' });
    }
    const currentStreamId = db.getConfig('youtube_stream_id') || 'yPAvYs5Hj6c';
    res.render('admin-stream', { currentStreamId });
});

// Admin Users
router.get('/admin/users', (req, res) => {
    if (!req.isAdmin) {
        return res.render('admin-login', { returnTo: '/admin/users' });
    }
    const players = db.getAllPlayers();
    res.render('admin-users', { players });
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
    const scheduledReset = gameEngine.getScheduledReset();
    const showVenueCode = db.getConfig('show_venue_code') === 'true';
    res.render('admin', {
        state,
        players,
        notifications,
        config,
        venueCode,
        payouts,
        recentGames,
        scheduledReset,
        showVenueCode,
    });
});

module.exports = router;
