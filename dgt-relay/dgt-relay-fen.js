#!/usr/bin/env node
/**
 * DGT Relay — FEN Input → 960 Throne Server
 * 
 * Nuclear fallback: manually type or paste a FEN string and it pushes to the server.
 * Also watches a file for changes — if any DGT tool can export FEN to a file, 
 * point this at that file and it auto-pushes.
 * 
 * USAGE:
 *   Interactive mode:  node dgt-relay-fen.js
 *   File watch mode:   node dgt-relay-fen.js /path/to/fen-file.txt
 *   One-shot:          echo "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR" | node dgt-relay-fen.js --stdin
 * 
 * ENVIRONMENT VARIABLES:
 *   SERVER_URL    - 960 Throne server URL (default: https://960throne-production.up.railway.app)
 *   RELAY_SECRET  - Authentication secret (default: throne960)
 */

const fs = require('fs');
const readline = require('readline');

// ─── Configuration ───────────────────────────────────────────
const SERVER_URL   = process.env.SERVER_URL   || 'https://960throne-production.up.railway.app';
const RELAY_SECRET = process.env.RELAY_SECRET || 'throne960';

let lastFen = null;

// ─── Push to Server ──────────────────────────────────────────

async function pushToServer(fen) {
    // Validate it looks like a FEN (at least has 7 slashes for 8 ranks)
    const placement = fen.split(' ')[0];
    if ((placement.match(/\//g) || []).length !== 7) {
        console.log('⚠️  Invalid FEN (need 8 ranks separated by /). Try again.');
        return;
    }
    
    if (placement === lastFen) {
        console.log('   (no change)');
        return;
    }
    lastFen = placement;
    
    try {
        const res = await fetch(`${SERVER_URL}/api/dgt/board-state`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-relay-secret': RELAY_SECRET,
            },
            body: JSON.stringify({
                fen: fen.trim(),
                source: 'manual',
            }),
        });
        
        const data = await res.json();
        if (data.error) {
            console.error('❌ Server error:', data.error);
        } else {
            console.log(`♟️  Board updated → ${placement.substring(0, 40)}`);
        }
    } catch (err) {
        console.error('❌ Server push failed:', err.message);
    }
}

// ─── File Watch Mode ─────────────────────────────────────────

function watchFile(filePath) {
    console.log(`👁️  Watching file: ${filePath}`);
    console.log('   Edit the file with a FEN string and it will auto-push.');
    
    // Read initial content
    if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8').trim();
        if (content) pushToServer(content);
    }
    
    // Watch for changes
    fs.watchFile(filePath, { interval: 1000 }, () => {
        try {
            const content = fs.readFileSync(filePath, 'utf8').trim();
            if (content) pushToServer(content);
        } catch (e) {
            // File may be temporarily unavailable
        }
    });
}

// ─── Interactive Mode ────────────────────────────────────────

function interactiveMode() {
    console.log('Type or paste a FEN string and press Enter.');
    console.log('Example: rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR');
    console.log('Type "quit" to exit.\n');
    
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: 'FEN> ',
    });
    
    rl.prompt();
    
    rl.on('line', async (line) => {
        const input = line.trim();
        if (input === 'quit' || input === 'exit') {
            console.log('Bye!');
            process.exit(0);
        }
        if (input) {
            await pushToServer(input);
        }
        rl.prompt();
    });
    
    rl.on('close', () => process.exit(0));
}

// ─── Stdin Pipe Mode ─────────────────────────────────────────

function stdinMode() {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', async () => {
        const fen = data.trim();
        if (fen) {
            await pushToServer(fen);
        }
        process.exit(0);
    });
}

// ─── Start ───────────────────────────────────────────────────

console.log('');
console.log('╔══════════════════════════════════════════╗');
console.log('║   DGT Relay — FEN Input → 960 Throne    ║');
console.log('╠══════════════════════════════════════════╣');
console.log(`║  Server: ${SERVER_URL.substring(0, 31).padEnd(31)} ║`);
console.log('╚══════════════════════════════════════════╝');
console.log('');

const args = process.argv.slice(2);

if (args.includes('--stdin')) {
    stdinMode();
} else if (args.length > 0 && !args[0].startsWith('-')) {
    watchFile(args[0]);
} else {
    interactiveMode();
}
