#!/usr/bin/env node
/**
 * DGT Relay — Direct USB Serial → 960 Throne Server
 * 
 * Connects directly to a DGT board via USB serial port,
 * reads the raw board position AND clock times using DGT protocol,
 * and pushes both to the 960 Throne server.
 * 
 * PROTOCOL MODES (from DGT spec):
 *   - DGT_SEND_UPDATE_NICE (0x4b): Board sends field updates + clock data
 *     (clock only when it changes). This is our primary mode.
 *   - DGT_SEND_CLK (0x41): Explicit clock request → DGT_MSG_BWTIME response
 *   - DGT_SEND_BRD (0x42): Full board dump → DGT_MSG_BOARD_DUMP response
 * 
 * REQUIREMENTS:
 *   - DGT board connected via USB (NOT Bluetooth)
 *   - DGT 3000 clock connected to the board
 *   - Node.js 18+ installed
 *   - npm install serialport   (in this directory)
 *   - LiveChess software should NOT be running (it locks the port)
 * 
 * USAGE:
 *   npm install serialport
 *   node dgt-relay-serial.js
 * 
 * ENVIRONMENT VARIABLES:
 *   SERVER_URL    - 960 Throne server URL (default: https://960throne-production.up.railway.app)
 *   RELAY_SECRET  - Authentication secret (default: throne960)
 *   SERIAL_PORT   - Serial port path (auto-detected if not set)
 *   POLL_MS       - How often to request full board dump in ms (default: 5000)
 *   CLOCK_POLL_MS - How often to explicitly request clock in ms (default: 1000)
 */

// ─── Configuration ───────────────────────────────────────────
const SERVER_URL    = process.env.SERVER_URL    || 'https://960throne-production.up.railway.app';
const RELAY_SECRET  = process.env.RELAY_SECRET  || 'throne960';
const SERIAL_PORT   = process.env.SERIAL_PORT   || null; // auto-detect
const POLL_MS       = parseInt(process.env.POLL_MS || '5000');
const CLOCK_POLL_MS = parseInt(process.env.CLOCK_POLL_MS || '1000');

// ─── DGT Protocol Constants ─────────────────────────────────
// Commands (PC → Board)
const DGT_SEND_RESET       = 0x40; // Reset to IDLE mode
const DGT_SEND_CLK         = 0x41; // Request clock → DGT_MSG_BWTIME
const DGT_SEND_BRD         = 0x42; // Request full board dump → DGT_MSG_BOARD_DUMP
const DGT_SEND_UPDATE      = 0x43; // UPDATE mode: field updates + clock every second
const DGT_SEND_UPDATE_BRD  = 0x44; // UPDATE_BOARD mode: field updates only (no clock)
const DGT_SEND_UPDATE_NICE = 0x4b; // UPDATE_NICE mode: field updates + clock on change

// Response message IDs (Board → PC) — these have MSB set in actual byte (|0x80)
const DGT_MSG_BOARD_DUMP   = 0x86; // 0x80 | 0x06
const DGT_MSG_BWTIME       = 0x8d; // 0x80 | 0x0d
const DGT_MSG_FIELD_UPDATE = 0x8e; // 0x80 | 0x0e
const DGT_MSG_VERSION      = 0x93; // 0x80 | 0x13

// Message sizes
const DGT_SIZE_BOARD_DUMP   = 67;
const DGT_SIZE_BWTIME       = 10;
const DGT_SIZE_FIELD_UPDATE = 5;

// Piece encoding in DGT protocol
const DGT_PIECES = {
    0x00: null,  // empty
    0x01: 'wP', 0x02: 'wR', 0x03: 'wN', 0x04: 'wB', 0x05: 'wK', 0x06: 'wQ',
    0x07: 'bP', 0x08: 'bR', 0x09: 'bN', 0x0A: 'bB', 0x0B: 'bK', 0x0C: 'bQ',
};

// ─── State ───────────────────────────────────────────────────
let port = null;
let lastFen = null;
let lastClock = null; // { white, black } in seconds
let board = new Array(64).fill(null);
let buffer = Buffer.alloc(0);

// ─── Serial Port Setup ──────────────────────────────────────

async function findDgtPort() {
    let SerialPort, list;
    try {
        const sp = require('serialport');
        SerialPort = sp.SerialPort;
        list = await sp.SerialPort.list();
    } catch (e) {
        console.error('❌ serialport package not found. Install it:');
        console.error('   npm install serialport');
        process.exit(1);
    }
    
    if (SERIAL_PORT) {
        console.log(`📟 Using configured port: ${SERIAL_PORT}`);
        return { path: SERIAL_PORT, SerialPort };
    }
    
    console.log('🔍 Scanning for DGT board...');
    for (const p of list) {
        console.log(`   Found: ${p.path} — ${p.manufacturer || 'unknown'} (${p.vendorId || ''}:${p.productId || ''})`);
    }
    
    const dgtPort = list.find(p => 
        (p.manufacturer && p.manufacturer.toLowerCase().includes('dgt')) ||
        (p.manufacturer && p.manufacturer.toLowerCase().includes('ftdi')) ||
        (p.vendorId === '0403') ||
        (p.path && p.path.includes('usbserial')) ||
        (p.path && p.path.includes('ttyUSB'))
    );
    
    if (dgtPort) {
        console.log(`♟️  Auto-detected DGT board at: ${dgtPort.path}`);
        return { path: dgtPort.path, SerialPort };
    }
    
    if (list.length > 0) {
        console.log(`⚠️  No DGT board auto-detected. Trying first port: ${list[0].path}`);
        return { path: list[0].path, SerialPort };
    }
    
    console.error('❌ No serial ports found. Is the DGT board connected via USB?');
    process.exit(1);
}

async function connectSerial() {
    const { path, SerialPort } = await findDgtPort();
    
    console.log(`🔌 Opening ${path} at 9600 baud...`);
    
    port = new SerialPort({
        path,
        baudRate: 9600,
        dataBits: 8,
        parity: 'none',
        stopBits: 1,
    });
    
    port.on('open', () => {
        console.log('✅ Serial port open');
        
        // 1. Request initial full board dump
        sendCommand(DGT_SEND_BRD);
        
        // 2. Put board into UPDATE_NICE mode — sends field updates + clock on change
        setTimeout(() => {
            console.log('📡 Entering UPDATE_NICE mode (board + clock on change)...');
            sendCommand(DGT_SEND_UPDATE_NICE);
        }, 500);
        
        // 3. Request initial clock reading
        setTimeout(() => {
            sendCommand(DGT_SEND_CLK);
        }, 1000);
        
        // 4. Periodically request full board dump as safety net
        setInterval(() => sendCommand(DGT_SEND_BRD), POLL_MS);
        
        // 5. Periodically request clock (in case UPDATE_NICE misses changes)
        setInterval(() => sendCommand(DGT_SEND_CLK), CLOCK_POLL_MS);
    });
    
    port.on('data', (data) => {
        buffer = Buffer.concat([buffer, data]);
        parseBuffer();
    });
    
    port.on('error', (err) => {
        console.error('❌ Serial error:', err.message);
    });
    
    port.on('close', () => {
        console.log('🔌 Serial port closed. Exiting.');
        process.exit(1);
    });
}

function sendCommand(cmd) {
    if (port && port.isOpen) {
        port.write(Buffer.from([cmd]));
    }
}

// ─── DGT Protocol Parser ────────────────────────────────────

function parseBuffer() {
    while (buffer.length > 0) {
        const msgType = buffer[0];
        
        // All DGT messages have MSB set (0x80+)
        if ((msgType & 0x80) === 0) {
            // Not a valid message start — skip byte
            buffer = buffer.slice(1);
            continue;
        }
        
        // Need at least 3 bytes for header (type + 2-byte length)
        if (buffer.length < 3) return;
        
        // Length is 14-bit: byte1 has bits 13-7, byte2 has bits 6-0
        const msgLen = ((buffer[1] & 0x7f) << 7) | (buffer[2] & 0x7f);
        
        // Wait for complete message
        if (buffer.length < msgLen) return;
        
        // Extract full message
        const msg = buffer.slice(0, msgLen);
        buffer = buffer.slice(msgLen);
        
        // Route by message type
        switch (msgType) {
            case DGT_MSG_BOARD_DUMP:
                handleBoardDump(msg);
                break;
            case DGT_MSG_BWTIME:
                handleBwTime(msg);
                break;
            case DGT_MSG_FIELD_UPDATE:
                handleFieldUpdate(msg);
                break;
            default:
                // Unknown message type — already consumed, skip
                break;
        }
    }
}

/**
 * Handle DGT_MSG_BOARD_DUMP — full 64-square board state
 * Format: 3 header bytes + 64 piece bytes = 67 bytes
 */
function handleBoardDump(msg) {
    if (msg.length < DGT_SIZE_BOARD_DUMP) return;
    
    for (let i = 0; i < 64; i++) {
        board[i] = DGT_PIECES[msg[3 + i]] || null;
    }
    
    const fen = boardToFen();
    if (fen !== lastFen) {
        lastFen = fen;
        pushToServer(fen, lastClock);
    }
}

/**
 * Handle DGT_MSG_BWTIME — clock times for both players
 * 
 * From the DGT spec:
 * byte 3: Right player hours (BCD, D0-D3) + flags (D4-D6)
 *         If (byte3 & 0x0f) == 0x0a → this is a Clock Ack, not time data
 * byte 4: Right player minutes (BCD)
 * byte 5: Right player seconds (BCD)
 * byte 6-8: Same for left player
 *         If (byte6 & 0x0f) == 0x0a → this is a Clock Ack, not time data
 * byte 9: Status byte
 *   D0: 1=clock running, 0=stopped
 *   D1: 1=tumbler high on right (right player's clock visible/active from front)
 *   D3: 1=right player's turn
 *   D4: 1=left player's turn
 *   D5: 1=no clock connected (reading invalid)
 * 
 * NOTE: "left" and "right" are from the FRONT of the clock.
 * In standard setup, White is on the RIGHT side when viewed from the front.
 * So: right = White, left = Black.
 */
function handleBwTime(msg) {
    if (msg.length < DGT_SIZE_BWTIME) return;
    
    // Check if this is a Clock Ack instead of time data
    if ((msg[3] & 0x0f) === 0x0a || (msg[6] & 0x0f) === 0x0a) {
        // This is an ack response to a clock command, not time data
        return;
    }
    
    const status = msg[9];
    
    // Check if clock is connected (D5=1 means NO clock)
    if (status & 0x20) {
        // No clock connected
        return;
    }
    
    // Parse BCD time values
    // Right player (White in standard setup)
    const rightHours   = msg[3] & 0x0f; // D0-D3 only
    const rightMinutes = bcdToInt(msg[4]);
    const rightSeconds = bcdToInt(msg[5]);
    const rightTotal   = rightHours * 3600 + rightMinutes * 60 + rightSeconds;
    
    // Left player (Black in standard setup)
    const leftHours    = msg[6] & 0x0f;
    const leftMinutes  = bcdToInt(msg[7]);
    const leftSeconds  = bcdToInt(msg[8]);
    const leftTotal    = leftHours * 3600 + leftMinutes * 60 + leftSeconds;
    
    // Status flags
    const clockRunning  = !!(status & 0x01);
    const rightTurn     = !!(status & 0x08); // D3
    const leftTurn      = !!(status & 0x10); // D4
    
    // In standard DGT setup: right side = White, left side = Black
    const clock = {
        white: rightTotal,
        black: leftTotal,
        running: clockRunning,
        activeSide: rightTurn ? 'white' : (leftTurn ? 'black' : null),
    };
    
    // Check if clock actually changed (time values or running state)
    const changed = !lastClock || 
        clock.white !== lastClock.white || 
        clock.black !== lastClock.black ||
        clock.running !== lastClock.running ||
        clock.activeSide !== lastClock.activeSide;
    
    if (changed) {
        lastClock = clock;
        const activeStr = clock.activeSide || '?';
        console.log(`⏱️  Clock: White ${formatTime(clock.white)} | Black ${formatTime(clock.black)} [${activeStr}${clockRunning ? ' running' : ' stopped'}]`);
        pushToServer(lastFen, clock);
    }
}

/**
 * Handle DGT_MSG_FIELD_UPDATE — single square changed
 * Format: 3 header bytes + 1 field byte + 1 piece byte = 5 bytes
 */
function handleFieldUpdate(msg) {
    if (msg.length < DGT_SIZE_FIELD_UPDATE) return;
    
    const field = msg[3]; // 0-63
    const piece = msg[4];
    board[field] = DGT_PIECES[piece] || null;
    
    const fen = boardToFen();
    if (fen !== lastFen) {
        lastFen = fen;
        pushToServer(fen, lastClock);
    }
}

/**
 * Convert BCD byte to integer.
 * BCD: high nibble = tens, low nibble = units
 * e.g. 0x35 → 35
 */
function bcdToInt(byte) {
    return ((byte >> 4) & 0x0f) * 10 + (byte & 0x0f);
}

/**
 * Format seconds as mm:ss
 */
function formatTime(seconds) {
    if (seconds == null) return '--:--';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Convert board array to FEN.
 * board[0] = a8, board[63] = h1 (DGT standard layout)
 */
function boardToFen() {
    let fen = '';
    for (let rank = 0; rank < 8; rank++) {
        let empty = 0;
        for (let file = 0; file < 8; file++) {
            const piece = board[rank * 8 + file];
            if (!piece) {
                empty++;
            } else {
                if (empty > 0) { fen += empty; empty = 0; }
                const ch = piece[1]; // P, R, N, B, K, Q
                fen += piece[0] === 'w' ? ch.toUpperCase() : ch.toLowerCase();
            }
        }
        if (empty > 0) fen += empty;
        if (rank < 7) fen += '/';
    }
    return fen;
}

// ─── Push to Server ──────────────────────────────────────────

async function pushToServer(fen, clock) {
    if (!fen) return; // No board data yet
    
    const payload = { fen, source: 'serial' };
    if (clock) payload.clock = clock;
    
    try {
        const res = await fetch(`${SERVER_URL}/api/dgt/board-state`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-relay-secret': RELAY_SECRET,
            },
            body: JSON.stringify(payload),
        });
        
        const data = await res.json();
        if (data.changed) {
            console.log(`♟️  Server updated → ${fen.substring(0, 40)}...`);
        }
    } catch (err) {
        console.error('❌ Server push failed:', err.message);
    }
}

// ─── Start ───────────────────────────────────────────────────

console.log('');
console.log('╔══════════════════════════════════════════╗');
console.log('║   DGT Relay — USB Serial → 960 Throne   ║');
console.log('║   Board + Clock (UPDATE_NICE mode)       ║');
console.log('╠══════════════════════════════════════════╣');
console.log(`║  Server: ${SERVER_URL.substring(0, 31).padEnd(31)} ║`);
console.log(`║  Clock poll: every ${CLOCK_POLL_MS}ms${' '.repeat(19 - String(CLOCK_POLL_MS).length)}║`);
console.log('╚══════════════════════════════════════════╝');
console.log('');

connectSerial();
