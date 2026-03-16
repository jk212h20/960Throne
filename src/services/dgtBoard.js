/**
 * DGT Board Integration — Direct Board State Push
 * 
 * Accepts raw board state from relay scripts (dgt-relay/) running on the venue laptop.
 * The relay reads the DGT board via LiveChess WebSocket, USB serial, or manual FEN input,
 * then POSTs the board state (FEN + optional clock) to /api/dgt/board-state.
 * 
 * This module converts FEN to an 8x8 board array, handles position verification
 * (comparing DGT board to expected Chess960 starting position), and broadcasts
 * updates to all connected clients via Socket.io.
 */

const chess960 = require('./chess960');

let io = null;
let db = null;

// Current state — what we last broadcast
let currentState = {
    connected: false,
    fen: null,
    board: null,       // 8x8 array for template rendering
    clock: null,       // { white, black } in seconds
    lastMove: null,    // { from, to } for highlighting
    players: null,     // { white: { name }, black: { name } }
    result: null,
    error: null,
    source: null,      // 'relay-page' | 'livechess' | 'serial' | 'fen'
};

// Position verification state — expected Chess960 starting position for current game
let expectedPosition = {
    positionNumber: null,   // Chess960 position number (0-959)
    expectedFen: null,      // Expected piece placement FEN (just the position part)
    pieces: null,           // Back rank pieces array e.g. ['R','N','B','Q','K','B','N','R']
    gameStarted: false,     // True once moves have been made (stop checking)
};

/**
 * Initialize the DGT board service
 */
function init(socketIo, database) {
    io = socketIo;
    db = database;
    console.log('♟️  DGT Board service initialized (direct relay mode)');
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
    currentState.result = null;
    broadcast();
}

/**
 * Mark game as started (moves have been made — stop checking starting position).
 */
function markGameStarted() {
    expectedPosition.gameStarted = true;
}

/**
 * Build the expected 8×8 board array from the expected FEN.
 * Same format as fenToBoard() output — used by throne.ejs to render the target position.
 */
function getExpectedBoard() {
    if (!expectedPosition.expectedFen) return null;
    return fenToBoard(expectedPosition.expectedFen);
}

/**
 * Compare each square of the actual DGT board against the expected board.
 * Returns a flat array of 64 booleans (row-major, rank 8 to rank 1).
 * true = piece on this square matches expected, false = mismatch.
 * Returns null if no board data available.
 */
function getSquareMatches() {
    if (!expectedPosition.expectedFen || !currentState.board) return null;
    const expectedBoard = getExpectedBoard();
    if (!expectedBoard) return null;

    const matches = [];
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const actual = currentState.board[r][c];
            const expected = expectedBoard[r][c];
            // Compare piece and color (both null = match, both same piece+color = match)
            const pieceMatch = (actual.piece === expected.piece) && (actual.color === expected.color);
            matches.push(pieceMatch);
        }
    }
    return matches;
}

/**
 * Check if the current DGT board matches the expected starting position.
 * Returns { matches, expected, actual, positionNumber, pieces, details, expectedBoard, squareMatches }
 * Returns null if no expected position is set or game already started.
 */
function checkPositionMatch() {
    if (!expectedPosition.expectedFen || expectedPosition.gameStarted) {
        return null; // No verification needed
    }

    const expectedBoard = getExpectedBoard();

    if (!currentState.connected || !currentState.board) {
        return {
            matches: null,  // Can't determine — no board data
            positionNumber: expectedPosition.positionNumber,
            pieces: expectedPosition.pieces,
            expected: expectedPosition.expectedFen,
            actual: null,
            expectedBoard,
            squareMatches: null,
            details: 'DGT board not connected',
        };
    }

    // Convert current board state to a FEN placement string for comparison
    const actualFen = boardToFenPlacement(currentState.board);
    const matches = actualFen === expectedPosition.expectedFen;
    const squareMatches = getSquareMatches();

    return {
        matches,
        positionNumber: expectedPosition.positionNumber,
        pieces: expectedPosition.pieces,
        expected: expectedPosition.expectedFen,
        actual: actualFen,
        expectedBoard,
        squareMatches,
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
            lastMove: currentState.lastMove,
            players: currentState.players,
            result: currentState.result,
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
 * This is the primary path — relay reads the DGT board and POSTs here.
 * 
 * @param {Object} data - Board state from relay
 * @param {string} data.fen - FEN string (position part only is fine, or full FEN)
 * @param {Array}  data.board - Optional 8x8 array already formatted
 * @param {Object} data.clock - Optional { white, black } in seconds
 * @param {Object} data.players - Optional { white: { name }, black: { name } }
 * @param {string} data.source - 'relay-page' | 'livechess' | 'serial' | 'fen'
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
        data.clock.black !== currentState.clock.black ||
        data.clock.activeSide !== currentState.clock?.activeSide ||
        data.clock.running !== currentState.clock?.running);
    
    if (boardChanged || clockChanged) {
        currentState = {
            connected: true,
            fen: data.fen || null,
            board,
            clock: data.clock || currentState.clock,
            lastMove: null, // no move tracking in direct mode
            players: data.players || currentState.players || null,
            result: data.result || null,
            error: null,
            source: data.source || 'relay',
        };

        // Auto-detect clock start → transition from setup mode to live game
        // When the clock starts running during setup mode, it means White's clock was pressed
        if (!expectedPosition.gameStarted && expectedPosition.expectedFen && data.clock) {
            if (data.clock.running === true || data.clock.activeSide) {
                console.log('♟️  DGT: Clock started — transitioning from setup to live game');
                markGameStarted();
            }
        }

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
    setBoardState,
    getState,
    formatClock,
    setExpectedPosition,
    clearExpectedPosition,
    markGameStarted,
    checkPositionMatch,
};
