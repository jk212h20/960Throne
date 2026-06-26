const { config } = require('../config/env');

function configured() { return Boolean(config.lndRestUrl && config.lndMacaroon); }
async function lndRequest(path, method = 'GET', body = null) {
  if (!configured()) throw new Error('LND node not configured');
  const url = `${config.lndRestUrl.replace(/\/$/, '')}${path}`;
  const options = { method, headers: { 'Grpc-Metadata-macaroon': config.lndMacaroon, 'Content-Type': 'application/json' } };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`LND API error ${res.status}: ${await res.text()}`);
  return res.json();
}
async function getBalances() {
  if (!configured()) return { configured: false, error: 'LND_REST_URL/LND_MACAROON not configured' };
  const [info, wallet, channels] = await Promise.all([
    lndRequest('/v1/getinfo').catch(err => ({ error: err.message })),
    lndRequest('/v1/balance/blockchain').catch(err => ({ error: err.message })),
    lndRequest('/v1/balance/channels').catch(err => ({ error: err.message })),
  ]);
  return { configured: true, info, wallet, channels };
}
async function createTopupInvoice(amountSats, memo = '960 Throne node top-up', expiry = 3600) {
  if (!Number.isInteger(amountSats) || amountSats < 1 || amountSats > 100000000) throw new Error('Amount must be 1-100000000 sats');
  const result = await lndRequest('/v1/invoices', 'POST', { value: String(amountSats), memo, expiry: String(expiry) });
  return { paymentRequest: result.payment_request, rHash: result.r_hash, addIndex: result.add_index, amountSats, memo, expiry };
}
module.exports = { configured, getBalances, createTopupInvoice };
