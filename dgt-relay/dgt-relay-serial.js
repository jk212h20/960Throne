#!/usr/bin/env node
/**
 * DGT Relay — Direct USB Serial → 960 Throne Server
 * 
 * Connects directly to a DGT board via USB serial port,
 * reads the raw board position using DGT protocol, and pushes to server.
 * 
 * REQUIREMENTS:
 *   - DGT board connected via USB (NOT Bluetooth)
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
 *   POLL_MS       - How often to request board dump in ms (default: 2000)
 */

// ─── Configuration ───────────────────────────────────────────
const SERVER_URL   = process.env.SERVER_URL   || 'https://960throne-production.up.railway.app';
const RELAY_SECRET = process.env.RELAY_SECRET || 'throne960';
const SERIAL_PORT  = process.env.SERIAL_PORT  || null; // auto-detect
const POLL_MS      = parseInt(process.env.POLL_MS || '2000');

// ─── DGT Protocol Constants ─────────────────────────────────
// DGT protocol sends binary commands to the board and receives responses
const DGT_SEND_BOARD  = 0x42; // Request full board dump
const DGT_BOARD_DUMP  = 0x06; // Response: full board dump (64 bytes of piece data)
const DGT_SEND_UPDATE = 0x43; // Request board updates (changes only)
const DGT_FIELD_UPDATE = 0x0E; // Response: single field update
const DGT_SEND_RESET  = 0x40; // Reset board
const DGT_BUS_PING    = 0x4A; // Ping

// Piece encoding in DGT protocol
const DGT_PIECES = {
    0x00: null,  // empty
    0x01: 'wP', 0x02: 'wR', 0x03: 'wN', 0x04: 'wB', 0x05: 'wK', 0x06: 'wQ',
    0x07: 'bP', 0x08: 'bR', 0x09: 'bN', 0x0A: 'bB', 0x0B: 'bK', 0x0C: 'bQ',
};

// ─── State ───────────────────────────────────────────────────
let port = null;
let lastFen = null;
let board = new Array(64).fill(null); // Current board state
let buffer = Buffer.alloc(0); // Incoming data buffer

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
    
    // Auto-detect DGT board
    console.log('🔍 Scanning for DGT board...');
    for (const p of list) {
        console.log(`   Found: ${p.path} — ${p.manufacturer || 'unknown'} (${p.vendorId || ''}:${p.productId || ''})`);
    }
    
    // DGT boards typically show as FTDI or with specific vendor IDs
    const dgtPort = list.find(p => 
        (p.manufacturer && p.manufacturer.toLowerCase().includes('dgt')) ||
        (p.manufacturer && p.manufacturer.toLowerCase().includes('ftdi')) ||
        (p.vendorId === '0403') || // FTDI vendor ID
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
        // Request initial board dump
        requestBoardDump();
        // Then poll periodically
        setInterval(requestBoardDump, POLL_MS);
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

function requestBoardDump() {
    if (port && port.isOpen) {
        port.write(Buffer.from([DGT_SEND_BOARD]));
    }
}

// ─── DGT Protocol Parser ────────────────────────────────────

function parseBuffer() {
    while (buffer.length > 0) {
        const msgType = buffer[0];
        
        if (msgType === DGT_BOARD_DUMP) {
            // Board dump: 1 byte type + 2 bytes length + 64 bytes pieces = 67 bytes
            if (buffer.length < 67) return; // Wait for more data
            
            const pieces = buffer.slice(3, 67);
            for (let i = 0; i < 64; i++) {
                board[i] = DGT_PIECES[pieces[i]] || null;
            }
            
            buffer = buffer.slice(67);
            
            const fen = boardToFen();
            if (fen !== lastFen) {
                lastFen = fen;
                pushToServer(fen);
            }
        } else if (msgType === DGT_FIELD_UPDATE) {
            // Field update: 1 byte type + 2 bytes length + 1 byte field + 1 byte piece = 5 bytes
            if (buffer.length < 5) return;
            
            const field = buffer[3]; // 0-63
            const piece = buffer[4];
            board[field] = DGT_PIECES[piece] || null;
            
            buffer = buffer.slice(5);
            
            const fen = boardToFen();
            if (fen !== lastFen) {
                lastFen = fen;
                pushToServer(fen);
            }
        } else {
            // Unknown message or garbage — try to skip
            // DGT messages start with type byte, then 2-byte big-endian length
            if (buffer.length >= 3) {
                const len = (buffer[1] << 7) | buffer[2]; // DGT uses 7-bit encoding for length
                if (len > 0 && len <= buffer.length) {
                    buffer = buffer.slice(len);
                } else {
                    buffer = buffer.slice(1); // Skip one byte
                }
            } else {
                break;
            }
        }
    }
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
                // piece is like 'wP', 'bK' etc
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
                source: 'serial',
            }),
        });
        
        const data = await res.json();
        if (data.changed) {
            console.log(`♟️  Board updated → ${fen.substring(0, 40)}...`);
        }
    } catch (err) {
        console.error('❌ Server push failed:', err.message);
    }
}

// ─── Start ───────────────────────────────────────────────────

console.log('');
console.log('╔══════════════════════════════════════════╗');
console.log('║   DGT Relay — USB Serial → 960 Throne   ║');
console.log('╠══════════════════════════════════════════╣');
console.log(`║  Server: ${SERVER_URL.substring(0, 31).padEnd(31)} ║`);
console.log('╚══════════════════════════════════════════╝');
console.log('');

connectSerial();
