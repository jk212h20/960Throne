const express = require('express');
const engine = require('../domain/eventEngine');
const db = require('../db');
const { requireAdmin, parseCookies } = require('./middleware');
const { config } = require('../config/env');
const router = express.Router();
function publicBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return host ? `${proto}://${host}` : config.baseUrl;
}
function render(name, extra = {}) { return (req, res) => { req.cookies = req.cookies || parseCookies(req); const baseUrl = publicBaseUrl(req); res.render(name, { state: engine.getState(), player: db.getPlayerByToken(req.cookies.v2_player), baseUrl, joinUrl: `${baseUrl}/join`, ...extra }); }; }
router.get('/', render('stage'));
router.get('/stage', render('stage'));
router.get('/watch', render('watch'));
router.get('/join', render('join'));
router.get('/admin', render('admin'));
router.get('/ops', requireAdmin, render('ops'));
module.exports = router;
