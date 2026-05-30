const express = require('express');
const engine = require('../domain/eventEngine');
const db = require('../db');
const { requireAdmin, parseCookies } = require('./middleware');
const router = express.Router();
function render(name, extra = {}) { return (req, res) => { req.cookies = req.cookies || parseCookies(req); res.render(name, { state: engine.getState(), player: db.getPlayerByToken(req.cookies.v2_player), ...extra }); }; }
router.get('/', render('stage'));
router.get('/stage', render('stage'));
router.get('/watch', render('watch'));
router.get('/join', render('join'));
router.get('/admin', render('admin'));
router.get('/ops', requireAdmin, render('ops'));
module.exports = router;
