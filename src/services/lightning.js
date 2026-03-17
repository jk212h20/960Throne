/**
 * Lightning Network service
 * Connects to Voltage LND node via REST API
 * Adapted from BitcoinReview project
 */

const LND_REST_URL = process.env.LND_REST_URL;
const LND_MACAROON = process.env.LND_MACAROON;

/**
 * Make an authenticated request to the LND REST API
 */
async function lndRequest(path, method = 'GET', body = null) {
    if (!LND_REST_URL || !LND_MACAROON) {
        throw new Error('LND node not configured. Set LND_REST_URL and LND_MACAROON.');
    }

    const url = `${LND_REST_URL}${path}`;
    const options = {
        method,
        headers: {
            'Grpc-Metadata-macaroon': LND_MACAROON,
            'Content-Type': 'application/json'
        }
    };

    if (body) {
        options.body = JSON.stringify(body);
    }

    let response;
    try {
        response = await fetch(url, options);
    } catch (fetchErr) {
        throw new Error(`LND connection failed (${path}): ${fetchErr.message}`);
    }

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`LND API error (${response.status} on ${path}): ${errorText}`);
    }

    return await response.json();
}

/**
 * Get node info (alias, pubkey, etc.)
 */
async function getNodeInfo() {
    return await lndRequest('/v1/getinfo');
}

/**
 * Get wallet balance
 */
async function getWalletBalance() {
    return await lndRequest('/v1/balance/blockchain');
}

/**
 * Get channel balance
 */
async function getChannelBalance() {
    return await lndRequest('/v1/balance/channels');
}

/**
 * Pay a BOLT11 invoice
 * IMPORTANT: LND's /v1/channels/transactions returns HTTP 200 even when payment fails.
 * The response contains a `payment_error` field on failure — we MUST check it.
 */
async function payInvoice(payReq, amountSats = null) {
    const body = {
        payment_request: payReq,
        fee_limit: {
            fixed: '100' // Max 100 sats fee
        }
    };

    if (amountSats) {
        body.amt = String(amountSats);
    }

    const result = await lndRequest('/v1/channels/transactions', 'POST', body);

    // LND returns HTTP 200 with payment_error field when payment fails (e.g., no route)
    if (result.payment_error) {
        throw new Error(`LND payment failed: ${result.payment_error}`);
    }

    return result;
}

/**
 * Check if a Lightning Address uses BIP-353 (Bolt12 offers)
 * Returns the Bolt12 offer string if found, null otherwise.
 */
async function checkBip353(user, domain) {
    try {
        const dnsName = `${user}.user._bitcoin-payment.${domain}`;
        const url = `https://dns.google/resolve?name=${encodeURIComponent(dnsName)}&type=TXT`;
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) return null;
        const data = await response.json();
        if (data.Answer) {
            for (const answer of data.Answer) {
                const txt = (answer.data || '').replace(/^"|"$/g, '');
                if (txt.includes('lno=')) {
                    return txt;
                }
            }
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Resolve a Lightning Address to LNURL-pay metadata
 */
async function resolveLightningAddress(address) {
    if (!address || !address.includes('@')) {
        throw new Error('Invalid Lightning Address format. Expected user@domain.com');
    }

    const [user, domain] = address.split('@');
    const url = `https://${domain}/.well-known/lnurlp/${user}`;

    console.log(`Resolving Lightning Address: ${address} -> ${url}`);

    let response;
    try {
        response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    } catch (fetchErr) {
        const bip353 = await checkBip353(user, domain);
        if (bip353) {
            throw new Error(
                `${address} uses BIP-353/Bolt12 (not LNURL). ` +
                `This address only works with Bolt12-compatible wallets. ` +
                `Our LND node cannot pay Bolt12 offers. ` +
                `Please use a standard LNURL Lightning Address (e.g., Wallet of Satoshi, Alby, Coinos, etc.)`
            );
        }
        throw new Error(`Failed to connect to ${domain} for Lightning Address resolution: ${fetchErr.message}`);
    }
    if (!response.ok) {
        throw new Error(`Failed to resolve Lightning Address ${address}: ${response.status}`);
    }

    const data = await response.json();

    if (data.status === 'ERROR') {
        throw new Error(`Lightning Address error: ${data.reason}`);
    }

    if (data.tag !== 'payRequest') {
        throw new Error(`Unexpected LNURL tag: ${data.tag}`);
    }

    return {
        callback: data.callback,
        minSendable: data.minSendable,
        maxSendable: data.maxSendable,
        metadata: data.metadata,
        domain
    };
}

/**
 * Request an invoice from a Lightning Address LNURL-pay endpoint
 */
async function requestInvoice(callback, amountSats, comment = '') {
    const amountMsats = amountSats * 1000;
    let url = `${callback}${callback.includes('?') ? '&' : '?'}amount=${amountMsats}`;

    if (comment) {
        url += `&comment=${encodeURIComponent(comment)}`;
    }

    console.log(`Requesting invoice for ${amountSats} sats from ${url}`);

    let response;
    try {
        response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    } catch (fetchErr) {
        throw new Error(`Failed to connect to LNURL callback for invoice request: ${fetchErr.message}`);
    }
    if (!response.ok) {
        throw new Error(`Failed to request invoice: ${response.status}`);
    }

    const data = await response.json();

    if (data.status === 'ERROR') {
        throw new Error(`Invoice request error: ${data.reason}`);
    }

    return {
        pr: data.pr,
        routes: data.routes,
        successAction: data.successAction
    };
}

/**
 * Pay a Lightning Address a specific amount in sats
 * Full flow: resolve address -> request invoice -> pay invoice
 */
async function payLightningAddress(address, amountSats, comment = '') {
    console.log(`💸 Paying ${amountSats} sats to ${address}...`);

    // Step 1: Resolve Lightning Address
    const lnurlData = await resolveLightningAddress(address);

    // Validate amount is within bounds
    const minSats = Math.ceil(lnurlData.minSendable / 1000);
    const maxSats = Math.floor(lnurlData.maxSendable / 1000);

    if (amountSats < minSats) {
        throw new Error(`Amount ${amountSats} sats is below minimum ${minSats} sats`);
    }
    if (amountSats > maxSats) {
        throw new Error(`Amount ${amountSats} sats exceeds maximum ${maxSats} sats`);
    }

    // Step 2: Request invoice
    const invoiceData = await requestInvoice(lnurlData.callback, amountSats, comment);
    console.log(`📄 Got invoice: ${invoiceData.pr.substring(0, 40)}...`);

    // Step 3: Pay the invoice
    const paymentResult = await payInvoice(invoiceData.pr);
    console.log(`✅ Payment sent!`);

    return {
        success: true,
        address,
        amountSats,
        paymentHash: paymentResult.payment_hash,
        paymentPreimage: paymentResult.payment_preimage,
        invoice: invoiceData.pr,
        successAction: invoiceData.successAction
    };
}

/**
 * Check if LND node is configured and reachable
 */
async function isConfigured() {
    if (!LND_REST_URL || !LND_MACAROON) {
        return { configured: false, reason: 'LND_REST_URL or LND_MACAROON not set' };
    }

    try {
        const info = await getNodeInfo();
        return {
            configured: true,
            alias: info.alias,
            pubkey: info.identity_pubkey,
            synced: info.synced_to_chain,
            blockHeight: info.block_height
        };
    } catch (error) {
        return { configured: false, reason: error.message };
    }
}

/**
 * Get a new on-chain Bitcoin address from the LND wallet (for deposits).
 */
async function getNewAddress() {
    const result = await lndRequest('/v1/newaddress', 'GET');
    return result.address;
}

/**
 * Create a Lightning invoice (for receiving sats via Lightning).
 * @param {number} amountSats - Amount in sats
 * @param {string} memo - Invoice description
 * @param {number} expiry - Expiry in seconds (default 3600 = 1 hour)
 */
async function createInvoice(amountSats, memo = '', expiry = 3600) {
    const result = await lndRequest('/v1/invoices', 'POST', {
        value: String(amountSats),
        memo: memo || '960 Throne node top-up',
        expiry: String(expiry),
    });
    return {
        paymentRequest: result.payment_request,
        rHash: result.r_hash,
        addIndex: result.add_index,
    };
}

/**
 * List open channels.
 */
async function listChannels() {
    const result = await lndRequest('/v1/channels');
    return result.channels || [];
}

/**
 * List pending channels (opening/closing).
 */
async function listPendingChannels() {
    const result = await lndRequest('/v1/channels/pending');
    return result;
}

/**
 * Connect to a Lightning peer by pubkey@host:port.
 */
async function connectPeer(pubkey, host) {
    return await lndRequest('/v1/peers', 'POST', {
        addr: { pubkey, host },
        perm: false,
    });
}

/**
 * Open a channel to a peer.
 * @param {string} pubkey - Peer's public key
 * @param {number} localFundingAmount - Amount in sats to fund the channel
 * @param {number} pushSats - Amount to push to remote side (0 for normal)
 */
async function openChannel(pubkey, localFundingAmount, pushSats = 0) {
    return await lndRequest('/v1/channels', 'POST', {
        node_pubkey_string: pubkey,
        local_funding_amount: String(localFundingAmount),
        push_sat: String(pushSats),
        spend_unconfirmed: false,
    });
}

/**
 * Send on-chain Bitcoin to an address.
 * Uses LND's SendCoins RPC. Fees are paid by the node (not deducted from amount).
 * @param {string} address - Bitcoin address (bc1..., 1..., or 3...)
 * @param {number} amountSats - Amount in satoshis to send
 * @param {number} satPerVbyte - Fee rate (optional, LND estimates if omitted)
 * @returns {{ txid: string }} Transaction ID
 */
async function sendOnChain(address, amountSats, satPerVbyte = null) {
    const body = {
        addr: address,
        amount: String(amountSats),
        send_all: false,
    };
    if (satPerVbyte) {
        body.sat_per_vbyte = String(satPerVbyte);
    }

    console.log(`⛓️ Sending ${amountSats} sats on-chain to ${address}...`);
    const result = await lndRequest('/v1/transactions', 'POST', body);

    if (!result.txid) {
        throw new Error(`On-chain send returned no txid: ${JSON.stringify(result).substring(0, 200)}`);
    }

    console.log(`⛓️ On-chain tx broadcast: ${result.txid}`);
    return { txid: result.txid };
}

/**
 * Estimate on-chain fee for a transaction.
 * @param {string} address - Target Bitcoin address
 * @param {number} amountSats - Amount in satoshis
 * @param {number} targetConfs - Target confirmations (default 6)
 * @returns {{ fee_sat: string, feerate_sat_per_byte: string }}
 */
async function estimateOnChainFee(address, amountSats, targetConfs = 6) {
    const params = new URLSearchParams({
        AddrToAmount: JSON.stringify({ [address]: String(amountSats) }),
        target_conf: String(targetConfs),
    });
    // LND estimatefee endpoint
    const result = await lndRequest(`/v1/transactions/fee?addr=${encodeURIComponent(address)}&amount=${amountSats}&target_conf=${targetConfs}`);
    return {
        feeSat: parseInt(result.fee_sat || '0'),
        feerateSatPerByte: parseInt(result.feerate_sat_per_byte || result.sat_per_vbyte || '0'),
    };
}

/**
 * List recent payments from LND.
 * Returns array of payment objects with payment_hash, value_sat, status, etc.
 * @param {number} maxPayments - Maximum number of payments to return (default 100)
 */
async function listPayments(maxPayments = 100) {
    const result = await lndRequest(`/v1/payments?include_incomplete=true&max_payments=${maxPayments}&reversed=true`);
    return result.payments || [];
}

module.exports = {
    getNodeInfo,
    getWalletBalance,
    getChannelBalance,
    payInvoice,
    listPayments,
    getNewAddress,
    createInvoice,
    listChannels,
    listPendingChannels,
    connectPeer,
    openChannel,
    resolveLightningAddress,
    requestInvoice,
    payLightningAddress,
    sendOnChain,
    estimateOnChainFee,
    isConfigured,
};
