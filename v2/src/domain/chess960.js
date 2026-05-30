const PIECES = { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙' };

function positionFromNumber(n) {
  n = Math.max(0, Math.min(959, parseInt(n, 10) || 0));
  const pieces = new Array(8).fill(null);
  const n2 = Math.floor(n / 4); pieces[(n % 4) * 2 + 1] = 'B';
  const n3 = Math.floor(n2 / 4); pieces[(n2 % 4) * 2] = 'B';
  const n4 = Math.floor(n3 / 6); const q = n3 % 6;
  let empty = 0; for (let i = 0; i < 8; i++) if (!pieces[i]) { if (empty === q) { pieces[i] = 'Q'; break; } empty++; }
  const knightPlacements = [[0,1],[0,2],[0,3],[0,4],[1,2],[1,3],[1,4],[2,3],[2,4],[3,4]];
  const kn = knightPlacements[n4]; empty = 0; let kp = 0;
  for (let i = 0; i < 8 && kp < 2; i++) if (!pieces[i]) { if ((kp === 0 && empty === kn[0]) || (kp === 1 && empty === kn[1])) { pieces[i] = 'N'; kp++; } empty++; }
  const rem = pieces.map((p, i) => p ? null : i).filter(i => i !== null);
  pieces[rem[0]] = 'R'; pieces[rem[1]] = 'K'; pieces[rem[2]] = 'R';
  return pieces;
}
function randomPositionNumber() { return Math.floor(Math.random() * 960); }
function positionToStartingFen(pos) { const p = positionFromNumber(pos); return `${p.join('').toLowerCase()}/pppppppp/8/8/8/8/PPPPPPPP/${p.join('')}`; }
function positionToDisplay(pos) { const pieces = positionFromNumber(pos); return { number: pos, pieces, display: pieces.join(''), unicode: pieces.map(p => PIECES[p]).join(' '), fen: `${pieces.join('').toLowerCase()}/pppppppp/8/8/8/8/PPPPPPPP/${pieces.join('')} w KQkq - 0 1` }; }
function stringToPositionNumber(str) { let num = 0; for (const ch of String(str)) num = (num * 256 + ch.charCodeAt(0)) % 960; return num; }

let cache = { hash: null, height: null, at: 0 }; let lastHash = null; let gameInBlock = 0;
async function fetchBitcoinPosition() {
  let hash = cache.hash, height = cache.height;
  if (!hash || Date.now() - cache.at > 30000) {
    const hashRes = await fetch('https://mempool.space/api/blocks/tip/hash');
    if (!hashRes.ok) throw new Error('Could not fetch Bitcoin tip hash');
    hash = await hashRes.text();
    const blockRes = await fetch(`https://mempool.space/api/block/${hash}`);
    if (!blockRes.ok) throw new Error('Could not fetch Bitcoin tip block');
    height = (await blockRes.json()).height;
    cache = { hash, height, at: Date.now() };
  }
  if (hash !== lastHash) { lastHash = hash; gameInBlock = 0; }
  const basePosition = stringToPositionNumber(hash);
  const positionNumber = (basePosition + gameInBlock) % 960;
  gameInBlock++;
  return { blockHash: hash, blockHeight: height, basePosition, gameInBlock, positionNumber, pieces: positionFromNumber(positionNumber) };
}

module.exports = { positionFromNumber, randomPositionNumber, positionToStartingFen, positionToDisplay, stringToPositionNumber, fetchBitcoinPosition };
