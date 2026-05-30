const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

function intEnv(name, fallback) {
  const raw = process.env[name];
  const n = raw == null || raw === '' ? fallback : parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`Invalid integer env ${name}=${raw}`);
  return n;
}

const isProduction = process.env.NODE_ENV === 'production';

const config = {
  env: process.env.NODE_ENV || 'development',
  isProduction,
  port: intEnv('PORT', 3002),
  baseUrl: process.env.BASE_URL || 'http://localhost:3002',
  databasePath: process.env.DATABASE_PATH || path.resolve(process.cwd(), 'v2/data/throne-v2.db'),
  adminPassword: process.env.ADMIN_PASSWORD || '',
  dgtRelaySecret: process.env.DGT_RELAY_SECRET || '',
  boardPassword: process.env.BOARD_PASSWORD || '',
  sessionSecret: process.env.SESSION_SECRET || '',
  satRatePerSecond: intEnv('SAT_RATE_PER_SECOND', 21),
  timeControlBase: intEnv('TIME_CONTROL_BASE', 180),
  timeControlIncrement: intEnv('TIME_CONTROL_INCREMENT', 2),
  dgtClockSwapSides: process.env.DGT_CLOCK_SWAP_SIDES === 'true',
  lndRestUrl: process.env.LND_REST_URL || '',
  lndMacaroon: process.env.LND_MACAROON || '',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
};

function assertNoUnsafeDefaults() {
  const unsafe = ['changeme', 'MarioWins', 'throne960', 'password', 'admin'];
  const requiredProd = ['ADMIN_PASSWORD', 'DGT_RELAY_SECRET', 'BOARD_PASSWORD', 'SESSION_SECRET', 'BASE_URL'];
  const missing = requiredProd.filter(name => !process.env[name]);
  const bad = [
    ['ADMIN_PASSWORD', config.adminPassword],
    ['DGT_RELAY_SECRET', config.dgtRelaySecret],
    ['BOARD_PASSWORD', config.boardPassword],
    ['SESSION_SECRET', config.sessionSecret],
  ].filter(([, value]) => unsafe.includes(value));
  if (config.isProduction && (missing.length || bad.length)) {
    throw new Error(`Unsafe production config. Missing: ${missing.join(', ') || 'none'}; unsafe defaults: ${bad.map(b => b[0]).join(', ') || 'none'}`);
  }
}

function redactedStatus() {
  return {
    env: config.env,
    port: config.port,
    baseUrl: config.baseUrl,
    databasePath: config.databasePath,
    lightningConfigured: Boolean(config.lndRestUrl && config.lndMacaroon),
    telegramConfigured: Boolean(config.telegramBotToken && config.telegramChatId),
    dgtRelaySecretSet: Boolean(config.dgtRelaySecret),
    adminPasswordSet: Boolean(config.adminPassword),
    boardPasswordSet: Boolean(config.boardPassword),
    dgtClockSwapSides: config.dgtClockSwapSides,
  };
}

module.exports = { config, assertNoUnsafeDefaults, redactedStatus };
