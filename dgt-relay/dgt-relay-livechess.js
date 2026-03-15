#!/usr/bin/env node
/**
 * DGT Relay — LiveChess WebSocket → 960 Throne Server
 * 
 * Connects to DGT LiveChess software running on this computer,
 * reads the board position, and pushes it to the 960 Throne server.
 * 
 * REQUIREMENTS:
 *   - DGT LiveChess software running on this computer
 *   - DGT board connected via USB or Bluetooth
 *   - Node.js 18+ installed
 *   - No npm packages needed (uses built-in WebSocket and fetch)
 * 
 * USAGE:
 *   node dgt-relay-livechess.js
 * 
 * ENVIRONMENT VARIABLES (or edit the constants below):
 *   SERVER_URL    - 960 Throne server URL (default: https://960throne-production.up.railway.app)
 *   RELAY_SECRET  - Authentication secret (default: throne960)
 *   LIVECHESS_URL - LiveChess WebSocket URL (default: ws://localhost:1982/api/v1.0)
 *   POLL_MS       - How often to push board state in ms (default: 1000)
 */

const WebSocket = require('ws') || globalThis.WebSocket;

// ─── Configuration ───────────────────────────────────────────
const SERVER_URL   = process.env.SERVER_URL   || 'https://960throne-production.up.railway.app';
const RELAY_SECRET = process.env.RELAY_SECRET || 'throne960';
const LIVECHESS_URL = process.env.LIVECHESS_URL || 'ws://localhost:1982/api/v1.0';
const POLL_MS      = parseInt(process.env.POLL_MS || '1000');

// ─── State ───────────────────────────────────────────────────
let ws = null;
let lastFen = null;
let reconnectTimer = null;
let feedId = null;

// ─── LiveChess Protocol ──────────────────────────────────────

function connect() {
    console.log(`🔌 Connecting to LiveChess at ${LIVECHESS_URL}...`);
    
    try {
        ws = new WebSocket(LIVECHESS_URL);
    } catch (e) {
        console.error('❌ WebSocket not available. Install ws: npm install ws');
        console.error('   Or use Node 22+ which has built-in WebSocket.');
        process.exit(1);
    }
    
    ws.on('open', () => {
        console.log('✅ Connected to LiveChess');
        // Request the list of feeds (connected boards)
        send({ call: 'eboards', id: 1, param: {} });
    });
    
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            handleMessage(msg);
        } catch (e) {
            // Binary or non-JSON message — ignore
        }
    });
    
    ws.on('close', () => {
        console.log('🔌 LiveChess connection closed. Reconnecting in 5s...');
        scheduleReconnect();
    });
    
    ws.on('error', (err) => {
        console.error('❌ LiveChess error:', err.message);
        if (err.code === 'ECONNREFUSED') {
            console.log('   Is DGT LiveChess software running?');
            console.log('   Check: http://localhost:1982 in your browser');
        }
        scheduleReconnect();
    });
}

function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    }
}

function handleMessage(msg) {
    // Response to eboards call — list of connected boards
    if (msg.id === 1 && msg.param) {
        const boards = msg.param;
        if (Array.isArray(boards) && boards.length > 0) {
            feedId = boards[0].id || boards[0];
            console.log(`♟️  Found board feed: ${feedId}`);
            // Subscribe to board updates
            send({ call: 'subscribe', id: 2, param: { feed: feedId, param: { board: true, san: false } } });
        } else if (msg.param.feeds) {
            // Alternative response format
            const feeds = msg.param.feeds;
            if (feeds.length > 0) {
                feedId = feeds[0].id || feeds[0];
                console.log(`♟️  Found board feed: ${feedId}`);
                send({ call: 'subscribe', id: 2, param: { feed: feedId, param: { board: true, san: false } } });
            }
        } else {
            console.log('⚠️  No boards connected. Waiting...');
            // Poll again in 5 seconds
            setTimeout(() => send({ call: 'eboards', id: 1, param: {} }), 5000);
        }
        return;
    }
    
    // Subscription confirmation
    if (msg.id === 2) {
        console.log('📡 Subscribed to board updates');
        // Also request current board state immediately
        if (feedId) {
            send({ call: 'feed', id: 3, param: { id: feedId } });
        }
        return;
    }
    
    // Board update (subscription push or feed response)
    if (msg.param && (msg.param.board || msg.param.fen)) {
        const fen = msg.param.fen || boardToFen(msg.param.board);
        if (fen && fen !== lastFen) {
            lastFen = fen;
            pushToServer(fen);
        }
        return;
    }
    
    // Board state from feed call
    if (msg.id === 3 && msg.param) {
        const fen = msg.param.fen || (msg.param.board ? boardToFen(msg.param.board) : null);
        if (fen) {
            lastFen = fen;
            pushToServer(fen);
        }
        return;
    }
}

/**
 * Convert LiveChess board array to FEN string.
 * LiveChess board is a 64-char string or array: uppercase=white, lowercase=black, '.'=empty
 * Index 0 = a8, index 63 = h1
 */
function boardToFen(board) {
    if (!board) return null;
    
    const squares = typeof board === 'string' ? board.split('') : board;
    if (squares.length !== 64) return null;
    
    let fen = '';
    for (let rank = 0; rank < 8; rank++) {
        let empty = 0;
        for (let file = 0; file < 8; file++) {
            const piece = squares[rank * 8 + file];
            if (!piece || piece === '.' || piece === ' ') {
                empty++;
            } else {
                if (empty > 0) { fen += empty; empty = 0; }
                fen += piece;
            }
        }
        if (empty > 0) fen += empty;
        if (rank < 7) fen += '/';
    }
    
    return fen;
}

// ─── Push to 960 Throne Server ───────────────────────────────

async function pushToServer(fen) {
    try {
        const res = await fetch(`${SERVER_URL}/api/dgt/board-state`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-relay-secret': RELAY_SECRET,
            },
            body: JSON.stringify({
                fen,
                source: 'livechess',
            }),
        });
        
        const data = await res.json();
        if (data.changed) {
            console.log(`♟️  Board updated → ${fen.split(' ')[0].substring(0, 30)}...`);
        }
    } catch (err) {
        console.error('❌ Server push failed:', err.message);
    }
}

// ─── Reconnect Logic ─────────────────────────────────────────

function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, 5000);
}

// ─── Start ───────────────────────────────────────────────────

console.log('');
console.log('╔══════════════════════════════════════════╗');
console.log('║   DGT Relay — LiveChess → 960 Throne    ║');
console.log('╠══════════════════════════════════════════╣');
console.log(`║  Server:    ${SERVER_URL.substring(0, 28).padEnd(28)} ║`);
console.log(`║  LiveChess: ${LIVECHESS_URL.substring(0, 28).padEnd(28)} ║`);
console.log('╚══════════════════════════════════════════╝');
console.log('');

connect();
