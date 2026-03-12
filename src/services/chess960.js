/**
 * Chess960 (Fischer Random) position generator
 * Uses Scharnagl numbering (0-959)
 */

const PIECES = {
    K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙',
    k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟'
};

/**
 * Generate a Chess960 starting position from a Scharnagl number (0-959)
 * Returns an array of 8 piece characters for the back rank
 */
function positionFromNumber(n) {
    const pieces = new Array(8).fill(null);

    // Step 1: Place light-squared bishop
    const n2 = Math.floor(n / 4);
    const b1 = (n % 4) * 2 + 1; // positions 1,3,5,7
    pieces[b1] = 'B';

    // Step 2: Place dark-squared bishop
    const n3 = Math.floor(n2 / 4);
    const b2 = (n2 % 4) * 2; // positions 0,2,4,6
    pieces[b2] = 'B';

    // Step 3: Place queen
    const n4 = Math.floor(n3 / 6);
    const q = n3 % 6;
    let emptyCount = 0;
    for (let i = 0; i < 8; i++) {
        if (pieces[i] === null) {
            if (emptyCount === q) {
                pieces[i] = 'Q';
                break;
            }
            emptyCount++;
        }
    }

    // Step 4: Place knights using the KRN table
    const knightPlacements = [
        [0, 1], [0, 2], [0, 3], [0, 4],
        [1, 2], [1, 3], [1, 4],
        [2, 3], [2, 4],
        [3, 4]
    ];
    const kn = knightPlacements[n4];
    emptyCount = 0;
    let knightPlaced = 0;
    for (let i = 0; i < 8 && knightPlaced < 2; i++) {
        if (pieces[i] === null) {
            if (emptyCount === kn[0] && knightPlaced === 0) {
                pieces[i] = 'N';
                knightPlaced++;
            } else if (emptyCount === kn[1] && knightPlaced === 1) {
                pieces[i] = 'N';
                knightPlaced++;
            }
            emptyCount++;
        }
    }

    // Step 5: Place R-K-R in remaining empty squares
    const remaining = [];
    for (let i = 0; i < 8; i++) {
        if (pieces[i] === null) remaining.push(i);
    }
    pieces[remaining[0]] = 'R';
    pieces[remaining[1]] = 'K';
    pieces[remaining[2]] = 'R';

    return pieces;
}

/**
 * Generate a random Chess960 position number (0-959)
 */
function randomPositionNumber() {
    return Math.floor(Math.random() * 960);
}

/**
 * Get the standard starting position number (518 = standard chess)
 */
function standardPosition() {
    return 518;
}

/**
 * Convert a position to a display-friendly format
 */
function positionToDisplay(posNumber) {
    const pieces = positionFromNumber(posNumber);
    return {
        number: posNumber,
        pieces: pieces,
        display: pieces.join(''),
        unicode: pieces.map(p => PIECES[p] || p).join(' '),
        fen: buildFEN(pieces),
    };
}

/**
 * Build a FEN string from a Chess960 back rank
 */
function buildFEN(backRank) {
    const whiteRank = backRank.join('').toLowerCase();
    const blackRank = backRank.join('').toLowerCase();
    // Standard FEN: black back rank / black pawns / empty rows / white pawns / white back rank
    return `${blackRank}/pppppppp/8/8/8/8/PPPPPPPP/${backRank.join('')} w KQkq - 0 1`;
}

/**
 * Get piece symbol for display (Unicode chess pieces)
 */
function pieceToUnicode(piece, isWhite = true) {
    const map = isWhite ? PIECES : { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞', P: '♟' };
    return map[piece] || piece;
}

/**
 * Convert any string (e.g. a Bitcoin block hash) to a Chess960 position number (0-959)
 * Uses character codes: num = (num * 256 + charCode) % 960
 */
function stringToPositionNumber(str) {
    let num = 0;
    for (let i = 0; i < str.length; i++) {
        num = (num * 256 + str.charCodeAt(i)) % 960;
    }
    return num;
}

/**
 * Fetch the latest Bitcoin block from mempool.space and derive a Chess960 position
 * Returns { blockHeight, blockHash, positionNumber, backRank, pieces }
 */
let _btcCache = { data: null, fetchedAt: 0 };
const BTC_CACHE_TTL = 30000; // 30 seconds

async function fetchBitcoinPosition() {
    // Return cached if fresh
    if (_btcCache.data && (Date.now() - _btcCache.fetchedAt) < BTC_CACHE_TTL) {
        return _btcCache.data;
    }

    const hashRes = await fetch('https://mempool.space/api/blocks/tip/hash');
    if (!hashRes.ok) throw new Error('Failed to fetch block hash from mempool.space');
    const blockHash = await hashRes.text();

    const blockRes = await fetch(`https://mempool.space/api/block/${blockHash}`);
    if (!blockRes.ok) throw new Error('Failed to fetch block details from mempool.space');
    const blockData = await blockRes.json();

    const positionNumber = stringToPositionNumber(blockHash);
    const pieces = positionFromNumber(positionNumber);

    const result = {
        blockHeight: blockData.height,
        blockHash,
        positionNumber,
        pieces,
        backRank: pieces.join(''),
    };

    _btcCache = { data: result, fetchedAt: Date.now() };
    return result;
}

module.exports = {
    positionFromNumber,
    randomPositionNumber,
    standardPosition,
    positionToDisplay,
    buildFEN,
    pieceToUnicode,
    stringToPositionNumber,
    fetchBitcoinPosition,
    PIECES,
};
