const crypto = require('crypto');
const secp256k1 = require('secp256k1');
const { config } = require('../config/env');

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const challenges = new Map();
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
function bech32HrpExpand(hrp) {
  const ret = [];
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5);
  ret.push(0);
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
  return ret;
}
function bech32CreateChecksum(hrp, data) {
  const values = bech32HrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const polymod = bech32Polymod(values) ^ 1;
  const ret = [];
  for (let i = 0; i < 6; i++) ret.push((polymod >> (5 * (5 - i))) & 31);
  return ret;
}
function bech32Encode(hrp, data) {
  return hrp + '1' + data.concat(bech32CreateChecksum(hrp, data)).map(d => CHARSET[d]).join('');
}
function convertBits(data, fromBits, toBits, pad) {
  let acc = 0, bits = 0;
  const ret = [], maxv = (1 << toBits) - 1;
  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) { bits -= toBits; ret.push((acc >> bits) & maxv); }
  }
  if (pad && bits > 0) ret.push((acc << (toBits - bits)) & maxv);
  return ret;
}
function encodeLnurl(url) {
  const data = convertBits(Array.from(Buffer.from(url, 'utf8')), 8, 5, true);
  return bech32Encode('lnurl', data).toUpperCase();
}
function cleanupExpired() {
  const now = Date.now();
  for (const [k1, c] of challenges) if (now - c.createdAt > CHALLENGE_TTL_MS) challenges.delete(k1);
}
function createChallenge(baseUrl = config.baseUrl) {
  cleanupExpired();
  const k1 = crypto.randomBytes(32).toString('hex');
  const rawUrl = `${baseUrl.replace(/\/$/, '')}/api/auth/lightning/callback?tag=login&k1=${k1}&action=login`;
  const lnurl = encodeLnurl(rawUrl);
  challenges.set(k1, { status: 'pending', createdAt: Date.now(), authId: null, sessionToken: null, playerId: null });
  return { k1, rawUrl, lnurl, encodedUrl: lnurl, deepLink: `lightning:${lnurl}` };
}
function verify(k1, { sig, key }) {
  const c = challenges.get(k1);
  if (!c) return { success: false, error: 'Challenge expired or not found' };
  if (c.status !== 'pending') return { success: false, error: 'Challenge already completed' };
  if (!sig || !key) return { success: false, error: 'Missing sig or key parameter' };
  try {
    const k1Buffer = Buffer.from(k1, 'hex');
    const sigBuffer = Buffer.from(sig, 'hex');
    const keyBuffer = Buffer.from(key, 'hex');
    if (!secp256k1.publicKeyVerify(keyBuffer)) return { success: false, error: 'Invalid public key' };
    const sigCompact = secp256k1.signatureImport(sigBuffer);
    if (!secp256k1.ecdsaVerify(sigCompact, k1Buffer, keyBuffer)) return { success: false, error: 'Invalid signature' };
    c.status = 'verified';
    c.authId = key;
    return { success: true, authId: key };
  } catch (err) {
    c.status = 'failed';
    return { success: false, error: `Verification failed: ${err.message}` };
  }
}
function complete(k1, { sessionToken, playerId }) {
  const c = challenges.get(k1);
  if (c) { c.status = 'complete'; c.sessionToken = sessionToken; c.playerId = playerId; }
}
function status(k1) {
  cleanupExpired();
  const c = challenges.get(k1);
  if (!c) return { status: 'expired' };
  return { status: c.status, authId: c.authId, sessionToken: c.sessionToken, playerId: c.playerId };
}
function consume(k1) { challenges.delete(k1); }
function resetForTests() { challenges.clear(); }

module.exports = { createChallenge, verify, complete, status, consume, resetForTests, encodeLnurl };
