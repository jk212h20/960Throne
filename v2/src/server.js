const path = require('path');
const express = require('express');
const compression = require('compression');
const http = require('http');
const { Server } = require('socket.io');
const { config, assertNoUnsafeDefaults, redactedStatus } = require('./config/env');
const db = require('./db');
const engine = require('./domain/eventEngine');
const dgt = require('./domain/dgtState');

async function main() {
  assertNoUnsafeDefaults();
  await db.initialize();
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: config.isProduction ? false : '*' } });
  engine.init(io); dgt.init(io);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use('/public', express.static(path.join(__dirname, 'public')));
  app.use('/api', require('./routes/api'));
  app.use('/', require('./routes/pages'));
  io.on('connection', socket => { socket.emit('state', engine.publicState()); socket.emit('dgt_state', dgt.snapshot()); });
  const shutdown = sig => { console.log(`\n${sig}: saving v2 DB`); db.shutdown(); process.exit(0); };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', err => { console.error(err); db.shutdown(); process.exit(1); });
  server.listen(config.port, () => { console.log(`♛ 960Throne v2 on :${config.port}`); console.log('preflight', redactedStatus()); });
}
if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });
module.exports = { main };
