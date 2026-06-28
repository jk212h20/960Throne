const express = require('express');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const engine = require('../domain/eventEngine');
const dgt = require('../domain/dgtState');
const db = require('../db');
const lightningAuth = require('../domain/lightningAuth');
const lightningNode = require('../domain/lightningNode');
const { config, redactedStatus } = require('../config/env');
const { makeAdminToken, requireAdmin, requirePlayer, requireRelay } = require('./middleware');

const router = express.Router();
function friendlyLightningFailure(err) { const msg = err && err.message ? err.message : String(err || 'payment failed'); if (/no route|unable to find.*route|route.*not found/i.test(msg)) return 'No Lightning route found. Your balance has been restored; try again later, use a different wallet, or ask admin for Bitcoin cashout.'; return `Payment failed: ${msg}`; }
router.get('/healthz', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
router.get('/version', (req, res) => res.json({ name: '960Throne v2', version: require('../../package.json').version, node: process.version }));
router.get('/state', (req, res) => res.json(engine.getState()));
router.get('/join-qr', async (req, res) => { const url = `${config.baseUrl}/join`; res.json({ url, qr: await QRCode.toDataURL(url, { width: 320 }) }); });
router.get('/join-qr-img', async (req, res) => {
  const url = String(req.query.u || `${config.baseUrl}/join`);
  const png = await QRCode.toBuffer(url, { width: 320, margin: 1, color: { dark: '#05030a', light: '#ffffff' } });
  res.type('png').send(png);
});
router.post('/venue-code/verify', (req, res) => {
  if (!db.validateVenueCode(req.body.code)) return res.status(400).json({ error: 'That code is not active' });
  res.json({ success: true });
});

router.get('/auth/lightning', async (req, res) => {
  try {
    const baseUrl = req.headers['x-forwarded-host'] ? `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers['x-forwarded-host']}` : config.baseUrl;
    const challenge = lightningAuth.createChallenge(baseUrl);
    const qr = await QRCode.toDataURL(challenge.lnurl, { width: 400, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
    res.json({ k1: challenge.k1, lnurl: challenge.lnurl, qr, deepLink: challenge.deepLink });
  } catch (err) {
    console.error('v2 LNURL-auth challenge error:', err);
    res.status(500).json({ error: 'Failed to generate Lightning login challenge' });
  }
});
router.get('/auth/lightning/callback', (req, res) => {
  const { k1, sig, key } = req.query;
  if (!k1 || !sig || !key) return res.json({ status: 'ERROR', reason: 'Missing required parameters' });
  const verified = lightningAuth.verify(k1, { sig, key });
  if (!verified.success) return res.json({ status: 'ERROR', reason: verified.error });
  let player = db.getPlayerByAuth('lightning', verified.authId);
  if (!player) {
    const id = db.createPlayer({ name: '', authType: 'lightning', authId: verified.authId });
    player = db.getPlayer(id);
  }
  const token = uuidv4();
  db.setPlayerToken(player.id, token);
  lightningAuth.complete(k1, { sessionToken: token, playerId: player.id });
  res.json({ status: 'OK' });
});
router.get('/auth/status', (req, res) => {
  const k1 = req.query.k1;
  if (!k1) return res.status(400).json({ error: 'k1 required' });
  const st = lightningAuth.status(k1);
  if (st.status === 'complete' && st.sessionToken) {
    res.cookie('v2_player', st.sessionToken, { httpOnly: true, sameSite: 'lax', secure: config.isProduction, maxAge: 30 * 24 * 60 * 60 * 1000, path: '/' });
    const player = db.getPlayerByToken(st.sessionToken);
    lightningAuth.consume(k1);
    return res.json({ status: 'complete', needsName: !player || !String(player.name || '').trim(), player });
  }
  res.json({ status: st.status });
});
router.post('/auth/set-name', requirePlayer, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name || name.length > 40) return res.status(400).json({ error: 'Name required, max 40 chars' });
  db.setPlayerName(req.player.id, name);
  res.json({ success: true, player: db.getPlayer(req.player.id) });
});
router.post('/auth/logout', requirePlayer, (req, res) => {
  db.setPlayerToken(req.player.id, null);
  res.clearCookie('v2_player', { path: '/', sameSite: 'lax', secure: config.isProduction });
  res.json({ success: true, message: 'Logged out' });
});

router.post('/admin/login', (req, res) => {
  if (!config.adminPassword) return res.status(503).json({ error: 'ADMIN_PASSWORD not configured' });
  if (req.body.password !== config.adminPassword) return res.status(401).json({ error: 'Invalid password' });
  const token = makeAdminToken(); res.cookie('v2_admin', token, { httpOnly: true, sameSite: 'lax', secure: config.isProduction, maxAge: 12 * 60 * 60 * 1000, path: '/' }); res.json({ success: true });
});
router.post('/admin/logout', requireAdmin, (req, res) => { res.clearCookie('v2_admin'); res.json({ success: true }); });
function readinessChecks() {
  const c = redactedStatus();
  const checks = [
    { name: 'BASE_URL set', ok: Boolean(c.baseUrl), detail: c.baseUrl },
    { name: 'BASE_URL not localhost', ok: !/localhost|127\.0\.0\.1/.test(c.baseUrl), detail: c.baseUrl },
    { name: 'BASE_URL HTTPS', ok: /^https:\/\//.test(c.baseUrl), detail: c.baseUrl },
    { name: 'Database path set', ok: Boolean(c.databasePath), detail: c.databasePath },
    { name: 'Admin password set', ok: c.adminPasswordSet },
    { name: 'Session secret set', ok: Boolean(config.sessionSecret) },
    { name: 'DGT relay secret set', ok: c.dgtRelaySecretSet },
    { name: 'Board password set', ok: c.boardPasswordSet },
    { name: 'Lightning/LND configured', ok: c.lightningConfigured, detail: c.lightningConfigured ? 'configured' : 'not configured/manual payouts only' },
  ];
  return { ok: checks.every(x => x.ok || x.name === 'Lightning/LND configured'), checks, config: c };
}
router.get('/admin/status', requireAdmin, (req, res) => res.json({ config: redactedStatus(), readiness: readinessChecks(), state: engine.getState(), log: db.eventLog(50) }));
router.get('/admin/readiness', requireAdmin, (req, res) => res.json(readinessChecks()));
router.get('/admin/lightning/balance', requireAdmin, async (req, res) => {
  try { res.json(await lightningNode.getBalances()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/admin/lightning/topup-invoice', requireAdmin, async (req, res) => {
  try {
    const amount = parseInt(req.body.amountSats, 10);
    const invoice = await lightningNode.createTopupInvoice(amount, req.body.memo || '960 Throne node top-up', parseInt(req.body.expiry || '3600', 10));
    const qr = await QRCode.toDataURL(invoice.paymentRequest, { width: 420, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
    res.json({ success: true, invoice, qr });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/admin/config', requireAdmin, (req, res) => {
  const satRate = parseInt(req.body.satRate, 10);
  const base = parseInt(req.body.timeControlBase, 10);
  const increment = parseInt(req.body.timeControlIncrement, 10);
  if (!Number.isInteger(satRate) || satRate < 0 || satRate > 100000) return res.status(400).json({ error: 'Sat rate must be 0-100000 sats/sec' });
  if (!Number.isInteger(base) || base < 1 || base > 86400) return res.status(400).json({ error: 'Base time must be 1-86400 seconds' });
  if (!Number.isInteger(increment) || increment < 0 || increment > 3600) return res.status(400).json({ error: 'Increment must be 0-3600 seconds' });
  db.setConfig('sat_rate_per_second', satRate);
  db.setConfig('time_control_base', base);
  db.setConfig('time_control_increment', increment);
  res.json({ success: true, config: engine.getState().config });
});
router.post('/admin/crown', requireAdmin, (req, res) => res.json(engine.crownKing(parseInt(req.body.playerId, 10))));
router.post('/admin/pairing/set', requireAdmin, async (req, res) => { const r = await engine.adminSetPairing({ kingId: req.body.kingId, challengerId: req.body.challengerId, position: req.body.position === '' ? null : req.body.position }); if (r.error) return res.status(400).json(r); res.json(r); });
router.post('/admin/game/start', requireAdmin, (req, res) => { const r = engine.startTableGame(); if (r.error) return res.status(400).json(r); res.json(r); });
router.post('/admin/result', requireAdmin, (req, res) => { const r = engine.finalizeGame(parseInt(req.body.gameId, 10), req.body.result); if (r.error) return res.status(400).json(r); res.json(r); });
router.post('/admin/start-next', requireAdmin, async (req, res) => res.json(await engine.callNextChallenger(req.body.position ?? null)));
router.post('/admin/player/name', requireAdmin, (req, res) => { const playerId = parseInt(req.body.playerId, 10); const name = String(req.body.name || '').trim(); if (!name) return res.status(400).json({ error: 'Name required' }); if (name.length > 40) return res.status(400).json({ error: 'Name too long' }); const p = db.getPlayer(playerId); if (!p) return res.status(404).json({ error: 'Player not found' }); db.setPlayerName(playerId, name); res.json({ success: true, player: db.getPlayer(playerId) }); });
router.post('/admin/player/merge', requireAdmin, (req, res) => { const r = db.mergePlayers(req.body.primaryId, req.body.duplicateId, req.body.reason || 'admin merge'); if (r.error) return res.status(400).json(r); res.json(r); });
router.post('/admin/queue/add', requireAdmin, (req, res) => { const r = engine.adminAddToQueue(parseInt(req.body.playerId, 10)); if (r.error) return res.status(400).json(r); res.json(r); });
router.post('/admin/queue/remove', requireAdmin, (req, res) => res.json(engine.adminRemoveFromQueue(parseInt(req.body.playerId, 10))));
router.post('/admin/reorder', requireAdmin, (req, res) => res.json(engine.adminReorder((req.body.order || []).map(Number))));
router.post('/admin/queue/reorder', requireAdmin, (req, res) => { const r = engine.adminReorderQueue((req.body.order || []).map(Number)); if (r.error) return res.status(400).json(r); res.json(r); });
router.post('/admin/lock', requireAdmin, (req, res) => res.json(engine.lockEvent(Boolean(req.body.locked))));
router.post('/admin/pause', requireAdmin, (req, res) => res.json(engine.pauseEvent()));
router.post('/admin/resume', requireAdmin, (req, res) => res.json(engine.resumeEvent()));
router.post('/admin/rotate-code', requireAdmin, (req, res) => res.json({ success: true, code: engine.rotateVenueCode() }));
router.post('/admin/backup', requireAdmin, (req, res) => res.json({ success: true, path: db.backup('manual') }));
router.post('/admin/reset', requireAdmin, (req, res) => res.json(engine.resetEvent()));
router.post('/admin/payout/reserve', requireAdmin, (req, res) => { const p = db.getPlayer(parseInt(req.body.playerId, 10)); if (!p) return res.status(404).json({ error: 'Player not found' }); const amount = parseInt(req.body.amount || p.sat_balance, 10); const r = db.reservePayout(p.id, amount, req.body.method || 'manual-admin-payout'); if (r.error) return res.status(400).json(r); res.json({ success: true, amount, payoutId: r.payoutId }); });
router.post('/admin/payout/complete', requireAdmin, (req, res) => { const r = db.payoutComplete(parseInt(req.body.payoutId, 10), req.body.paymentHash || 'manual'); if (r.error) return res.status(400).json(r); res.json(r); });
router.post('/admin/payout/fail', requireAdmin, (req, res) => { const r = db.payoutFail(parseInt(req.body.payoutId, 10), req.body.error || 'manual failure/refund'); if (r.error) return res.status(400).json(r); res.json(r); });
router.post('/admin/manual-payout-complete', requireAdmin, (req, res) => { const p = db.getPlayer(parseInt(req.body.playerId, 10)); if (!p) return res.status(404).json({ error: 'Player not found' }); const amount = parseInt(req.body.amount || p.sat_balance, 10); const r = db.reservePayout(p.id, amount, 'manual-admin-payout'); if (r.error) return res.status(400).json(r); const c = db.payoutComplete(r.payoutId, 'manual'); if (c.error) return res.status(400).json(c); res.json({ success: true, amount, payoutId: r.payoutId }); });

router.post('/players/register', (req, res) => {
  if (config.isProduction) return res.status(404).json({ error: 'Use Lightning login' });
  const name = String(req.body.name || '').trim();
  if (!name || name.length > 40) return res.status(400).json({ error: 'Name required, max 40 chars' });
  const { player, token } = engine.registerPlayer(name);
  res.cookie('v2_player', token, { httpOnly: true, sameSite: 'lax', secure: config.isProduction, maxAge: 30 * 24 * 60 * 60 * 1000, path: '/' });
  res.json({ success: true, player, warning: 'Development-only non-Lightning registration; cannot join queue.' });
});
router.post('/queue/join', requirePlayer, (req, res) => { const r = engine.joinQueue(req.player.id); if (r.error) return res.status(400).json(r); res.json(r); });
router.post('/queue/leave', requirePlayer, (req, res) => res.json(engine.leaveQueue(req.player.id)));
router.post('/game/report', requirePlayer, (req, res) => { const r = engine.reportResult(req.player.id, req.body.result); if (r.error) return res.status(400).json(r); res.json(r); });

router.post('/claim/reserve', requirePlayer, (req, res) => { const amount = parseInt(req.body.amount || req.player.sat_balance, 10); const r = db.reservePayout(req.player.id, amount, 'lnurl-withdraw'); if (r.error) return res.status(400).json(r); res.json({ success: true, ...r }); });
router.post('/claim/lnurl-withdraw', requirePlayer, async (req, res) => {
  if (!lightningNode.configured()) return res.status(503).json({ error: 'Lightning payments not available. Ask an admin to pay manually.' });
  const amount = parseInt(req.player.sat_balance || 0, 10);
  if (!Number.isInteger(amount) || amount < 10) return res.status(400).json({ error: 'Minimum cashout is 10 sats' });
  const reserved = db.reservePayout(req.player.id, amount, 'lnurl-withdraw', 'scan-to-collect');
  if (reserved.error) return res.status(400).json(reserved);
  const k1 = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.setPayoutWithdraw(reserved.payoutId, k1, expiresAt);
  const base = config.baseUrl.replace(/\/$/, '');
  const rawUrl = `${base}/api/withdraw/${k1}`;
  const lnurl = lightningAuth.encodeLnurl(rawUrl);
  const collectLink = `lightning:${lnurl}`;
  res.json({ success: true, amount, payoutId: reserved.payoutId, k1, expiresAt, lnurl, collectLink, phoenixLink: `phoenix:${collectLink}`, qr: await QRCode.toDataURL(collectLink, { width: 320 }) });
});
router.post('/claim/bitcoin-onchain', requirePlayer, (req, res) => {
  const amount = parseInt(req.player.sat_balance || 0, 10);
  const address = String(req.body.address || '').trim();
  if (!Number.isInteger(amount) || amount < 10) return res.status(400).json({ error: 'Minimum cashout is 10 sats' });
  if (!/^(bc1|[13])[a-zA-HJ-NP-Z0-9]{20,100}$/.test(address)) return res.status(400).json({ error: 'Enter a valid Bitcoin address.' });
  const reserved = db.reservePayout(req.player.id, amount, 'bitcoin-onchain', address);
  if (reserved.error) return res.status(400).json(reserved);
  db.notify('bitcoin_cashout_requested', `${req.player.name} requested on-chain Bitcoin cashout of ${amount} sats`);
  db.log('bitcoin_cashout_requested', `Bitcoin cashout requested by ${req.player.name}`, { playerId: req.player.id, payoutId: reserved.payoutId, amount, address });
  res.json({ success: true, amount, payoutId: reserved.payoutId, message: 'Bitcoin cashout requested. An admin will send it and mark it complete.' });
});
router.get('/withdraw/callback', async (req, res) => {
  const payout = db.getPayoutByWithdrawK1(req.query.k1);
  if (!payout) return res.json({ status: 'ERROR', reason: 'Withdraw link not found or already used' });
  if (payout.status === 'completed' || payout.status === 'paying') return res.json({ status: 'OK' });
  if (!['reserved','requested'].includes(payout.status)) return res.json({ status: 'ERROR', reason: 'Withdraw link not found or already used' });
  if (payout.expires_at && Date.now() > new Date(payout.expires_at).getTime()) { db.payoutFail(payout.id, 'withdraw link expired'); return res.json({ status: 'ERROR', reason: 'Withdraw link expired' }); }
  const pr = String(req.query.pr || '');
  if (!pr) return res.json({ status: 'ERROR', reason: 'Missing invoice' });
  try {
    const decoded = await lightningNode.decodeInvoice(pr);
    const invoiceSats = Number(decoded.num_satoshis || decoded.num_satoshis_str || 0);
    if (invoiceSats !== payout.amount_sats) return res.json({ status: 'ERROR', reason: `Invoice amount must be exactly ${payout.amount_sats} sats` });
    db.payoutPaying(payout.id, pr);
    const paid = await lightningNode.payInvoice(pr);
    db.payoutComplete(payout.id, paid.payment_hash || 'lnd');
    res.json({ status: 'OK' });
  } catch (err) {
    db.payoutFail(payout.id, err.message);
    res.json({ status: 'ERROR', reason: friendlyLightningFailure(err) });
  }
});
router.get('/withdraw/:k1', (req, res) => {
  const payout = db.getPayoutByWithdrawK1(req.params.k1);
  if (!payout || !['reserved','paying','requested'].includes(payout.status)) return res.json({ status: 'ERROR', reason: 'Withdraw link not found or already used' });
  if (payout.expires_at && Date.now() > new Date(payout.expires_at).getTime()) { db.payoutFail(payout.id, 'withdraw link expired'); return res.json({ status: 'ERROR', reason: 'Withdraw link expired' }); }
  const base = config.baseUrl.replace(/\/$/, '');
  res.json({ tag: 'withdrawRequest', callback: `${base}/api/withdraw/callback`, k1: payout.withdraw_k1, defaultDescription: `960 Throne cashout: ${payout.amount_sats} sats`, minWithdrawable: payout.amount_sats * 1000, maxWithdrawable: payout.amount_sats * 1000 });
});
router.post('/claim/lightning-address', requirePlayer, async (req, res) => {
  const amount = parseInt(req.body.amount || req.player.sat_balance, 10);
  let lightningAddress;
  try { lightningAddress = lightningNode.normalizeLightningAddress(req.body.lightningAddress || ''); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  if (!Number.isInteger(amount) || amount < 10) return res.status(400).json({ error: 'Minimum claim is 10 sats' });
  if (!lightningNode.configured()) return res.status(503).json({ error: 'Lightning payments not available. Ask an admin to pay manually.' });
  const reserved = db.reservePayout(req.player.id, amount, 'lightning-address', lightningAddress);
  if (reserved.error) return res.status(400).json(reserved);
  try {
    const paid = await lightningNode.payLightningAddress(lightningAddress, amount, `960 Throne payout for ${req.player.name}`);
    db.payoutPaying(reserved.payoutId, paid.invoice);
    const completed = db.payoutComplete(reserved.payoutId, paid.paymentHash || 'lnd');
    if (completed.error) return res.status(500).json(completed);
    res.json({ success: true, amount, payoutId: reserved.payoutId, paymentHash: paid.paymentHash, message: `⚡ ${amount} sats sent to ${lightningAddress}` });
  } catch (err) {
    db.payoutFail(reserved.payoutId, err.message);
    res.status(500).json({ error: friendlyLightningFailure(err), payoutId: reserved.payoutId, hint: err.message.includes('Bolt12') ? 'Try a standard LNURL Lightning Address wallet.' : undefined });
  }
});
router.post('/claim/mock-complete', requireAdmin, (req, res) => res.json(db.payoutComplete(parseInt(req.body.payoutId, 10), 'mock')));
router.post('/claim/mock-fail', requireAdmin, (req, res) => res.json(db.payoutFail(parseInt(req.body.payoutId, 10), req.body.error || 'mock failure')));

router.post('/dgt/board-state', requireRelay, (req, res) => {
  try {
    const body = { ...req.body };
    delete body.relaySecret;
    const snapshot = dgt.update(body);
    const autoStart = engine.maybeAutoStartFromDgt(snapshot);
    res.json({ success: true, dgt: snapshot, autoStart });
  } catch (err) {
    res.status(500).json({ error: err.message || 'DGT update failed' });
  }
});
router.get('/dgt/state', (req, res) => res.json(dgt.snapshot()));

module.exports = router;
