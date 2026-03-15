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

// Position verification state — expected Chess960 starting position for current game
let expectedPosition = {
    positionNumber: null,   // Chess960 position number (0-959)
    expectedFen: null,      // Expected piece placement FEN (just the position part)
    pieces: null,           // Back rank pieces array e.g. ['R','N','B','Q','K','B','N','R']
    gameStarted: false,     // True once moves have been made (stop checking)
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
                            !currentState.board;
        
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
 * Simple Chess960-aware move replayer.
 * Tracks pieces on an 8x8 grid and applies SAN moves without legality checking.
 * This avoids chess.js's inability to handle Chess960 castling FEN.
 */
function replayMoves(chess960Num, rawMoves) {
    const posNum = chess960Num != null ? chess960Num : 518;
    const pieces = chess960.positionFromNumber(posNum);
    
    // board[rank][file] — rank 0 = rank 8 (top), rank 7 = rank 1 (bottom)
    // Each cell: { piece: 'K'|'Q'|'R'|'B'|'N'|'P', color: 'w'|'b' } or null
    const board = Array.from({ length: 8 }, () => Array(8).fill(null));
    
    // Set up Chess960 starting position
    for (let f = 0; f < 8; f++) {
        board[0][f] = { piece: pieces[f], color: 'b' };  // black back rank
        board[1][f] = { piece: 'P', color: 'b' };        // black pawns
        board[6][f] = { piece: 'P', color: 'w' };        // white pawns
        board[7][f] = { piece: pieces[f], color: 'w' };  // white back rank
    }
    
    // Track king and rook positions for castling
    const kingFiles = { w: pieces.indexOf('K'), b: pieces.indexOf('K') };
    const rookFilesOrig = { w: [], b: [] };
    pieces.forEach((p, i) => { if (p === 'R') { rookFilesOrig.w.push(i); rookFilesOrig.b.push(i); } });
    
    let turn = 'w'; // w or b
    let lastMove = null;
    const FILES = 'abcdefgh';
    
    function fileIdx(ch) { return FILES.indexOf(ch); }
    function rankIdx(ch) { return 8 - parseInt(ch); } // '8'->0, '1'->7
    
    function findPiece(pieceType, color, toFile, toRank, disambigFile, disambigRank) {
        // Find a piece of the given type and color that could move to (toRank, toFile)
        // disambigFile/disambigRank narrow down which piece if multiple candidates
        const candidates = [];
        for (let r = 0; r < 8; r++) {
            for (let f = 0; f < 8; f++) {
                const sq = board[r][f];
                if (sq && sq.piece === pieceType && sq.color === color) {
                    if (disambigFile !== null && f !== disambigFile) continue;
                    if (disambigRank !== null && r !== disambigRank) continue;
                    candidates.push({ r, f });
                }
            }
        }
        if (candidates.length === 1) return candidates[0];
        
        // Simple heuristic: pick the one that can reach the target
        // For knights: L-shape; for bishops: diagonal; for rooks: straight; for queen: both
        for (const c of candidates) {
            if (canReach(pieceType, c.r, c.f, toRank, toFile)) return c;
        }
        return candidates[0] || null;
    }
    
    function canReach(pieceType, fromR, fromF, toR, toF) {
        const dr = toR - fromR, df = toF - fromF;
        switch (pieceType) {
            case 'N': return (Math.abs(dr) === 2 && Math.abs(df) === 1) || (Math.abs(dr) === 1 && Math.abs(df) === 2);
            case 'B': return Math.abs(dr) === Math.abs(df) && dr !== 0;
            case 'R': return (dr === 0 || df === 0) && (dr !== 0 || df !== 0);
            case 'Q': return (Math.abs(dr) === Math.abs(df) || dr === 0 || df === 0) && (dr !== 0 || df !== 0);
            case 'K': return Math.abs(dr) <= 1 && Math.abs(df) <= 1;
            default: return true;
        }
    }
    
    for (const raw of rawMoves) {
        const san = raw.split(' ')[0];
        if (!san) continue;
        
        try {
            // Castling
            if (san === 'O-O' || san === 'O-O-O') {
                const rank = turn === 'w' ? 7 : 0;
                // Find king on this rank
                let kf = null;
                for (let f = 0; f < 8; f++) {
                    if (board[rank][f] && board[rank][f].piece === 'K' && board[rank][f].color === turn) { kf = f; break; }
                }
                if (kf === null) { turn = turn === 'w' ? 'b' : 'w'; continue; }
                
                if (san === 'O-O') {
                    // Kingside: find rook to the right of king
                    let rf = null;
                    for (let f = 7; f > kf; f--) {
                        if (board[rank][f] && board[rank][f].piece === 'R' && board[rank][f].color === turn) { rf = f; break; }
                    }
                    if (rf !== null) {
                        board[rank][kf] = null;
                        board[rank][rf] = null;
                        board[rank][6] = { piece: 'K', color: turn }; // g-file
                        board[rank][5] = { piece: 'R', color: turn }; // f-file
                        lastMove = { from: FILES[kf] + (8-rank), to: FILES[6] + (8-rank) };
                    }
                } else {
                    // Queenside: find rook to the left of king
                    let rf = null;
                    for (let f = 0; f < kf; f++) {
                        if (board[rank][f] && board[rank][f].piece === 'R' && board[rank][f].color === turn) { rf = f; break; }
                    }
                    if (rf !== null) {
                        board[rank][kf] = null;
                        board[rank][rf] = null;
                        board[rank][2] = { piece: 'K', color: turn }; // c-file
                        board[rank][3] = { piece: 'R', color: turn }; // d-file
                        lastMove = { from: FILES[kf] + (8-rank), to: FILES[2] + (8-rank) };
                    }
                }
                turn = turn === 'w' ? 'b' : 'w';
                continue;
            }
            
            // Strip check/mate/annotations
            let m = san.replace(/[+#!?]+$/, '');
            
            // Promotion
            let promotion = null;
            if (m.includes('=')) {
                promotion = m.split('=')[1][0];
                m = m.split('=')[0];
            }
            
            const isCapture = m.includes('x');
            m = m.replace('x', '');
            
            // Parse destination square (last 2 chars)
            const destSquare = m.slice(-2);
            const toF = fileIdx(destSquare[0]);
            const toR = rankIdx(destSquare[1]);
            
            const rest = m.slice(0, -2);
            
            if (rest === '' || (rest.length === 1 && rest[0] >= 'a' && rest[0] <= 'h')) {
                // Pawn move
                const fromFileHint = rest.length === 1 ? fileIdx(rest[0]) : null;
                
                if (fromFileHint !== null || isCapture) {
                    // Pawn capture
                    const ff = fromFileHint !== null ? fromFileHint : toF;
                    const dir = turn === 'w' ? 1 : -1;
                    const fromR = toR + dir;
                    // En passant: if target square is empty and it's a diagonal pawn move
                    if (!board[toR][toF] && ff !== toF) {
                        board[fromR][toF] = null; // remove en passant captured pawn
                    }
                    board[toR][toF] = { piece: promotion || 'P', color: turn };
                    board[fromR][ff] = null;
                    lastMove = { from: FILES[ff] + (8-fromR), to: destSquare };
                } else {
                    // Pawn push
                    const dir = turn === 'w' ? 1 : -1;
                    if (board[toR + dir] && board[toR + dir][toF] && board[toR + dir][toF].piece === 'P' && board[toR + dir][toF].color === turn) {
                        board[toR][toF] = { piece: promotion || 'P', color: turn };
                        const fromR = toR + dir;
                        board[fromR][toF] = null;
                        lastMove = { from: FILES[toF] + (8-fromR), to: destSquare };
                    } else if (board[toR + 2*dir] && board[toR + 2*dir][toF] && board[toR + 2*dir][toF].piece === 'P' && board[toR + 2*dir][toF].color === turn) {
                        board[toR][toF] = { piece: promotion || 'P', color: turn };
                        const fromR = toR + 2*dir;
                        board[fromR][toF] = null;
                        lastMove = { from: FILES[toF] + (8-fromR), to: destSquare };
                    }
                }
            } else {
                // Piece move: first char is piece type, optional disambiguation
                const pieceType = rest[0];
                let disambigFile = null, disambigRank = null;
                const disambig = rest.slice(1);
                if (disambig.length === 1) {
                    if (disambig[0] >= 'a' && disambig[0] <= 'h') disambigFile = fileIdx(disambig[0]);
                    else disambigRank = rankIdx(disambig[0]);
                } else if (disambig.length === 2) {
                    disambigFile = fileIdx(disambig[0]);
                    disambigRank = rankIdx(disambig[1]);
                }
                
                const from = findPiece(pieceType, turn, toF, toR, disambigFile, disambigRank);
                if (from) {
                    board[toR][toF] = { piece: pieceType, color: turn };
                    board[from.r][from.f] = null;
                    lastMove = { from: FILES[from.f] + (8-from.r), to: destSquare };
                }
            }
        } catch (e) {
            console.warn(`♟️  DGT: Failed to replay move "${san}":`, e.message);
            // Continue anyway — show what we have
        }
        
        turn = turn === 'w' ? 'b' : 'w';
    }
    
    // Convert board to output format
    const outputBoard = board.map((row, ri) => {
        return row.map((sq, fi) => ({
            piece: sq ? sq.piece : null,
            color: sq ? sq.color : null,
            square: FILES[fi] + (8 - ri),
        }));
    });
    
    return { fen: null, board: outputBoard, lastMove };
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

// ============================================================
// Position Verification — compare DGT board to expected Chess960 starting position
// ============================================================

/**
 * Set the expected Chess960 position for the current game.
 * Called by gameEngine when a new game starts.
 */
function setExpectedPosition(posNumber) {
    expectedPosition = {
        positionNumber: posNumber,
        expectedFen: chess960.positionToStartingFen(posNumber),
        pieces: chess960.positionFromNumber(posNumber),
        gameStarted: false,
    };
    console.log(`♟️  DGT: Expected position set to #${posNumber} (${expectedPosition.pieces.join('')})`);
    // Re-broadcast so clients get the updated verification status
    broadcast();
}

/**
 * Clear expected position (no game active, or game ended).
 * Also clears the cached board state so the old game's final position
 * doesn't flash on screen when the page reloads for the next game.
 */
function clearExpectedPosition() {
    expectedPosition = {
        positionNumber: null,
        expectedFen: null,
        pieces: null,
        gameStarted: false,
    };
    // Clear cached board so stale position from previous game doesn't re-display
    currentState.board = null;
    currentState.fen = null;
    currentState.lastMove = null;
    currentState.moves = [];
    currentState.moveCount = 0;
    currentState.result = null;
    currentState.chess960Position = null;
    broadcast();
}

/**
 * Mark game as started (moves have been made — stop checking starting position).
 */
function markGameStarted() {
    expectedPosition.gameStarted = true;
}

/**
 * Check if the current DGT board matches the expected starting position.
 * Returns { matches, expected, actual, positionNumber, pieces, details }
 * Returns null if no expected position is set or game already started.
 */
function checkPositionMatch() {
    if (!expectedPosition.expectedFen || expectedPosition.gameStarted) {
        return null; // No verification needed
    }

    if (!currentState.connected || !currentState.board) {
        return {
            matches: null,  // Can't determine — no board data
            positionNumber: expectedPosition.positionNumber,
            pieces: expectedPosition.pieces,
            expected: expectedPosition.expectedFen,
            actual: null,
            details: 'DGT board not connected',
        };
    }

    // Convert current board state to a FEN placement string for comparison
    const actualFen = boardToFenPlacement(currentState.board);
    const matches = actualFen === expectedPosition.expectedFen;

    return {
        matches,
        positionNumber: expectedPosition.positionNumber,
        pieces: expectedPosition.pieces,
        expected: expectedPosition.expectedFen,
        actual: actualFen,
        details: matches ? 'Board matches expected position' : 'Board does not match expected position',
    };
}

/**
 * Convert an 8x8 board array back to FEN placement string.
 * Board format: array of 8 rows (rank 8 to rank 1), each row is array of 8 squares.
 * Each square: { piece: 'K'|null, color: 'w'|'b'|null }
 */
function boardToFenPlacement(board) {
    const rows = [];
    for (const row of board) {
        let fenRow = '';
        let emptyCount = 0;
        for (const sq of row) {
            if (!sq.piece) {
                emptyCount++;
            } else {
                if (emptyCount > 0) {
                    fenRow += emptyCount;
                    emptyCount = 0;
                }
                const ch = sq.color === 'w' ? sq.piece.toUpperCase() : sq.piece.toLowerCase();
                fenRow += ch;
            }
        }
        if (emptyCount > 0) fenRow += emptyCount;
        rows.push(fenRow);
    }
    return rows.join('/');
}

/**
 * Broadcast current state to all connected clients
 */
function broadcast() {
    if (io) {
        const posMatch = checkPositionMatch();
        io.emit('dgt_board', {
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
            positionVerification: posMatch,
        });
    }
}

/**
 * Get current state (for initial page load / API)
 */
function getState() {
    return {
        ...currentState,
        positionVerification: checkPositionMatch(),
    };
}

/**
 * Accept a raw board state push from a relay script (direct board reading).
 * This bypasses the move-replay path entirely — just "here's what's on the board."
 * 
 * @param {Object} data - Board state from relay
 * @param {string} data.fen - FEN string (position part only is fine, or full FEN)
 * @param {Array}  data.board - Optional 8x8 array already formatted
 * @param {Object} data.clock - Optional { white, black } in seconds
 * @param {Object} data.players - Optional { white: { name }, black: { name } }
 * @param {string} data.source - 'livechess' | 'serial' | 'fen' | 'manual'
 */
function setBoardState(data) {
    let board = data.board || null;
    
    // If FEN provided but no board array, convert it
    if (!board && data.fen) {
        board = fenToBoard(data.fen);
    }
    
    if (!board) {
        return { error: 'No board or fen provided' };
    }
    
    // Check if board actually changed (avoid unnecessary broadcasts)
    const boardChanged = !currentState.board || 
        JSON.stringify(board) !== JSON.stringify(currentState.board);
    const clockChanged = data.clock && (!currentState.clock ||
        data.clock.white !== currentState.clock.white ||
        data.clock.black !== currentState.clock.black);
    
    if (boardChanged || clockChanged) {
        currentState = {
            connected: true,
            fen: data.fen || null,
            board,
            clock: data.clock || currentState.clock,
            moves: [],
            moveCount: 0,
            chess960Position: data.chess960Position || null,
            lastMove: null, // no move tracking in direct mode
            players: data.players || currentState.players || null,
            result: data.result || null,
            tournamentId: currentState.tournamentId,
            error: null,
            source: data.source || 'relay',
        };
        broadcast();
    }
    
    return { success: true, changed: boardChanged || clockChanged };
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
    setBoardState,
    getState,
    formatClock,
    stopPolling,
    setExpectedPosition,
    clearExpectedPosition,
    markGameStarted,
    checkPositionMatch,
};
