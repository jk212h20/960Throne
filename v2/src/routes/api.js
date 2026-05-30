const express = require('express');
const QRCode = require('qrcode');
const engine = require('../domain/eventEngine');
const dgt = require('../domain/dgtState');
const db = require('../db');
const { config, redactedStatus } = require('../config/env');
const { makeAdminToken, requireAdmin, requirePlayer, requireRelay } = require('./middleware');

const router = express.Router();
router.get('/healthz', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
router.get('/version', (req, res) => res.json({ name: '960Throne v2', version: require('../../package.json').version, node: process.version }));
router.get('/state', (req, res) => res.json(engine.getState()));
router.get('/join-qr', async (req, res) => { const url = `${config.baseUrl}/join`; res.json({ url, qr: await QRCode.toDataURL(url, { width: 320 }) }); });
router.get('/join-qr-img', async (req, res) => {
  const url = String(req.query.u || `${config.baseUrl}/join`);
  const png = await QRCode.toBuffer(url, { width: 320, margin: 1, color: { dark: '#05030a', light: '#ffffff' } });
  res.type('png').send(png);
});

router.post('/admin/login', (req, res) => {
  if (!config.adminPassword) return res.status(503).json({ error: 'ADMIN_PASSWORD not configured' });
  if (req.body.password !== config.adminPassword) return res.status(401).json({ error: 'Invalid password' });
  const token = makeAdminToken(); res.cookie('v2_admin', token, { httpOnly: true, sameSite: 'lax', secure: config.isProduction, maxAge: 12 * 60 * 60 * 1000, path: '/' }); res.json({ success: true });
});
router.post('/admin/logout', requireAdmin, (req, res) => { res.clearCookie('v2_admin'); res.json({ success: true }); });
router.get('/admin/status', requireAdmin, (req, res) => res.json({ config: redactedStatus(), state: engine.getState(), log: db.eventLog(50) }));
router.post('/admin/crown', requireAdmin, (req, res) => res.json(engine.crownKing(parseInt(req.body.playerId, 10))));
router.post('/admin/result', requireAdmin, (req, res) => res.json(engine.finalizeGame(parseInt(req.body.gameId, 10), req.body.result)));
router.post('/admin/reorder', requireAdmin, (req, res) => res.json(engine.adminReorder((req.body.order || []).map(Number))));
router.post('/admin/lock', requireAdmin, (req, res) => res.json(engine.lockEvent(Boolean(req.body.locked))));
router.post('/admin/rotate-code', requireAdmin, (req, res) => res.json({ success: true, code: engine.rotateVenueCode() }));
router.post('/admin/backup', requireAdmin, (req, res) => res.json({ success: true, path: db.backup('manual') }));
router.post('/admin/reset', requireAdmin, (req, res) => res.json(engine.resetEvent()));
router.post('/admin/manual-payout-complete', requireAdmin, (req, res) => { const p = db.getPlayer(parseInt(req.body.playerId, 10)); if (!p) return res.status(404).json({ error: 'Player not found' }); const amount = parseInt(req.body.amount || p.sat_balance, 10); const r = db.reservePayout(p.id, amount, 'manual-admin-payout'); if (r.error) return res.status(400).json(r); db.payoutComplete(r.payoutId, 'manual'); res.json({ success: true, amount, payoutId: r.payoutId }); });

router.post('/players/register', (req, res) => { const name = String(req.body.name || '').trim(); if (!name || name.length > 40) return res.status(400).json({ error: 'Name required, max 40 chars' }); const { player, token } = engine.registerPlayer(name); res.cookie('v2_player', token, { httpOnly: true, sameSite: 'lax', secure: config.isProduction, maxAge: 30 * 24 * 60 * 60 * 1000, path: '/' }); res.json({ success: true, player }); });
router.post('/queue/join', requirePlayer, (req, res) => { const r = engine.joinQueue(req.player.id); if (r.error) return res.status(400).json(r); res.json(r); });
router.post('/queue/leave', requirePlayer, (req, res) => res.json(engine.leaveQueue(req.player.id)));
router.post('/game/report', requirePlayer, (req, res) => { const r = engine.reportResult(req.player.id, req.body.result); if (r.error) return res.status(400).json(r); res.json(r); });

router.post('/claim/reserve', requirePlayer, (req, res) => { const amount = parseInt(req.body.amount || req.player.sat_balance, 10); const r = db.reservePayout(req.player.id, amount, 'lnurl-withdraw'); if (r.error) return res.status(400).json(r); res.json({ success: true, ...r }); });
router.post('/claim/mock-complete', requireAdmin, (req, res) => res.json(db.payoutComplete(parseInt(req.body.payoutId, 10), 'mock')));
router.post('/claim/mock-fail', requireAdmin, (req, res) => res.json(db.payoutFail(parseInt(req.body.payoutId, 10), req.body.error || 'mock failure')));

router.post('/dgt/board-state', requireRelay, (req, res) => res.json({ success: true, dgt: dgt.update(req.body) }));
router.get('/dgt/state', (req, res) => res.json(dgt.snapshot()));

module.exports = router;
