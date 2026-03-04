/**
 * 960 Throne — King of the Hill Chess960
 * Main server entry point
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const compression = require('compression');

const db = require('./services/database');
const gameEngine = require('./services/gameEngine');
const telegram = require('./services/telegram');

const PORT = process.env.PORT || 3000;

async function start() {
    // Initialize database
    await db.initialize();

    // Create Express app
    const app = express();
    const server = http.createServer(app);

    // Socket.io
    const io = new Server(server, {
        cors: { origin: '*' }
    });

    // Initialize Telegram bot (polling for link codes)
    telegram.init(db);

    // Initialize game engine with Socket.io
    gameEngine.init(io);

    // Middleware
    app.use(compression());
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // Simple cookie parser (no dependency needed beyond what Express provides)
    app.use((req, res, next) => {
        const cookieHeader = req.headers.cookie;
        req.cookies = {};
        if (cookieHeader) {
            cookieHeader.split(';').forEach(cookie => {
                const [name, ...rest] = cookie.trim().split('=');
                req.cookies[name] = decodeURIComponent(rest.join('='));
            });
        }
        next();
    });

    // Static files
    app.use(express.static(path.join(__dirname, '..', 'public')));

    // View engine
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));

    // Routes
    const apiRoutes = require('./routes/api');
    const pageRoutes = require('./routes/pages');

    app.use('/api', apiRoutes);
    app.use('/', pageRoutes);

    // Socket.io connection handling
    io.on('connection', (socket) => {
        // Send current state on connect
        socket.emit('throne_state', gameEngine.getThoneState());

        socket.on('request_state', () => {
            socket.emit('throne_state', gameEngine.getThoneState());
        });

        socket.on('disconnect', () => {
            // cleanup if needed
        });
    });

    // Start server
    server.listen(PORT, () => {
        console.log(`\n🏰 960 Throne running on http://localhost:${PORT}`);
        console.log(`   👑 Throne:      http://localhost:${PORT}/throne`);
        console.log(`   📋 Queue:       http://localhost:${PORT}/queue`);
        console.log(`   🏆 Leaderboard: http://localhost:${PORT}/leaderboard`);
        console.log(`   🔧 Admin:       http://localhost:${PORT}/admin`);
        console.log(`\n   Sat rate: ${db.getConfig('sat_rate_per_second')} sats/sec`);
        console.log(`   Time control: ${db.getConfig('time_control_base')}+${db.getConfig('time_control_increment')}`);
        console.log('');
    });
}

start().catch(err => {
    console.error('Failed to start:', err);
    process.exit(1);
});
