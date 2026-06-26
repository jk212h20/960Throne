const assert = require('assert');
const os = require('os');
const path = require('path');
process.env.DATABASE_PATH = path.join(os.tmpdir(), `throne-v2-test-${Date.now()}.db`);
process.env.SESSION_SECRET = 'test-secret';
process.env.ADMIN_PASSWORD = 'test-admin';
process.env.DGT_RELAY_SECRET = 'test-relay';
process.env.BOARD_PASSWORD = 'test-board';

const crypto = require('crypto');
const secp256k1 = require('secp256k1');
const db = require('../src/db');
const engine = require('../src/domain/eventEngine');
const dgt = require('../src/domain/dgtState');
const chess960 = require('../src/domain/chess960');
const lightningAuth = require('../src/domain/lightningAuth');
const { makeAdminToken, validAdminToken } = require('../src/routes/middleware');

(async () => {
  await db.initialize(process.env.DATABASE_PATH);
  engine.init({ emit() {} });

  assert.equal(validAdminToken('bad-token'), false, 'bad admin token should not validate');
  assert.equal(validAdminToken(makeAdminToken()), true, 'signed admin token should validate');

  let priv;
  do { priv = crypto.randomBytes(32); } while (!secp256k1.privateKeyVerify(priv));
  const pub = Buffer.from(secp256k1.publicKeyCreate(priv)).toString('hex');
  const challenge = lightningAuth.createChallenge('https://event.example');
  const signed = secp256k1.ecdsaSign(Buffer.from(challenge.k1, 'hex'), priv);
  const sig = Buffer.from(secp256k1.signatureExport(signed.signature)).toString('hex');
  const verified = lightningAuth.verify(challenge.k1, { sig, key: pub });
  assert.equal(verified.success, true);
  assert.equal(verified.authId, pub);
  lightningAuth.resetForTests();

  const returningId = db.createPlayer({ name: 'Returning Player', authType: 'lightning', authId: pub, sessionToken: 'old-token' });
  const returning = db.getPlayerByAuth('lightning', pub);
  assert.equal(returning.id, returningId, 'returning Lightning auth should resolve existing player');
  db.setPlayerToken(returning.id, 'new-token');
  assert.equal(db.getPlayerByToken('new-token').name, 'Returning Player');
  dgt.setExpectedPosition(518);
  let dgtState = dgt.update({ fen: chess960.positionToStartingFen(518), clock: { white: 180, black: 180, running: true, activeSide: 'white' } });
  assert.equal(dgtState.setupOk, true, 'DGT setup should verify matching Chess960 FEN');
  assert.equal(dgtState.clock.white, 180);

  const pinOnly = engine.registerPlayer('Pin Only').player;
  let denied = engine.joinQueue(pinOnly.id);
  assert.equal(denied.error, 'Lightning wallet login required');

  const a = engine.registerPlayer('Alice', { authType: 'lightning', authId: 'alice-key' }).player;
  const b = engine.registerPlayer('Bob', { authType: 'lightning', authId: 'bob-key' }).player;
  const c = engine.registerPlayer('Charlie', { authType: 'lightning', authId: 'charlie-key' }).player;
  let r = engine.joinQueue(a.id);
  assert.equal(r.success, true);
  assert.equal(r.autoCrowned, true);
  assert.equal(engine.getState().king.name, 'Alice');
  r = engine.joinQueue(b.id);
  assert.equal(r.success, true);
  await new Promise(resolve => setTimeout(resolve, 1000));
  let s = engine.getState();
  assert(s.game, 'game should auto-start');
  assert.equal(s.game.king_name, 'Alice');
  assert.equal(s.game.challenger_name, 'Bob');
  assert.equal(s.game.king_color, 'black');
  assert.equal(s.game.table_started_at, null, 'new pairing should not be table-started yet');
  assert.equal(engine.reportResult(a.id, 'king_won').error, 'Game has not started at the table');
  assert.equal(engine.finalizeGame(s.game.id, 'king_won').error, 'Game has not started at the table');
  const wrongPosition = s.game.chess960_position === 0 ? 1 : 0;
  dgtState = dgt.update({ fen: chess960.positionToStartingFen(wrongPosition), clock: { white: 180, black: 180, running: true, activeSide: 'white' } });
  assert.equal(dgtState.setupOk, false, 'wrong DGT setup should not verify');
  assert.equal(engine.startTableGame().error, 'setup_not_ready', 'table start should require correct DGT setup');
  dgt.setExpectedPosition(s.game.chess960_position);
  dgtState = dgt.update({ fen: chess960.positionToStartingFen(s.game.chess960_position), clock: { white: 180, black: 180, running: true, activeSide: 'white' } });
  assert.equal(engine.maybeAutoStartFromDgt(dgtState).started, true, 'matching DGT setup plus running clock should auto-start table game');
  s = engine.getState();
  assert(s.game.table_started_at, 'DGT auto-start should mark pairing as started');

  r = engine.joinQueue(c.id);
  assert.equal(r.success, true);
  assert.equal(engine.getState().queue.length, 1);
  assert.equal(engine.adminReorderQueue([c.id]).success, true);

  let pz = engine.pauseEvent();
  assert.equal(pz.success, true);
  assert.equal(engine.getState().event.paused, true);
  await new Promise(resolve => setTimeout(resolve, 1100));
  s = engine.getState();
  assert(s.game, 'current game should continue while paused');
  assert(s.liveSats > 0, 'sats should keep accruing while paused');

  engine.finalizeGame(s.game.id, 'king_won');
  s = engine.getState();
  assert.equal(s.king.name, 'Alice');
  assert.equal(s.game, null, 'next game should not auto-start while paused');
  assert.equal(s.queue.length, 1, 'queued challenger should wait while paused');
  assert.equal(s.queue[0].player_name, 'Charlie');

  pz = engine.resumeEvent();
  assert.equal(pz.success, true);
  await new Promise(resolve => setTimeout(resolve, 50));
  s = engine.getState();
  assert.equal(s.event.paused, false);
  assert(s.game, 'resume should start waiting challenger');
  assert.equal(s.game.challenger_name, 'Charlie');
  assert.equal(s.game.table_started_at, null, 'resumed next pairing should still wait for table start');
  const previousReignSats = s.reign.total_sats_earned;
  dgt.setExpectedPosition(s.game.chess960_position);
  dgtState = dgt.update({ fen: chess960.positionToStartingFen(s.game.chess960_position), clock: { white: 180, black: 180, running: true, activeSide: 'white' } });
  assert.equal(engine.maybeAutoStartFromDgt(dgtState).started, true, 'DGT should auto-start the next game too');
  await new Promise(resolve => setTimeout(resolve, 1100));
  s = engine.getState();
  assert(s.liveSats > previousReignSats, 'same-king next game should keep adding to reign sats');
  const eventTotalBeforeThroneChange = s.eventTotalSats;

  engine.finalizeGame(s.game.id, 'challenger_won');
  s = engine.getState();
  assert.equal(s.king.name, 'Charlie');
  assert.equal(s.liveSats, 0, 'new reign should reset reign sats');
  assert(s.eventTotalSats >= eventTotalBeforeThroneChange, 'event total should not reset when throne changes');
  db.addSats(b.id, 100);
  const p = db.reservePayout(b.id, 60, 'test');
  assert(p.payoutId);
  assert.equal(db.getPlayer(b.id).sat_balance, 40);
  assert.equal(db.getPlayer(b.id).reserved_sats, 60);
  db.payoutFail(p.payoutId, 'no route');
  assert.equal(db.getPlayer(b.id).sat_balance, 100);
  assert.equal(db.getPlayer(b.id).reserved_sats, 0);
  assert(db.payoutFail(p.payoutId, 'second click').error, 'failed payout should not refund twice');
  const p2 = db.reservePayout(b.id, 40, 'manual-admin-payout');
  assert(p2.payoutId);
  assert.equal(db.payoutComplete(p2.payoutId, 'manual').success, true);
  assert(db.payoutComplete(p2.payoutId, 'second click').error, 'completed payout should not complete twice');

  db.resetEventData();
  assert.equal(db.eventTotalSatsEarned(), 0, 'event reset should clear event-wide sats total');
  const bobAfterReset = db.getPlayer(b.id);
  assert.equal(bobAfterReset.sat_balance, 60, 'event reset should preserve remaining claimable balance');
  assert.equal(bobAfterReset.total_sats_claimed, 40, 'event reset should preserve claimed total');
  assert.equal(bobAfterReset.auth_type, 'lightning', 'event reset should preserve Lightning identity');
  assert.equal(bobAfterReset.games_played, 0, 'event reset should clear event stats');
  assert.equal(db.getQueue().length, 0, 'event reset should clear queue');
  const resetReignId = db.startReign(b.id);
  const resetGameId = db.createGame({ kingId: b.id, challengerId: c.id, position: 171, reignId: resetReignId });
  assert.equal(resetGameId, 1, 'event reset should restart game numbering at #1');
  engine.shutdown();
  db.shutdown();
  console.log('v2 smoke tests passed');
})().catch(err => { console.error(err); try { engine.shutdown(); db.shutdown(); } catch (_) {} process.exit(1); });
