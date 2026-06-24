const crypto = require('crypto');
const db = require('../db');
const { config } = require('../config/env');

function sign(value) { return crypto.createHmac('sha256', config.sessionSecret || 'dev-session-secret').update(value).digest('hex'); }
function makeAdminToken() { const raw = crypto.randomBytes(32).toString('hex'); return `${raw}.${sign(raw)}`; }
function validAdminToken(token) { if (!token || !token.includes('.')) return false; const [raw, sig] = token.split('.'); const expected = sign(raw); if (sig.length !== expected.length) return false; return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); }
function parseCookies(req) { const out = {}; String(req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1)); }); return out; }
function requireAdmin(req, res, next) { req.cookies = req.cookies || parseCookies(req); if (validAdminToken(req.cookies.v2_admin || req.headers['x-admin-token'])) return next(); return res.status(401).json({ error: 'Admin required' }); }
function requirePlayer(req, res, next) { req.cookies = req.cookies || parseCookies(req); const token = req.cookies.v2_player || req.headers['x-player-token']; const player = db.getPlayerByToken(token); if (!player) return res.status(401).json({ error: 'Player required' }); req.player = player; next(); }
function requireRelay(req, res, next) { const provided = req.headers['x-relay-secret']; if (config.dgtRelaySecret && provided === config.dgtRelaySecret) return next(); return res.status(401).json({ error: 'Invalid relay secret' }); }
module.exports = { makeAdminToken, validAdminToken, requireAdmin, requirePlayer, requireRelay, parseCookies };
