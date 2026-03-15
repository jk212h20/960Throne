/**
 * DGT Board Integration — LiveChessCloud feed
 * 
 * Polls LiveChessCloud API for live game data from a DGT electronic board.
 * Replays moves using chess.js to derive the current FEN position.
 * Broadcasts position + clock updates via Socket.io.
 * 
 * LiveChessCloud API pattern:
 *   Tournament: https://1.pool.livechesscloud.com/get/{id}/tournament.json
 *   Round:      https://1.pool.livechesscloud.com/get/{id}/round-{n}/index.json
 *   Game:       https://1.pool.livechesscloud.com/get/{id}/round-{n}/game-{n}.json
 * 
 * Game JSON format:
 *   { live, chess960, moves: ["e4 180+0", "e5 179+2", ...], clock: { white, black, run, time }, result }
 */

const { Chess } = require('chess.js');
const chess960 = require('./chess960');

let io = null;
let db = null;
let pollTimer = null;

// Current state — what we last broadcast
let currentState = {
    connected: false,
    fen: null,
    board: null,       // 8x8 array for template rendering
    clock: null,       // { white, black, run, time }
    moves: [],         // raw move list from LCC
    moveCount: 0,
    chess960Position: null,
    lastMove: null,    // { from, to } for highlighting
    players: null,     // { white: { name }, black: { name } }
    result: null,
    tournamentId: null,
    error: null,
};

const POLL_INTERVAL = 3000; // 3 seconds
const POOL_URL = 'https://1.pool.livechesscloud.com/get';

/**
 * Initialize the DGT board service
 */
function init(socketIo, database) {
    io = socketIo;
    db = database;
    
    // Check if there's a configured tournament ID
    const tournamentId = db.getConfig('dgt_tournament_id');
    if (tournamentId) {
        startPolling(tournamentId);
    }
    
    console.log('♟️  DGT Board service initialized' + (tournamentId ? ` (tournament: ${tournamentId})` : ' (no tournament configured)'));
}

/**
 * Set tournament ID and start polling
 */
function setTournament(tournamentId) {
    stopPolling();
    db.setConfig('dgt_tournament_id', tournamentId || '');
    
    if (tournamentId) {
        currentState = { ...currentState, tournamentId, connected: false, error: null };
        startPolling(tournamentId);
        console.log(`♟️  DGT: Watching tournament ${tournamentId}`);
    } else {
        currentState = { connected: false, fen: null, board: null, clock: null, moves: [], moveCount: 0, chess960Position: null, lastMove: null, players: null, result: null, tournamentId: null, error: null };
        broadcast();
        console.log('♟️  DGT: Stopped watching');
    }
    
    return currentState;
}

/**
 * Start polling the LiveChessCloud API
 */
function startPolling(tournamentId) {
    if (pollTimer) clearInterval(pollTimer);
    
    // Poll immediately, then on interval
    pollGame(tournamentId);
    pollTimer = setInterval(() => pollGame(tournamentId), POLL_INTERVAL);
}

function stopPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

/**
 * Poll the latest game data from LiveChessCloud
 */
async function pollGame(tournamentId) {
    try {
        // First get tournament info to find the latest round
        const tournamentUrl = `${POOL_URL}/${tournamentId}/tournament.json`;
        const tRes = await fetch(tournamentUrl);
        if (!tRes.ok) {
            throw new Error(`Tournament fetch failed: ${tRes.status}`);
        }
        const tournament = await tRes.json();
        
        // Find the latest round with live games
        const rounds = tournament.rounds || [];
        let latestRound = rounds.length; // 1-indexed
        
        // Get round index to find which game is live
        const roundUrl = `${POOL_URL}/${tournamentId}/round-${latestRound}/index.json`;
        const rRes = await fetch(roundUrl);
        if (!rRes.ok) {
            throw new Error(`Round fetch failed: ${rRes.status}`);
        }
        const roundData = await rRes.json();
        
        // Find the live game (or last game)
        const pairings = roundData.pairings || [];
        let gameIndex = pairings.findIndex(p => p.live === true);
        if (gameIndex === -1) gameIndex = pairings.length - 1;
        if (gameIndex === -1) {
            currentState.connected = true;
            currentState.error = 'No games in round';
            broadcast();
            return;
        }
        
        const pairing = pairings[gameIndex];
        
        // Get the game data
        const gameUrl = `${POOL_URL}/${tournamentId}/round-${latestRound}/game-${gameIndex + 1}.json`;
        const gRes = await fetch(gameUrl);
        if (!gRes.ok) {
            throw new Error(`Game fetch failed: ${gRes.status}`);
        }
        const gameData = await gRes.json();
        
        // Check if moves changed (avoid unnecessary processing)
        const newMoveCount = (gameData.moves || []).length;
        const movesChanged = newMoveCount !== currentState.moveCount || 
                            gameData.result !== currentState.result ||
                            !currentState.fen;
        
        if (movesChanged) {
            // Replay moves to get current position
            const position = replayMoves(gameData.chess960, gameData.moves || []);
            
            currentState = {
                connected: true,
                fen: position.fen,
                board: position.board,
                clock: gameData.clock || null,
                moves: gameData.moves || [],
                moveCount: newMoveCount,
                chess960Position: gameData.chess960,
                lastMove: position.lastMove,
                players: {
                    white: { name: formatPlayerName(pairing.white) },
                    black: { name: formatPlayerName(pairing.black) },
                },
                result: gameData.result,
                tournamentId,
                error: null,
            };
            
            broadcast();
        } else if (gameData.clock) {
            // Only clock changed — update clock without full rebroadcast
            const clockChanged = !currentState.clock || 
                                gameData.clock.white !== currentState.clock.white ||
                                gameData.clock.black !== currentState.clock.black;
            if (clockChanged) {
                currentState.clock = gameData.clock;
                currentState.connected = true;
                currentState.error = null;
                broadcast();
            }
        }
        
    } catch (err) {
        if (currentState.connected !== false || currentState.error !== err.message) {
            currentState.error = err.message;
            // Don't set connected=false on transient errors — keep showing last position
            console.warn('♟️  DGT poll error:', err.message);
        }
    }
}

/**
 * Replay moves from a Chess960 starting position to get current FEN
 */
function replayMoves(chess960Num, rawMoves) {
    // Build starting FEN from Chess960 position number
    const pieces = chess960.positionFromNumber(chess960Num || 518);
    const backRank = pieces.join('').toLowerCase();
    const whiteRank = pieces.join('');
    const startFen = `${backRank}/pppppppp/8/8/8/8/PPPPPPPP/${whiteRank} w KQkq - 0 1`;
    
    const chess = new Chess(startFen);
    let lastMove = null;
    
    for (const raw of rawMoves) {
        // Format: "e4 180+2" or "O-O 170+2" or just "e4"
        const san = raw.split(' ')[0];
        try {
            const move = chess.move(san);
            if (move) {
                lastMove = { from: move.from, to: move.to };
            }
        } catch (e) {
            console.warn(`♟️  DGT: Failed to replay move "${san}":`, e.message);
            break;
        }
    }
    
    return {
        fen: chess.fen(),
        board: fenToBoard(chess.fen()),
        lastMove,
    };
}

/**
 * Convert FEN to 8x8 board array for template rendering
 * Returns array of 8 rows (rank 8 to rank 1), each row is array of 8 squares
 * Each square: { piece: 'K'|'q'|null, color: 'w'|'b'|null, square: 'a8' }
 */
function fenToBoard(fen) {
    const placement = fen.split(' ')[0];
    const rows = placement.split('/');
    const files = 'abcdefgh';
    const board = [];
    
    for (let rank = 0; rank < 8; rank++) {
        const row = [];
        let fileIdx = 0;
        
        for (const ch of rows[rank]) {
            if (ch >= '1' && ch <= '8') {
                for (let i = 0; i < parseInt(ch); i++) {
                    row.push({
                        piece: null,
                        color: null,
                        square: files[fileIdx] + (8 - rank),
                    });
                    fileIdx++;
                }
            } else {
                const isWhite = ch === ch.toUpperCase();
                row.push({
                    piece: ch.toUpperCase(),
                    color: isWhite ? 'w' : 'b',
                    square: files[fileIdx] + (8 - rank),
                });
                fileIdx++;
            }
        }
        
        board.push(row);
    }
    
    return board;
}

/**
 * Format player name from LiveChessCloud pairing data
 */
function formatPlayerName(player) {
    if (!player) return 'Unknown';
    const parts = [];
    if (player.fname) parts.push(player.fname);
    if (player.lname) parts.push(player.lname);
    return parts.join(' ') || 'Unknown';
}

/**
 * Broadcast current state to all connected clients
 */
function broadcast() {
    if (io) {
        io.emit('dgt_position', {
            fen: currentState.fen,
            board: currentState.board,
            clock: currentState.clock,
            moveCount: currentState.moveCount,
            lastMove: currentState.lastMove,
            players: currentState.players,
            result: currentState.result,
            chess960Position: currentState.chess960Position,
            connected: currentState.connected,
            error: currentState.error,
        });
    }
}

/**
 * Get current state (for initial page load / API)
 */
function getState() {
    return { ...currentState };
}

/**
 * Format clock seconds to mm:ss
 */
function formatClock(seconds) {
    if (seconds == null) return '--:--';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

module.exports = {
    init,
    setTournament,
    getState,
    formatClock,
    stopPolling,
};
