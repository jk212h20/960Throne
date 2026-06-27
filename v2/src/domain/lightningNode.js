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
async function payInvoice(paymentRequest, amountSats = null) {
  if (!paymentRequest || typeof paymentRequest !== 'string') throw new Error('Payment request required');
  const body = { payment_request: paymentRequest, fee_limit: { fixed: '100' } };
  if (amountSats) body.amt = String(amountSats);
  const result = await lndRequest('/v1/channels/transactions', 'POST', body);
  if (result.payment_error) throw new Error(`LND payment failed: ${result.payment_error}`);
  return result;
}
async function checkBip353(user, domain) {
  try {
    const dnsName = `${user}.user._bitcoin-payment.${domain}`;
    const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(dnsName)}&type=TXT`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.Answer || []).map(a => String(a.data || '').replace(/^"|"$/g, '')).find(txt => txt.includes('lno=')) || null;
  } catch { return null; }
}
function normalizeLightningAddress(address) {
  const cleaned = String(address || '').trim().replace(/^lightning:/i, '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleaned)) throw new Error('Invalid Lightning Address. Use name@domain.com');
  return cleaned;
}
async function resolveLightningAddress(address) {
  const normalized = normalizeLightningAddress(address);
  const [user, domain] = normalized.split('@');
  let res;
  try {
    res = await fetch(`https://${domain}/.well-known/lnurlp/${encodeURIComponent(user)}`, { signal: AbortSignal.timeout(10000) });
  } catch (err) {
    const bip353 = await checkBip353(user, domain);
    if (bip353) throw new Error(`${normalized} uses BIP-353/Bolt12; use a standard LNURL Lightning Address`);
    throw new Error(`Failed to resolve Lightning Address: ${err.message}`);
  }
  if (!res.ok) throw new Error(`Failed to resolve Lightning Address: HTTP ${res.status}`);
  const data = await res.json();
  if (data.status === 'ERROR') throw new Error(data.reason || 'Lightning Address error');
  if (data.tag !== 'payRequest') throw new Error(`Unexpected LNURL tag: ${data.tag || 'missing'}`);
  return { address: normalized, callback: data.callback, minSendable: Number(data.minSendable || 0), maxSendable: Number(data.maxSendable || 0), metadata: data.metadata };
}
async function requestLightningAddressInvoice(lnurl, amountSats, comment = '') {
  const amountMsats = amountSats * 1000;
  const minSats = Math.ceil(lnurl.minSendable / 1000);
  const maxSats = Math.floor(lnurl.maxSendable / 1000);
  if (amountSats < minSats) throw new Error(`Amount ${amountSats} sats is below minimum ${minSats} sats`);
  if (amountSats > maxSats) throw new Error(`Amount ${amountSats} sats exceeds maximum ${maxSats} sats`);
  const sep = lnurl.callback.includes('?') ? '&' : '?';
  let url = `${lnurl.callback}${sep}amount=${amountMsats}`;
  if (comment) url += `&comment=${encodeURIComponent(comment)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Failed to request invoice: HTTP ${res.status}`);
  const data = await res.json();
  if (data.status === 'ERROR') throw new Error(data.reason || 'Invoice request error');
  if (!data.pr) throw new Error('Lightning Address did not return an invoice');
  return { invoice: data.pr, routes: data.routes, successAction: data.successAction };
}
async function payLightningAddress(address, amountSats, comment = '') {
  if (!configured()) throw new Error('LND node not configured');
  const amount = Number(amountSats);
  if (!Number.isInteger(amount) || amount < 10) throw new Error('Minimum claim is 10 sats');
  const lnurl = await resolveLightningAddress(address);
  const invoice = await requestLightningAddressInvoice(lnurl, amount, comment);
  const payment = await payInvoice(invoice.invoice);
  return { success: true, address: lnurl.address, amountSats: amount, invoice: invoice.invoice, paymentHash: payment.payment_hash || payment.payment_hash_string || null, paymentPreimage: payment.payment_preimage || null, successAction: invoice.successAction };
}
module.exports = { configured, getBalances, createTopupInvoice, payInvoice, resolveLightningAddress, requestLightningAddressInvoice, payLightningAddress, normalizeLightningAddress };
