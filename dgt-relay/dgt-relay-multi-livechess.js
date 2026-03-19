#!/usr/bin/env node
/**
 * DGT Multi-Board Relay — LiveChess WebSocket → 960 Throne Server
 * 
 * Connects to DGT LiveChess, discovers ALL connected boards (up to 9),
 * subscribes to each one, and pushes their positions to the server
 * using the multi-board API: POST /api/dgt/boards/:boardId/state
 * 
 * The stream operator then visits /boards on the server to see all boards,
 * and /boards/:id for a clean full-screen view of any single board.
 * 
 * REQUIREMENTS:
 *   - DGT LiveChess software running (with all boards connected in series)
 *   - Node.js 18+ with 'ws' package: npm install ws
 * 
 * USAGE:
 *   node dgt-relay-multi-livechess.js
 * 
 * ENVIRONMENT VARIABLES (or edit constants below):
 *   SERVER_URL    - 960 Throne server (default: https://960throne-production.up.railway.app)
 *   RELAY_SECRET  - Auth secret (default: throne960)
 *   LIVECHESS_URL - LiveChess WebSocket (default: ws://localhost:1982/api/v1.0)
 */

const WebSocket = require('ws');

// ─── Configuration ───────────────────────────────────────────
const SERVER_URL    = process.env.SERVER_URL    || 'https://960throne-production.up.railway.app';
const RELAY_SECRET  = process.env.RELAY_SECRET  || 'throne960';
const LIVECHESS_URL = process.env.LIVECHESS_URL || 'ws://localhost:1982/api/v1.0';

// ─── State ───────────────────────────────────────────────────
let ws = null;
let reconnectTimer = null;

// Map: feedId → { boardId, lastFen, label, subscribed }
const boards = new Map();

// Message ID counter (LiveChess uses numeric IDs to match request/response)
let nextMsgId = 10;

// Track which message IDs map to which actions
const pendingCalls = new Map(); // msgId → { action, feedId? }

// ─── LiveChess Protocol ──────────────────────────────────────

function connect() {
    console.log(`🔌 Connecting to LiveChess at ${LIVECHESS_URL}...`);
    
    try {
        ws = new WebSocket(LIVECHESS_URL);
    } catch (e) {
        console.error('❌ WebSocket error. Install ws: npm install ws');
        process.exit(1);
    }
    
    ws.on('open', () => {
        console.log('✅ Connected to LiveChess');
        boards.clear();
        // Request the list of feeds (connected boards)
        const id = nextMsgId++;
        pendingCalls.set(id, { action: 'eboards' });
        send({ call: 'eboards', id, param: {} });
    });
    
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            handleMessage(msg);
        } catch (e) {
            // Binary or non-JSON — ignore
        }
    });
    
    ws.on('close', () => {
        console.log('🔌 LiveChess disconnected. Reconnecting in 5s...');
        scheduleReconnect();
    });
    
    ws.on('error', (err) => {
        console.error('❌ LiveChess error:', err.message);
        if (err.code === 'ECONNREFUSED') {
            console.log('   Is DGT LiveChess running? Check http://localhost:1982');
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
    // Check if this is a response to a pending call
    const pending = pendingCalls.get(msg.id);
    
    // ── eboards response: list of connected board feeds ──
    if (pending && pending.action === 'eboards') {
        pendingCalls.delete(msg.id);
        let feeds = [];
        
        if (msg.param) {
            if (Array.isArray(msg.param)) {
                feeds = msg.param;
            } else if (msg.param.feeds && Array.isArray(msg.param.feeds)) {
                feeds = msg.param.feeds;
            }
        }
        
        if (feeds.length === 0) {
            console.log('⚠️  No boards found. Retrying in 5s...');
            setTimeout(() => {
                const id = nextMsgId++;
                pendingCalls.set(id, { action: 'eboards' });
                send({ call: 'eboards', id, param: {} });
            }, 5000);
            return;
        }
        
        console.log(`♟️  Found ${feeds.length} board(s)`);
        
        feeds.forEach((feed, index) => {
            const feedId = feed.id || feed.serialnr || feed;
            // Use serial number as stable board ID, fall back to feed ID
            const boardId = feed.serialnr || feed.id || `board-${index + 1}`;
            const label = feed.description || `Board ${index + 1}`;
            
            boards.set(feedId, {
                boardId: String(boardId),
                lastFen: null,
                label,
                subscribed: false,
            });
            
            console.log(`  Board ${index + 1}: feedId=${feedId}, boardId=${boardId}, ${label}`);
            
            // Subscribe to this board's updates
            const subId = nextMsgId++;
            pendingCalls.set(subId, { action: 'subscribe', feedId });
            send({ call: 'subscribe', id: subId, param: { feed: feedId, param: { board: true, san: false } } });
        });
        return;
    }
    
    // ── subscribe response ──
    if (pending && pending.action === 'subscribe') {
        pendingCalls.delete(msg.id);
        const board = boards.get(pending.feedId);
        if (board) {
            board.subscribed = true;
            console.log(`📡 Subscribed to ${board.boardId} (${board.label})`);
            
            // Request current board state
            const feedReqId = nextMsgId++;
            pendingCalls.set(feedReqId, { action: 'feed', feedId: pending.feedId });
            send({ call: 'feed', id: feedReqId, param: { id: pending.feedId } });
        }
        return;
    }
    
    // ── feed response (current board state) ──
    if (pending && pending.action === 'feed') {
        pendingCalls.delete(msg.id);
        if (msg.param) {
            const fen = msg.param.fen || (msg.param.board ? boardToFen(msg.param.board) : null);
            const clock = extractClock(msg.param);
            const board = boards.get(pending.feedId);
            if (fen && board) {
                board.lastFen = fen;
                pushToServer(board.boardId, fen, board.label, clock);
            }
        }
        return;
    }
    
    // ── Subscription push (board update from any board) ──
    // These don't have a matching pending call — they come as feed events
    if (msg.param && (msg.param.board || msg.param.fen || msg.param.clock)) {
        // Determine which board this came from
        const feedId = msg.param.feed || msg.param.id;
        let board = boards.get(feedId);
        
        // If we can't identify by feedId, try matching by the message structure
        if (!board && boards.size === 1) {
            board = boards.values().next().value;
        }
        
        if (board) {
            const fen = msg.param.fen || boardToFen(msg.param.board);
            const clock = extractClock(msg.param);
            if (fen && fen !== board.lastFen) {
                board.lastFen = fen;
                pushToServer(board.boardId, fen, board.label, clock);
            } else if (clock) {
                // Clock update without board change — still push
                pushToServer(board.boardId, board.lastFen, board.label, clock);
            }
        }
        return;
    }
}

/**
 * Convert LiveChess board array to FEN placement string.
 * LiveChess board: 64-char string, index 0=a8, index 63=h1.
 * Uppercase=white, lowercase=black, '.'=empty.
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

// ─── Clock Extraction ────────────────────────────────────────

/**
 * Extract clock data from a LiveChess message param.
 * LiveChess clock format varies — handle known formats.
 * Returns { white, black } in seconds, or null if no clock data.
 */
function extractClock(param) {
    if (!param) return null;
    
    // Direct clock object: { white: seconds, black: seconds }
    if (param.clock && typeof param.clock === 'object') {
        const w = param.clock.white != null ? Number(param.clock.white) : null;
        const b = param.clock.black != null ? Number(param.clock.black) : null;
        if (w != null || b != null) {
            return {
                white: w,
                black: b,
                running: param.clock.running != null ? param.clock.running : null,
                activeSide: param.clock.activeSide || null,
            };
        }
    }
    
    // Clock as separate fields
    if (param.whiteTime != null || param.blackTime != null) {
        return {
            white: param.whiteTime != null ? Number(param.whiteTime) : null,
            black: param.blackTime != null ? Number(param.blackTime) : null,
        };
    }
    
    return null;
}

// ─── Push to Server ──────────────────────────────────────────

async function pushToServer(boardId, fen, label, clock) {
    if (!fen) return; // Nothing to push
    try {
        const body = {
            fen,
            label,
            source: 'livechess-multi',
        };
        if (clock) body.clock = clock;
        
        const res = await fetch(`${SERVER_URL}/api/dgt/boards/${encodeURIComponent(boardId)}/state`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-relay-secret': RELAY_SECRET,
            },
            body: JSON.stringify(body),
        });
        
        const data = await res.json();
        if (data.changed) {
            const shortFen = fen.split(' ')[0].substring(0, 24);
            const clockStr = clock ? ` ⏱ W:${formatSec(clock.white)} B:${formatSec(clock.black)}` : '';
            console.log(`♟️  [${boardId}] → ${shortFen}...${clockStr}`);
        }
    } catch (err) {
        console.error(`❌ [${boardId}] Push failed: ${err.message}`);
    }
}

function formatSec(s) {
    if (s == null) return '--:--';
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m + ':' + String(sec).padStart(2, '0');
}

// ─── Periodic re-scan for new boards ─────────────────────────
// Every 30s, re-request eboards to pick up newly connected boards
setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        const id = nextMsgId++;
        pendingCalls.set(id, { action: 'eboards' });
        send({ call: 'eboards', id, param: {} });
    }
}, 30000);

// ─── Reconnect ───────────────────────────────────────────────

function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, 5000);
}

// ─── Start ───────────────────────────────────────────────────

console.log('');
console.log('╔═══════════════════════════════════════════════╗');
console.log('║  DGT Multi-Board Relay — LiveChess → Server  ║');
console.log('╠═══════════════════════════════════════════════╣');
console.log(`║  Server:    ${SERVER_URL.substring(0, 33).padEnd(33)} ║`);
console.log(`║  LiveChess: ${LIVECHESS_URL.substring(0, 33).padEnd(33)} ║`);
console.log('║  Boards:    Auto-discover (up to 9)           ║');
console.log('╚═══════════════════════════════════════════════╝');
console.log('');
console.log('Stream operator pages:');
console.log(`  All boards: ${SERVER_URL}/boards`);
console.log(`  Per board:  ${SERVER_URL}/boards/<boardId>`);
console.log('');

connect();
