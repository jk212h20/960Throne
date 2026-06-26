const express = require('express');
const engine = require('../domain/eventEngine');
const db = require('../db');
const { requireAdmin, parseCookies, validAdminToken } = require('./middleware');
const { config } = require('../config/env');
const router = express.Router();
function publicBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return host ? `${proto}://${host}` : config.baseUrl;
}
function render(name, extra = {}) { return (req, res) => { req.cookies = req.cookies || parseCookies(req); const baseUrl = publicBaseUrl(req); res.render(name, { state: engine.getState(), player: db.getPlayerByToken(req.cookies.v2_player), baseUrl, joinUrl: `${baseUrl}/join`, ...extra }); }; }
function renderPublicStage(req, res) { const baseUrl = publicBaseUrl(req); res.render('stage', { state: engine.publicState(), player: null, baseUrl, joinUrl: `${baseUrl}/join` }); }
router.get('/', renderPublicStage);
router.get('/stage', renderPublicStage);
router.get('/watch', render('watch'));
router.get('/leaderboard', render('leaderboard'));
router.get('/join', render('join'));
router.get('/admin', (req, res) => {
  req.cookies = req.cookies || parseCookies(req);
  const isAdmin = validAdminToken(req.cookies.v2_admin || '');
  if (!isAdmin) return res.render('admin', { state: null, player: null, baseUrl: publicBaseUrl(req), joinUrl: `${publicBaseUrl(req)}/join`, isAdmin: false });
  return render('admin', { isAdmin: true })(req, res);
});
router.get('/ops', requireAdmin, render('ops'));
router.get('/report', (req, res) => {
  req.cookies = req.cookies || parseCookies(req);
  const isAdmin = validAdminToken(req.cookies.v2_admin || '');
  if (!isAdmin) return res.render('admin', { state: null, player: null, baseUrl: publicBaseUrl(req), joinUrl: `${publicBaseUrl(req)}/join`, isAdmin: false });
  return render('report', { isAdmin: true })(req, res);
});
module.exports = router;
