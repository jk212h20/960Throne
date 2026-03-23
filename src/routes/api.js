/**
 * API Routes — All JSON endpoints
 */

const express = require('express');
const router = express.Router();
const db = require('../services/database');
const gameEngine = require('../services/gameEngine');
const lightning = require('../services/lightning');
const auth = require('../services/auth');
const telegram = require('../services/telegram');
const chess960 = require('../services/chess960');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { encodeLnurl } = require('../services/auth/lightning');

// ============================================================
// Auth middleware
// ============================================================

function requirePlayer(req, res, next) {
    const token = req.cookies?.session || req.headers['x-session-token'];
    if (!token) return res.status(401).json({ error: 'Not logged in' });
    const player = db.getPlayerBySession(token);
    if (!player) return res.status(401).json({ error: 'Invalid session' });
    req.player = player;
    next();
}

function requireAdmin(req, res, next) {
    const dbPassword = db.getConfig('admin_password_override');
    const adminPassword = dbPassword || process.env.ADMIN_PASSWORD || 'changeme';
    const provided = req.cookies?.admin_token || req.headers['x-admin-token'];
    if (provided !== adminPassword) {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

// ============================================================
// Player Auth (Lightning login via /api/auth/* routes below)
// ============================================================

// Logout
router.post('/logout', (req, res) => {
    res.clearCookie('session');
    res.json({ success: true });
});

// Get current player
router.get('/me', requirePlayer, (req, res) => {
    const player = req.player;
    const queueEntry = db.getQueueEntry(player.id);
    const games = db.getPlayerGames(player.id, 10);
    const payouts = db.getPlayerPayouts(player.id);
    res.json({ player, queueEntry, games, payouts });
});

// ============================================================
// Queue
// ============================================================

router.post('/queue/join', requirePlayer, (req, res) => {
    const { venueCode } = req.body;

    // Validate venue code
    if (!db.validateVenueCode(venueCode)) {
        return res.status(403).json({ error: 'Invalid or expired venue code. Scan the QR at the venue to join.' });
    }

    const result = gameEngine.joinQueue(req.player.id);
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

router.post('/queue/leave', requirePlayer, (req, res) => {
    const result = gameEngine.leaveQueue(req.player.id);
    res.json(result);
});

router.get('/queue', (req, res) => {
    res.json({ queue: db.getQueue() });
});

// ============================================================
// Game
// ============================================================

// Debounce: track last accepted report per player to prevent accidental double-reports
const lastReportTime = new Map(); // playerId → timestamp (ms)
const REPORT_DEBOUNCE_MS = 30 * 1000; // 30 seconds

router.post('/game/report', requirePlayer, (req, res) => {
    const { result } = req.body;
    if (!result) return res.status(400).json({ error: 'Result is required' });

    // Check debounce — reject if this player reported less than 30s ago
    const now = Date.now();
    const lastTime = lastReportTime.get(req.player.id);
    if (lastTime && (now - lastTime) < REPORT_DEBOUNCE_MS) {
        const waitSec = Math.ceil((REPORT_DEBOUNCE_MS - (now - lastTime)) / 1000);
        return res.status(429).json({ error: `Please wait ${waitSec}s before reporting again.` });
    }

    const outcome = gameEngine.reportResult(req.player.id, result);
    if (outcome.error) return res.status(400).json(outcome);

    // Record successful report time
    lastReportTime.set(req.player.id, now);

    res.json(outcome);
});

router.get('/game/active', (req, res) => {
    const game = db.getActiveGame();
    res.json({ game });
});

// ============================================================
// Throne State
// ============================================================

router.get('/throne', (req, res) => {
    res.json(gameEngine.getThoneState());
});

// ============================================================
// Leaderboard & Stats
// ============================================================

router.get('/leaderboard', (req, res) => {
    res.json({
        leaderboard: db.getLeaderboard(),
        longestReigns: db.getLongestReigns(),
        stats: db.getEventStats()
    });
});

// ============================================================
// Sat Claims (Lightning payouts)
// ============================================================

router.post('/claim', requirePlayer, async (req, res) => {
    const { lightningAddress, amount } = req.body;
    const player = req.player;

    if (!lightningAddress) {
        return res.status(400).json({ error: 'Lightning address required (e.g., user@walletofsatoshi.com)' });
    }

    const claimAmount = amount ? parseInt(amount) : player.sat_balance;
    if (claimAmount <= 0) {
        return res.status(400).json({ error: 'No sats to claim' });
    }
    if (claimAmount > player.sat_balance) {
        return res.status(400).json({ error: `Insufficient balance. You have ${player.sat_balance} sats.` });
    }
    if (claimAmount < 10) {
        return res.status(400).json({ error: 'Minimum claim is 10 sats' });
    }

    // Check if Lightning is configured
    const lnStatus = await lightning.isConfigured();
    if (!lnStatus.configured) {
        return res.status(503).json({ error: 'Lightning payments not available. Ask an admin to claim manually.' });
    }

    // Create payout record
    const payoutId = db.createPayout(player.id, claimAmount, lightningAddress);

    try {
        const payResult = await lightning.payLightningAddress(
            lightningAddress,
            claimAmount,
            `960 Throne payout for ${player.name}`
        );

        // Success — deduct from balance
        db.deductSatsFromPlayer(player.id, claimAmount);
        db.updatePayout(payoutId, {
            payment_hash: payResult.paymentHash,
            status: 'completed',
            completed_at: new Date().toISOString()
        });

        // Schedule auto-verify 60s later as safety net
        schedulePaymentVerify(payoutId, player.id, player.name, claimAmount, payResult.paymentHash);

        res.json({
            success: true,
            amount: claimAmount,
            paymentHash: payResult.paymentHash,
            message: `⚡ ${claimAmount} sats sent to ${lightningAddress}!`
        });
    } catch (err) {
        db.updatePayout(payoutId, {
            status: 'failed',
            error_message: err.message
        });
        // 🚨 Alert admin immediately
        telegram.notifyAdmin(`⚠️ PAYOUT FAILED: ${claimAmount} sats to ${player.name}\nAddress: ${lightningAddress}\nError: ${err.message}`);
        db.createNotification('payout_failed', `Payout failed: ${claimAmount} sats to ${player.name} — ${err.message}`);
        res.status(500).json({
            error: `Payment failed: ${err.message}`,
            hint: err.message.includes('Bolt12') ? 'Try a different wallet (WoS, Alby, Coinos)' : undefined
        });
    }
});

// ============================================================
// On-chain Bitcoin cashout (for large balances ≥ 200k sats)
// ============================================================

const ONCHAIN_MIN_SATS = 200000; // 200k sats minimum for on-chain

router.post('/claim/onchain', requirePlayer, async (req, res) => {
    const { bitcoinAddress, amount } = req.body;
    const player = req.player;

    if (!bitcoinAddress) {
        return res.status(400).json({ error: 'Bitcoin address required' });
    }

    // Basic Bitcoin address validation (mainnet: bc1, 1, 3)
    const btcAddrRegex = /^(bc1[a-zA-HJ-NP-Z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/;
    if (!btcAddrRegex.test(bitcoinAddress)) {
        return res.status(400).json({ error: 'Invalid Bitcoin address. Must be a mainnet address (bc1..., 1..., or 3...)' });
    }

    // Flush sats so balance is current
    gameEngine.flushAccumulatedSats();
    const freshPlayer = db.getPlayerById(player.id);
    const claimAmount = amount ? parseInt(amount) : freshPlayer.sat_balance;

    if (claimAmount < ONCHAIN_MIN_SATS) {
        return res.status(400).json({ error: `On-chain cashout requires at least ${ONCHAIN_MIN_SATS.toLocaleString()} sats.` });
    }
    if (claimAmount > freshPlayer.sat_balance) {
        return res.status(400).json({ error: `Insufficient balance. You have ${freshPlayer.sat_balance.toLocaleString()} sats.` });
    }

    // Check if Lightning (LND node) is configured
    const lnStatus = await lightning.isConfigured();
    if (!lnStatus.configured) {
        return res.status(503).json({ error: 'Bitcoin payments not available right now.' });
    }

    // Create payout record
    const payoutId = db.createPayout(player.id, claimAmount, `onchain:${bitcoinAddress}`);

    try {
        const txResult = await lightning.sendOnChain(bitcoinAddress, claimAmount);

        // Success — deduct from balance
        db.deductSatsFromPlayer(player.id, claimAmount);
        db.updatePayout(payoutId, {
            payment_hash: txResult.txid,
            status: 'completed',
            completed_at: new Date().toISOString()
        });

        console.log(`⛓️ On-chain payout: ${claimAmount} sats to ${bitcoinAddress} (txid: ${txResult.txid})`);

        res.json({
            success: true,
            amount: claimAmount,
            txid: txResult.txid,
            message: `⛓️ ${claimAmount.toLocaleString()} sats sent on-chain to ${bitcoinAddress}! Transaction may take ~10-60 minutes to confirm.`
        });
    } catch (err) {
        db.updatePayout(payoutId, {
            status: 'failed',
            error_message: err.message
        });
        // Alert admin
        telegram.notifyAdmin(`⚠️ ON-CHAIN PAYOUT FAILED: ${claimAmount} sats to ${player.name}\nAddress: ${bitcoinAddress}\nError: ${err.message}`);
        db.createNotification('payout_failed', `On-chain payout failed: ${claimAmount} sats to ${player.name} — ${err.message}`);
        res.status(500).json({
            error: `On-chain payment failed: ${err.message}`
        });
    }
});

// ============================================================
// LNURL-withdraw — One-tap sat claim (LUD-03)
// ============================================================

// In-memory store for pending withdraw sessions
// Map<k1, { playerId, amount, status, invoice, createdAt, payoutId }>
const pendingWithdraws = new Map();

// Clean up expired withdraw sessions every 2 minutes
const WITHDRAW_TTL_MS = 5 * 60 * 1000; // 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [k1, session] of pendingWithdraws) {
        if (now - session.createdAt > WITHDRAW_TTL_MS) {
            pendingWithdraws.delete(k1);
        }
    }
}, 2 * 60 * 1000);

// Step 1: Player taps "Claim sats" — creates a withdraw session and returns LNURL
router.post('/claim/create', requirePlayer, async (req, res) => {
    const player = req.player;
    const { amount } = req.body;

    // Flush sats so balance is current
    gameEngine.flushAccumulatedSats();
    // Re-read player to get fresh balance
    const freshPlayer = db.getPlayerById(player.id);
    const claimAmount = amount ? parseInt(amount) : freshPlayer.sat_balance;

    if (claimAmount <= 0) {
        return res.status(400).json({ error: 'No sats to claim' });
    }
    if (claimAmount > freshPlayer.sat_balance) {
        return res.status(400).json({ error: `Insufficient balance. You have ${freshPlayer.sat_balance} sats.` });
    }
    if (claimAmount < 10) {
        return res.status(400).json({ error: 'Minimum claim is 10 sats' });
    }

    // Check if Lightning is configured
    const lnStatus = await lightning.isConfigured();
    if (!lnStatus.configured) {
        return res.status(503).json({ error: 'Lightning payments not available right now.' });
    }

    // Generate unique k1 for this withdraw session
    const k1 = crypto.randomBytes(32).toString('hex');

    // Store the pending withdraw
    pendingWithdraws.set(k1, {
        playerId: player.id,
        playerName: player.name,
        amount: claimAmount,
        status: 'pending', // pending → paid → complete / failed
        invoice: null,
        payoutId: null,
        createdAt: Date.now(),
    });

    // Build the LNURL-withdraw URL
    const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    const rawUrl = `${baseUrl}/api/claim/lnurl?k1=${k1}`;
    const encoded = encodeLnurl(rawUrl);

    try {
        const qrDataUrl = await QRCode.toDataURL(encoded, {
            width: 400,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' },
        });

        res.json({
            k1,
            lnurl: encoded,
            qr: qrDataUrl,
            deepLink: `lightning:${encoded}`,
            amount: claimAmount,
        });
    } catch (err) {
        pendingWithdraws.delete(k1);
        res.status(500).json({ error: 'Failed to generate withdraw QR' });
    }
});

// Step 2: Wallet hits this to get withdraw parameters (LUD-03 first request)
router.get('/claim/lnurl', (req, res) => {
    const { k1 } = req.query;
    if (!k1) {
        return res.json({ status: 'ERROR', reason: 'Missing k1 parameter' });
    }

    const session = pendingWithdraws.get(k1);
    if (!session) {
        return res.json({ status: 'ERROR', reason: 'Withdraw session expired or not found' });
    }
    if (session.status !== 'pending') {
        return res.json({ status: 'ERROR', reason: 'Withdraw already processed' });
    }

    const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    const amountMsats = session.amount * 1000;

    // LUD-03 response format
    res.json({
        tag: 'withdrawRequest',
        callback: `${baseUrl}/api/claim/callback`,
        k1: k1,
        defaultDescription: `960 Throne: Claim ${session.amount} sats`,
        minWithdrawable: amountMsats,
        maxWithdrawable: amountMsats,
    });
});

// Step 3: Wallet sends invoice here — server pays it (LUD-03 second request)
// IMPORTANT: Responds { status: "OK" } immediately, then pays in background.
// This prevents Railway's reverse proxy from 502-ing on slow LND payments.
router.get('/claim/callback', (req, res) => {
    const { k1, pr } = req.query;

    if (!k1 || !pr) {
        return res.json({ status: 'ERROR', reason: 'Missing k1 or pr (invoice) parameter' });
    }

    const session = pendingWithdraws.get(k1);
    if (!session) {
        return res.json({ status: 'ERROR', reason: 'Withdraw session expired or not found' });
    }
    if (session.status !== 'pending') {
        return res.json({ status: 'ERROR', reason: 'Withdraw already processed' });
    }

    // Mark as processing to prevent double-spend
    session.status = 'paying';
    session.invoice = pr;

    // Re-check balance (in case it changed since create)
    const player = db.getPlayerById(session.playerId);
    if (!player || player.sat_balance < session.amount) {
        session.status = 'failed';
        return res.json({ status: 'ERROR', reason: 'Insufficient balance' });
    }

    // Create payout record
    const payoutId = db.createPayout(session.playerId, session.amount, 'lnurl-withdraw');
    session.payoutId = payoutId;

    // Respond OK immediately — wallet gets confirmation, no 502 timeout
    res.json({ status: 'OK' });

    // Pay the invoice in the background (after response is sent)
    processWithdrawPayment(k1, session, payoutId, pr).catch(err => {
        console.error(`⚡ Background withdraw payment error:`, err.message);
    });
});

/**
 * Background payment processor for LNURL-withdraw.
 * Runs after the callback has already responded { status: "OK" } to the wallet.
 * Updates the in-memory session and DB payout record when payment completes/fails.
 */
async function processWithdrawPayment(k1, session, payoutId, invoice) {
    try {
        // Pay the invoice provided by the wallet
        const payResult = await lightning.payInvoice(invoice);

        // Success — deduct from balance and update records
        db.deductSatsFromPlayer(session.playerId, session.amount);
        db.updatePayout(payoutId, {
            payment_hash: payResult.payment_hash,
            status: 'completed',
            completed_at: new Date().toISOString()
        });

        session.status = 'complete';
        session.paymentHash = payResult.payment_hash;

        console.log(`⚡ LNURL-withdraw: ${session.amount} sats paid to ${session.playerName} (k1: ${k1.substring(0, 8)}...)`);
        // Schedule auto-verify 60s later as safety net
        schedulePaymentVerify(payoutId, session.playerId, session.playerName, session.amount, payResult.payment_hash);
    } catch (err) {
        session.status = 'failed';
        session.error = err.message;
        db.updatePayout(payoutId, {
            status: 'failed',
            error_message: err.message
        });
        // 🚨 Alert admin immediately
        telegram.notifyAdmin(`⚠️ PAYOUT FAILED: ${session.amount} sats to ${session.playerName}\nMethod: LNURL-withdraw\nError: ${err.message}`);
        db.createNotification('payout_failed', `Payout failed: ${session.amount} sats to ${session.playerName} — ${err.message}`);
        console.error(`⚡ LNURL-withdraw failed for ${session.playerName}:`, err.message);
    }
}

// ============================================================
// Auto-verify: 60s after each "completed" payment, check LND
// ============================================================

function normalizeHash(hash) {
    if (!hash) return null;
    if (/^[0-9a-f]{64}$/i.test(hash)) return hash.toLowerCase();
    try { return Buffer.from(hash, 'base64').toString('hex').toLowerCase(); } catch { return hash.toLowerCase(); }
}

function schedulePaymentVerify(payoutId, playerId, playerName, amount, paymentHash) {
    setTimeout(async () => {
        try {
            // Re-read payout — it may have already been reversed by manual reconcile
            const payout = db.getPayoutById ? db.getPayoutById(payoutId) : null;
            if (!payout || payout.status !== 'completed') return; // Already handled

            const lndPayments = await lightning.listPayments(100);
            const normalizedTarget = normalizeHash(paymentHash);

            const lndPay = lndPayments.find(p => {
                const nh = normalizeHash(p.payment_hash);
                return nh === normalizedTarget || p.payment_hash === paymentHash;
            });

            if (lndPay && lndPay.status === 'SUCCEEDED') {
                console.log(`✅ Auto-verify: Payout #${payoutId} confirmed SUCCEEDED on LND`);
                return; // All good
            }

            if (lndPay && lndPay.status === 'FAILED') {
                // Payment actually failed! Reverse it.
                db.refundPayout(payoutId, amount, playerId,
                    `Auto-reversed 60s after payment: LND says FAILED (${lndPay.failure_reason || 'unknown'})`);
                const msg = `🚨 AUTO-REVERSED: Payout #${payoutId} — ${amount} sats to ${playerName}. LND says payment FAILED (${lndPay.failure_reason || 'unknown'}). Balance restored.`;
                console.log(msg);
                telegram.notifyAdmin(msg);
                db.createNotification('payout_reversed', msg);
                return;
            }

            // Payment not found or still IN_FLIGHT — log but don't alert (may still be routing)
            if (!lndPay) {
                console.log(`⚠️ Auto-verify: Payout #${payoutId} hash not found in LND (may still be routing)`);
            }
        } catch (err) {
            console.error(`Auto-verify error for payout #${payoutId}:`, err.message);
        }
    }, 60 * 1000); // 60 seconds
}

// Step 4: Frontend polls this to know when payment completed
router.get('/claim/status/:k1', (req, res) => {
    const { k1 } = req.params;
    const session = pendingWithdraws.get(k1);

    if (!session) {
        return res.json({ status: 'expired' });
    }

    const response = {
        status: session.status,
        amount: session.amount,
    };

    if (session.status === 'complete') {
        response.paymentHash = session.paymentHash;
        response.message = `⚡ ${session.amount} sats sent to your wallet!`;
        // Clean up after frontend has seen it
        setTimeout(() => pendingWithdraws.delete(k1), 30000);
    } else if (session.status === 'failed') {
        response.error = session.error || 'Payment failed';
    }

    res.json(response);
});

// ============================================================
// Auth — Lightning Login (LNURL-auth) + extensible strategies
// ============================================================

// Generate a new auth challenge (returns QR code data for scanning)
router.get('/auth/lightning', async (req, res) => {
    try {
        const challenge = auth.createChallenge('lightning');
        
        // Generate QR code as data URL
        const qrDataUrl = await QRCode.toDataURL(challenge.encodedUrl, {
            width: 400,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' },
        });

        res.json({
            k1: challenge.k1,
            lnurl: challenge.encodedUrl,
            qr: qrDataUrl,
            deepLink: challenge.deepLink,
        });
    } catch (err) {
        console.error('Auth challenge error:', err);
        res.status(500).json({ error: 'Failed to generate auth challenge' });
    }
});

// LNURL-auth callback — wallet hits this URL with sig + key
router.get('/auth/lightning/callback', (req, res) => {
    const { k1, sig, key, tag } = req.query;

    if (!k1 || !sig || !key) {
        return res.json({ status: 'ERROR', reason: 'Missing required parameters (k1, sig, key)' });
    }

    // Verify the signature
    const result = auth.processCallback(k1, { sig, key });

    if (!result.success) {
        return res.json({ status: 'ERROR', reason: result.error });
    }

    // Signature valid — find or create the player
    const authId = result.authId;
    let player = db.getPlayerByAuthId('lightning', authId);
    let isNewPlayer = false;

    if (!player) {
        // Check if registrations are locked
        const regLocked = db.getConfig('registrations_locked');
        if (regLocked === '1' || regLocked === 'true') {
            return res.json({ status: 'ERROR', reason: 'Registrations are currently closed. Thanks for playing!' });
        }
        // New player — create account with lightning auth
        const playerId = db.createPlayerWithAuth('lightning', authId);
        player = db.getPlayerById(playerId);
        isNewPlayer = true;
    }

    // Create session
    const token = uuidv4();
    db.setPlayerSession(player.id, token);
    auth.completeChallenge(k1, token);

    // LNURL spec requires { status: "OK" } response
    return res.json({ status: 'OK' });
});

// Poll auth status — frontend polls this to know when wallet has completed auth
router.get('/auth/status', (req, res) => {
    const { k1 } = req.query;
    if (!k1) return res.status(400).json({ error: 'k1 required' });

    const status = auth.getChallengeStatus(k1);

    if (status.status === 'complete' && status.sessionToken) {
        // Auth complete — set session cookie and return success
        res.cookie('session', status.sessionToken, { 
            httpOnly: true, 
            maxAge: 10 * 365 * 24 * 60 * 60 * 1000, // 10 years — effectively never expires
            path: '/' 
        });

        // Check if player needs to set a name
        const player = db.getPlayerBySession(status.sessionToken);
        const needsName = !player || !player.name;

        // Clean up the challenge
        auth.consumeChallenge(k1);

        return res.json({ 
            status: 'complete', 
            needsName,
            player: player ? { id: player.id, name: player.name } : null,
        });
    }

    return res.json({ status: status.status });
});

// Set display name after Lightning auth (for new players)
router.post('/auth/set-name', requirePlayer, (req, res) => {
    const { name } = req.body;
    
    if (!name || name.trim().length < 1) {
        return res.status(400).json({ error: 'Name is required' });
    }
    if (name.trim().length > 30) {
        return res.status(400).json({ error: 'Name must be 30 characters or less' });
    }

    // Check name isn't taken
    const existing = db.getPlayerByName(name.trim());
    if (existing && existing.id !== req.player.id) {
        return res.status(400).json({ error: 'Name already taken. Choose a different name.' });
    }

    db.setPlayerName(req.player.id, name.trim());
    res.json({ success: true, name: name.trim() });
});

// Set/update email (optional, for account recovery)
router.post('/auth/set-email', requirePlayer, (req, res) => {
    const { email } = req.body;
    
    if (email && email.trim()) {
        // Basic email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email.trim())) {
            return res.status(400).json({ error: 'Invalid email address' });
        }
        if (email.trim().length > 255) {
            return res.status(400).json({ error: 'Email too long' });
        }
        db.setPlayerEmail(req.player.id, email.trim());
        res.json({ success: true, email: email.trim() });
    } else {
        // Allow clearing email
        db.setPlayerEmail(req.player.id, null);
        res.json({ success: true, email: null });
    }
});

// ============================================================
// Telegram — Player notification linking
// ============================================================

// Generate a link code for the player to connect their Telegram
router.post('/telegram/link', requirePlayer, (req, res) => {
    if (!telegram.isConfigured()) {
        return res.status(503).json({ error: 'Telegram bot not configured' });
    }
    const { code, deepLink } = telegram.generateLinkCode(req.player.id);
    const botUsername = telegram.getBotUsername();
    
    // Build deep link — botUsername is required for a valid t.me link
    let finalDeepLink = deepLink; // from generateLinkCode (null if botUsername wasn't cached yet)
    if (botUsername) {
        finalDeepLink = `https://t.me/${botUsername}?start=${code}`;
    }
    
    if (!finalDeepLink) {
        return res.status(503).json({ error: 'Telegram bot is still initializing. Please try again in a few seconds.' });
    }
    
    res.json({ 
        code, 
        deepLink: finalDeepLink,
        botUsername 
    });
});

// Check if the player's Telegram is linked
router.get('/telegram/status', requirePlayer, (req, res) => {
    const linked = !!req.player.telegram_chat_id;
    res.json({ 
        linked, 
        configured: telegram.isConfigured(),
        botUsername: telegram.getBotUsername()
    });
});

// Unlink Telegram
router.post('/telegram/unlink', requirePlayer, (req, res) => {
    telegram.unlinkPlayer(req.player.id);
    res.json({ success: true });
});

// ============================================================
// Admin API
// ============================================================

// Helper: get current admin password (DB override takes priority over env var)
function getAdminPassword() {
    const dbPassword = db.getConfig('admin_password_override');
    return dbPassword || process.env.ADMIN_PASSWORD || 'changeme';
}

router.post('/admin/login', (req, res) => {
    const { password } = req.body;
    const adminPassword = getAdminPassword();
    if (password !== adminPassword) {
        return res.status(401).json({ error: 'Invalid admin password' });
    }
    res.cookie('admin_token', adminPassword, { httpOnly: true, maxAge: 10 * 365 * 24 * 60 * 60 * 1000, path: '/' });
    res.json({ success: true });
});

router.post('/admin/crown', requireAdmin, (req, res) => {
    const { playerId } = req.body;
    if (!playerId) return res.status(400).json({ error: 'Player ID required' });
    const result = gameEngine.crownKing(parseInt(playerId));
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

router.post('/admin/start-game', requireAdmin, (req, res) => {
    const result = gameEngine.startGame();
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

router.post('/admin/override-result', requireAdmin, (req, res) => {
    const { gameId, result } = req.body;
    if (!gameId || !result) return res.status(400).json({ error: 'Game ID and result required' });
    const outcome = gameEngine.adminOverrideResult(parseInt(gameId), result);
    if (outcome.error) return res.status(400).json(outcome);
    res.json(outcome);
});

router.post('/admin/remove-challenger', requireAdmin, (req, res) => {
    const outcome = gameEngine.adminRemoveChallenger();
    if (outcome.error) return res.status(400).json(outcome);
    res.json(outcome);
});

// Skip board setup / position verification — admin bypass to show live position on throne
router.post('/admin/skip-setup', requireAdmin, (req, res) => {
    const result = dgtBoard.skipSetupMode();
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

router.post('/admin/undo-game', requireAdmin, (req, res) => {
    const { gameId } = req.body;
    if (!gameId) return res.status(400).json({ error: 'Game ID required' });
    const outcome = gameEngine.adminUndoGame(parseInt(gameId));
    if (outcome.error) return res.status(400).json(outcome);
    res.json(outcome);
});

router.post('/admin/set-challenger', requireAdmin, (req, res) => {
    const { playerId } = req.body;
    if (!playerId) return res.status(400).json({ error: 'Player ID required' });
    const outcome = gameEngine.adminSetChallenger(parseInt(playerId));
    if (outcome.error) return res.status(400).json(outcome);
    res.json(outcome);
});

router.post('/admin/event-active', requireAdmin, (req, res) => {
    const { active } = req.body;
    gameEngine.setEventActive(!!active);
    res.json({ success: true, active: !!active });
});

router.post('/admin/toggle-venue-code', requireAdmin, (req, res) => {
    const current = db.getConfig('show_venue_code') === 'true';
    const newVal = !current;
    db.setConfig('show_venue_code', newVal ? 'true' : 'false');
    gameEngine.broadcast('venue_code_visibility', { showCode: newVal });
    res.json({ success: true, showCode: newVal });
});

router.post('/admin/rotate-venue-code', requireAdmin, (req, res) => {
    const code = gameEngine.rotateVenueCode();
    res.json({ success: true, code });
});

router.get('/admin/venue-code', requireAdmin, (req, res) => {
    const code = db.getActiveVenueCode();
    res.json({ code });
});

router.post('/admin/queue/remove', requireAdmin, (req, res) => {
    const { playerId } = req.body;
    if (!playerId) return res.status(400).json({ error: 'Player ID required' });
    gameEngine.adminRemoveFromQueue(parseInt(playerId));
    res.json({ success: true });
});

router.post('/admin/queue/add', requireAdmin, (req, res) => {
    const { playerId } = req.body;
    if (!playerId) return res.status(400).json({ error: 'Player ID required' });
    const result = gameEngine.adminAddToQueue(parseInt(playerId));
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

router.post('/admin/queue/insert', requireAdmin, (req, res) => {
    const { playerId, position } = req.body;
    if (!playerId) return res.status(400).json({ error: 'Player ID required' });
    if (!position || position < 1) return res.status(400).json({ error: 'Valid position required (1+)' });
    const result = gameEngine.adminInsertIntoQueue(parseInt(playerId), parseInt(position));
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

router.post('/admin/reorder', requireAdmin, async (req, res) => {
    const { order } = req.body;
    if (!order || !Array.isArray(order) || order.length === 0) {
        return res.status(400).json({ error: 'order array of player IDs is required' });
    }
    const result = await gameEngine.adminReorder(order.map(id => parseInt(id)));
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

router.get('/admin/notifications', requireAdmin, (req, res) => {
    res.json({ notifications: db.getUnresolvedNotifications() });
});

router.post('/admin/rename-player', requireAdmin, (req, res) => {
    const { playerId, name } = req.body;
    if (!playerId || !name || !name.trim()) {
        return res.status(400).json({ error: 'Player ID and name are required' });
    }
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 30) {
        return res.status(400).json({ error: 'Name must be 1-30 characters' });
    }
    db.setPlayerName(playerId, trimmed);
    res.json({ success: true, name: trimmed });
});

router.post('/admin/manual-payout', requireAdmin, (req, res) => {
    const { playerId } = req.body;
    if (!playerId) return res.status(400).json({ error: 'Player ID required' });
    const player = db.getPlayerById(parseInt(playerId));
    if (!player) return res.status(404).json({ error: 'Player not found' });
    const amount = player.sat_balance;
    if (amount <= 0) return res.status(400).json({ error: 'No balance to zero' });
    // Deduct balance and mark as claimed
    db.deductSatsFromPlayer(player.id, amount);
    // Record a completed payout entry
    const payoutId = db.createPayout(player.id, amount, 'manual-admin-payout');
    db.updatePayout(payoutId, { status: 'completed', completed_at: new Date().toISOString() });
    res.json({ success: true, amount, playerName: player.name });
});

router.post('/admin/notifications/resolve-all', requireAdmin, (req, res) => {
    db.resolveAllNotifications();
    res.json({ success: true });
});

router.post('/admin/notifications/resolve', requireAdmin, (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Notification ID required' });
    db.resolveNotification(parseInt(id));
    res.json({ success: true });
});

router.get('/admin/config', requireAdmin, (req, res) => {
    res.json({ config: db.getAllConfig() });
});

router.post('/admin/config', requireAdmin, (req, res) => {
    const { key, value } = req.body;
    if (!key || value === undefined) return res.status(400).json({ error: 'Key and value required' });
    db.setConfig(key, value);
    res.json({ success: true });
});

// Merge two player accounts (for locked-out players who created a new account)
router.post('/admin/merge-accounts', requireAdmin, (req, res) => {
    const { targetPlayerId, sourcePlayerId } = req.body;
    if (!targetPlayerId || !sourcePlayerId) {
        return res.status(400).json({ error: 'Both targetPlayerId and sourcePlayerId required' });
    }
    try {
        const result = db.mergeAccounts(parseInt(targetPlayerId), parseInt(sourcePlayerId));
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.get('/admin/players', requireAdmin, (req, res) => {
    res.json({ players: db.getAllPlayers() });
});

router.get('/admin/payouts', requireAdmin, (req, res) => {
    res.json({ payouts: db.getAllPayouts() });
});

// Reconcile stuck payouts — checks LND for actual payment status
// Handles both pending payouts AND previously-wrongly-marked-failed payouts
// Download database backup
router.get('/admin/backup', requireAdmin, (req, res) => {
    const buffer = db.getExportBuffer();
    if (!buffer) return res.status(500).json({ error: 'Database not initialized' });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    res.set({
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="throne-backup-${timestamp}.db"`,
        'Content-Length': buffer.length,
    });
    res.send(buffer);
});

router.post('/admin/reconcile-payouts', requireAdmin, async (req, res) => {
    // Helper: normalize a payment hash to hex (handles both base64 and hex formats from LND)
    function normalizeHash(hash) {
        if (!hash) return null;
        // If it's already hex (64 chars, only hex chars), return as-is
        if (/^[0-9a-f]{64}$/i.test(hash)) return hash.toLowerCase();
        // Otherwise assume base64 — decode to hex
        try {
            return Buffer.from(hash, 'base64').toString('hex').toLowerCase();
        } catch {
            return hash.toLowerCase();
        }
    }

    // Phase 1: Check pending/paying payouts (original behavior)
    const pending = db.getPendingPayouts();
    const wronglyFailed = db.getReconciledFailedPayouts();
    const allPendingToCheck = [...pending, ...wronglyFailed];

    // Phase 2: Deep-verify ALL "completed" payouts against LND
    // This catches the bug where payInvoice returned HTTP 200 but payment actually failed
    const completedPayouts = db.getCompletedPayouts();

    const totalToCheck = allPendingToCheck.length + completedPayouts.length;
    if (totalToCheck === 0) {
        return res.json({ success: true, message: 'No payouts to reconcile.' });
    }

    let markedCompleted = 0;
    let markedFailed = 0;
    let reversed = 0;
    const details = [];

    try {
        // Fetch ALL payments from LND to cross-reference
        const lndPayments = await lightning.listPayments(500);
        const succeededPayments = lndPayments.filter(p => p.status === 'SUCCEEDED');
        
        // Build lookup maps for efficient matching
        const lndByHash = new Map();
        for (const p of lndPayments) {
            const normalized = normalizeHash(p.payment_hash);
            lndByHash.set(normalized, p);
            // Also store original in case DB has exact match
            if (p.payment_hash !== normalized) lndByHash.set(p.payment_hash, p);
        }
        
        // Track which LND payments we've already matched (prevent double-matching)
        const usedPaymentHashes = new Set();
        
        // --- Phase 1: Reconcile pending/failed payouts (find matching LND successes) ---
        for (const payout of allPendingToCheck) {
            const payoutTime = new Date(payout.created_at + 'Z').getTime() / 1000;
            const matchWindow = 300; // ±5 minutes
            
            const match = succeededPayments.find(lndPay => {
                if (usedPaymentHashes.has(lndPay.payment_hash)) return false;
                const lndAmount = parseInt(lndPay.value_sat || lndPay.value || '0');
                const lndTime = parseInt(lndPay.creation_date || '0');
                return lndAmount === payout.amount_sats && 
                       Math.abs(lndTime - payoutTime) < matchWindow;
            });

            if (match) {
                usedPaymentHashes.add(match.payment_hash);
                const wasAlreadyFailed = payout.status === 'failed';
                
                db.updatePayout(payout.id, {
                    payment_hash: match.payment_hash,
                    status: 'completed',
                    completed_at: new Date().toISOString(),
                    error_message: null
                });
                
                if (wasAlreadyFailed || payout.status === 'pending' || payout.status === 'paying') {
                    db.deductSatsFromPlayer(payout.player_id, payout.amount_sats);
                }
                
                markedCompleted++;
                const label = wasAlreadyFailed ? '🔄 FIXED' : '✅ COMPLETED';
                details.push(`${label} Payout #${payout.id}: ${payout.amount_sats} sats to ${payout.player_name} (LND: ${match.payment_hash.substring(0, 16)}...)`);
            } else if (payout.status !== 'failed') {
                db.updatePayout(payout.id, {
                    status: 'failed',
                    error_message: 'Reconciled: no matching successful LND payment found'
                });
                markedFailed++;
                details.push(`❌ Payout #${payout.id}: ${payout.amount_sats} sats to ${payout.player_name} → FAILED (no matching LND payment)`);
            }
        }

        // --- Phase 2: Deep-verify "completed" payouts against LND ---
        // For each payout marked "completed", verify that LND actually has a SUCCEEDED payment
        for (const payout of completedPayouts) {
            // Method 1: Check by payment_hash if we have one
            if (payout.payment_hash) {
                // Normalize: DB may store base64 (from sendpayment) while listPayments returns hex
                const normalizedDbHash = normalizeHash(payout.payment_hash);
                const lndPay = lndByHash.get(normalizedDbHash) || lndByHash.get(payout.payment_hash);
                if (lndPay && lndPay.status === 'SUCCEEDED') {
                    continue; // Genuinely completed — all good
                }
                if (lndPay && lndPay.status === 'FAILED') {
                    // LND says this payment FAILED but our DB says "completed"!
                    db.refundPayout(payout.id, payout.amount_sats, payout.player_id,
                        `Reversed: LND payment FAILED (${lndPay.failure_reason || 'unknown'}), hash=${normalizedDbHash.substring(0, 16)}...`);
                    reversed++;
                    details.push(`🔄 REVERSED Payout #${payout.id}: ${payout.amount_sats} sats to ${payout.player_name} — LND says FAILED (${lndPay.failure_reason || 'unknown'}). Balance restored.`);
                    console.log(`🔧 ${details[details.length - 1]}`);
                    continue;
                }
                // If payment_hash not found in LND at all, it might be very old or pruned
                // Don't reverse these — only reverse confirmed FAILED ones
                if (!lndPay) {
                    details.push(`⚠️ Payout #${payout.id}: ${payout.amount_sats} sats to ${payout.player_name} — payment_hash ${normalizedDbHash.substring(0, 16)}... not found in LND. Left as-is.`);
                    continue;
                }
            }

            // Method 2: No payment_hash — match by amount + timestamp
            if (!payout.payment_hash) {
                const payoutTime = new Date(payout.created_at + 'Z').getTime() / 1000;
                const matchWindow = 300;
                
                // Check if there's a FAILED payment matching this amount/time
                const failedMatch = lndPayments.find(lndPay => {
                    if (lndPay.status !== 'FAILED') return false;
                    const lndAmount = parseInt(lndPay.value_sat || lndPay.value || '0');
                    const lndTime = parseInt(lndPay.creation_date || '0');
                    return lndAmount === payout.amount_sats && Math.abs(lndTime - payoutTime) < matchWindow;
                });

                if (failedMatch) {
                    db.refundPayout(payout.id, payout.amount_sats, payout.player_id,
                        `Reversed: matched LND FAILED payment (${failedMatch.failure_reason || 'unknown'}), no payment_hash was stored`);
                    reversed++;
                    details.push(`🔄 REVERSED Payout #${payout.id}: ${payout.amount_sats} sats to ${payout.player_name} — matched FAILED LND payment (${failedMatch.failure_reason || 'unknown'}). Balance restored.`);
                    console.log(`🔧 ${details[details.length - 1]}`);
                    continue;
                }

                // Check for a succeeded match
                const successMatch = succeededPayments.find(lndPay => {
                    if (usedPaymentHashes.has(lndPay.payment_hash)) return false;
                    const lndAmount = parseInt(lndPay.value_sat || lndPay.value || '0');
                    const lndTime = parseInt(lndPay.creation_date || '0');
                    return lndAmount === payout.amount_sats && Math.abs(lndTime - payoutTime) < matchWindow;
                });

                if (successMatch) {
                    usedPaymentHashes.add(successMatch.payment_hash);
                    // Update the missing payment_hash
                    db.updatePayout(payout.id, { payment_hash: successMatch.payment_hash });
                    continue; // Genuinely completed
                }

                details.push(`⚠️ Payout #${payout.id}: ${payout.amount_sats} sats to ${payout.player_name} — no payment_hash and no LND match. Left as-is.`);
            }
        }
    } catch (err) {
        console.error('🔧 Reconcile error — could not reach LND:', err.message);
        return res.status(502).json({
            success: false,
            error: `Could not reach LND to verify payments: ${err.message}`,
            message: 'Reconciliation aborted — no payouts were changed.'
        });
    }

    for (const d of details) {
        console.log(`🔧 ${d}`);
    }

    const message = `Reconciled: ${markedCompleted} newly completed, ${markedFailed} failed, ${reversed} REVERSED (balance restored). Checked ${allPendingToCheck.length} pending + ${completedPayouts.length} completed payouts.`;
    res.json({
        success: true,
        totalChecked: totalToCheck,
        pendingChecked: allPendingToCheck.length,
        completedVerified: completedPayouts.length,
        markedCompleted,
        markedFailed,
        reversed,
        details,
        message
    });
});

// Immediate Reset
router.post('/admin/immediate-reset', requireAdmin, (req, res) => {
    const { password } = req.body;
    const adminPassword = getAdminPassword();
    if (password !== adminPassword) {
        return res.status(403).json({ error: 'Invalid password' });
    }
    const result = gameEngine.immediateReset();
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

// Change Admin Password
router.post('/admin/change-password', requireAdmin, (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'Current and new password required' });
    }
    if (newPassword.length < 4) {
        return res.status(400).json({ error: 'New password must be at least 4 characters' });
    }
    const adminPassword = getAdminPassword();
    if (currentPassword !== adminPassword) {
        return res.status(403).json({ error: 'Current password is incorrect' });
    }
    // Store the new password as a DB config override
    db.setConfig('admin_password_override', newPassword);
    // Update the admin cookie to the new password so they stay logged in
    res.cookie('admin_token', newPassword, { httpOnly: true, maxAge: 10 * 365 * 24 * 60 * 60 * 1000, path: '/' });
    res.json({ success: true, message: 'Admin password changed successfully' });
});

// Scheduled Reset
router.post('/admin/schedule-reset', requireAdmin, (req, res) => {
    const { resetAt, password } = req.body;
    // Double-check password for this high-security action
    const adminPassword = getAdminPassword();
    if (password !== adminPassword) {
        return res.status(403).json({ error: 'Password required to schedule a reset' });
    }
    if (!resetAt) return res.status(400).json({ error: 'resetAt (ISO datetime) required' });
    const result = gameEngine.scheduleReset(resetAt);
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

router.post('/admin/cancel-reset', requireAdmin, (req, res) => {
    const result = gameEngine.cancelReset();
    res.json(result);
});

router.get('/admin/scheduled-reset', requireAdmin, (req, res) => {
    const reset = gameEngine.getScheduledReset();
    res.json({ reset });
});

router.get('/admin/accounting', requireAdmin, (req, res) => {
    // Flush accumulated sats to DB so audit compares fresh values (not up to 10s stale)
    gameEngine.flushAccumulatedSats();
    const satRate = parseInt(db.getConfig('sat_rate_per_second') || '21');
    const audit = db.getAccountingAudit(satRate);
    res.json(audit);
});

// Public Venue QR Image (no auth — used by throne display page)
router.get('/venue-qr.png', async (req, res) => {
    const code = db.getActiveVenueCode();
    if (!code) return res.status(404).send('No active venue code');
    
    const baseUrl = process.env.BASE_URL || 'http://localhost:3960';
    const joinUrl = `${baseUrl}/join?code=${code.code}`;
    
    const pngBuffer = await QRCode.toBuffer(joinUrl, {
        width: 600,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
    });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-cache');
    res.send(pngBuffer);
});

// Venue Code QR Image (admin, with JSON option)
router.get('/admin/venue-qr', requireAdmin, async (req, res) => {
    const code = db.getActiveVenueCode();
    if (!code) return res.status(404).json({ error: 'No active venue code' });
    
    const baseUrl = process.env.BASE_URL || 'http://localhost:3960';
    const joinUrl = `${baseUrl}/join?code=${code.code}`;
    
    const format = req.query.format || 'json';
    
    if (format === 'png') {
        // Return raw PNG image
        const pngBuffer = await QRCode.toBuffer(joinUrl, {
            width: 600,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' },
        });
        res.set('Content-Type', 'image/png');
        return res.send(pngBuffer);
    }
    
    // Return data URL + metadata
    const qrDataUrl = await QRCode.toDataURL(joinUrl, {
        width: 600,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
    });
    
    res.json({ 
        code: code.code,
        url: joinUrl,
        qr: qrDataUrl,
        expiresAt: code.expires_at
    });
});

// ============================================================
// Bitcoin Chess960 Position
// ============================================================

router.get('/bitcoin-position', async (req, res) => {
    try {
        const btcPos = await chess960.fetchBitcoinPosition();
        res.json(btcPos);
    } catch (err) {
        console.error('Bitcoin position fetch error:', err.message);
        res.status(502).json({ error: 'Failed to fetch Bitcoin block data' });
    }
});

// Round Position — for the /position page. Returns the current Bitcoin-derived
// Chess960 position. Server-side lock: caches the position when the lock window
// starts (5 min before round) and returns that cached position until the round begins.
const ROUND_SCHEDULE = [
    { name: 'Round 1', utcMs: Date.UTC(2026, 2, 16, 20, 0) },  // Mar 16 2:00 PM CST = 20:00 UTC
    { name: 'Round 2', utcMs: Date.UTC(2026, 2, 16, 21, 30) },  // Mar 16 3:30 PM CST
    { name: 'Round 3', utcMs: Date.UTC(2026, 2, 16, 23, 0) },   // Mar 16 5:00 PM CST
    { name: 'Round 4', utcMs: Date.UTC(2026, 2, 17, 0, 30) },   // Mar 16 6:30 PM CST
    { name: 'Round 5', utcMs: Date.UTC(2026, 2, 17, 15, 0) },   // Mar 17 9:00 AM CST
    { name: 'Round 6', utcMs: Date.UTC(2026, 2, 17, 16, 30) },  // Mar 17 10:30 AM CST
    { name: 'Round 7', utcMs: Date.UTC(2026, 2, 17, 20, 0) },   // Mar 17 2:00 PM CST
    { name: 'Round 8', utcMs: Date.UTC(2026, 2, 17, 21, 30) },  // Mar 17 3:30 PM CST
    { name: 'Round 9', utcMs: Date.UTC(2026, 2, 17, 23, 0) },   // Mar 17 5:00 PM CST
];
const ROUND_LOCK_MS = 10 * 60 * 1000; // 10 minutes before round
let _lockedRoundPosition = null; // { roundName, data }

router.get('/round-position', async (req, res) => {
    try {
        const now = Date.now();

        // Determine which round we're locked for.
        // Lock starts 10 min before each round and stays locked until 10 min before the NEXT round.
        // This means once locked for Round N, the position stays visible until Round N+1's lock begins.
        let lockedForRound = null;
        for (let i = 0; i < ROUND_SCHEDULE.length; i++) {
            const round = ROUND_SCHEDULE[i];
            const lockStart = round.utcMs - ROUND_LOCK_MS;
            // Lock ends when the next round's lock starts, or never if this is the last round
            const nextLockStart = (i + 1 < ROUND_SCHEDULE.length)
                ? ROUND_SCHEDULE[i + 1].utcMs - ROUND_LOCK_MS
                : Infinity;
            if (now >= lockStart && now < nextLockStart) {
                lockedForRound = round;
                break;
            }
        }

        // If locked and we already have a cached position for this round, return it
        if (lockedForRound && _lockedRoundPosition && _lockedRoundPosition.roundName === lockedForRound.name) {
            return res.json(_lockedRoundPosition.data);
        }

        // Fetch current bitcoin block
        const hashRes = await fetch('https://mempool.space/api/blocks/tip/hash');
        if (!hashRes.ok) throw new Error('Failed to fetch block hash');
        const blockHash = await hashRes.text();

        const blockRes = await fetch(`https://mempool.space/api/block/${blockHash}`);
        if (!blockRes.ok) throw new Error('Failed to fetch block details');
        const blockData = await blockRes.json();

        const positionNumber = chess960.stringToPositionNumber(blockHash);
        const pieces = chess960.positionFromNumber(positionNumber);

        const data = {
            positionNumber,
            pieces,
            backRank: pieces.join(''),
            blockHeight: blockData.height,
            blockHash,
            locked: !!lockedForRound,
            lockedForRound: lockedForRound ? lockedForRound.name : null,
        };

        // If entering lock window, cache this position
        if (lockedForRound) {
            _lockedRoundPosition = { roundName: lockedForRound.name, data };
        } else {
            // Clear lock cache when not in any lock window
            _lockedRoundPosition = null;
        }

        res.json(data);
    } catch (err) {
        console.error('Round position fetch error:', err.message);
        res.status(502).json({ error: 'Failed to fetch Bitcoin block data' });
    }
});

// ============================================================
// Admin — Lightning
// ============================================================

router.get('/admin/lightning-status', requireAdmin, async (req, res) => {
    const status = await lightning.isConfigured();
    if (status.configured) {
        try {
            const channelBal = await lightning.getChannelBalance();
            const walletBal = await lightning.getWalletBalance();
            status.channelBalance = channelBal;
            status.walletBalance = walletBal;
        } catch (e) {
            status.balanceError = e.message;
        }
    }
    res.json(status);
});

// Get a Bitcoin deposit address for the LND node (with QR)
router.get('/admin/lightning-address', requireAdmin, async (req, res) => {
    try {
        const address = await lightning.getNewAddress();
        const qr = await QRCode.toDataURL(`bitcoin:${address}`, { width: 300, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
        res.json({ address, qr });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// List channels
router.get('/admin/channels', requireAdmin, async (req, res) => {
    try {
        const channels = await lightning.listChannels();
        const pending = await lightning.listPendingChannels();
        res.json({ channels, pending });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Open a channel (moves on-chain sats into a Lightning channel)
router.post('/admin/open-channel', requireAdmin, async (req, res) => {
    const { peer, amount } = req.body;
    if (!peer || !amount) {
        return res.status(400).json({ error: 'Peer (pubkey@host:port) and amount (sats) required' });
    }
    const amountSats = parseInt(amount);
    if (amountSats < 20000) {
        return res.status(400).json({ error: 'Minimum channel size is 20,000 sats' });
    }

    // Parse peer string: pubkey@host:port
    const atIdx = peer.indexOf('@');
    if (atIdx === -1) {
        return res.status(400).json({ error: 'Peer must be in format pubkey@host:port' });
    }
    const pubkey = peer.substring(0, atIdx);
    const host = peer.substring(atIdx + 1);

    try {
        // Connect to the peer first (ignore "already connected" errors)
        try {
            await lightning.connectPeer(pubkey, host);
        } catch (connectErr) {
            if (!connectErr.message.includes('already connected')) {
                throw new Error(`Could not connect to peer: ${connectErr.message}`);
            }
        }

        // Open the channel
        const result = await lightning.openChannel(pubkey, amountSats);
        const txid = result.funding_txid_str || result.funding_txid_bytes || null;
        console.log('⚡ Channel open result:', JSON.stringify(result));
        res.json({
            success: true,
            message: txid 
                ? `Channel opening initiated! ${amountSats.toLocaleString()} sats. Funding txid: ${txid}. Needs 3 on-chain confirmations (~30 min).`
                : `Channel open request sent (${amountSats.toLocaleString()} sats). LND response: ${JSON.stringify(result).substring(0, 200)}`,
            fundingTxid: txid,
            rawResponse: result,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create a Lightning invoice to receive sats (with QR)
router.post('/admin/lightning-invoice', requireAdmin, async (req, res) => {
    const { amount, memo } = req.body;
    if (!amount || parseInt(amount) <= 0) {
        return res.status(400).json({ error: 'Amount in sats required' });
    }
    try {
        const invoice = await lightning.createInvoice(parseInt(amount), memo || '960 Throne node top-up');
        const qr = await QRCode.toDataURL(invoice.paymentRequest, { width: 300, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
        invoice.qr = qr;
        res.json(invoice);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// DGT Board (Direct Relay)
// ============================================================

const dgtBoard = require('../services/dgtBoard');

// Get DGT board state (public — for live views)
router.get('/dgt/state', (req, res) => {
    res.json(dgtBoard.getState());
});

// Push board state from relay script (direct board reading)
// Accepts FEN or raw board array + optional clock. Authenticated with relay secret.
router.post('/dgt/board-state', (req, res) => {
    // Auth: relay secret or admin token
    const secret = process.env.DGT_RELAY_SECRET || process.env.ADMIN_PASSWORD || 'changeme';
    const provided = req.headers['x-relay-secret'] || req.headers['x-admin-token'];
    if (provided !== secret) {
        return res.status(401).json({ error: 'Invalid relay secret' });
    }
    
    const result = dgtBoard.setBoardState(req.body);
    if (result.error) {
        return res.status(400).json(result);
    }
    res.json(result);
});

// ============================================================
// Board Names — for multi-board stream viewer
// ============================================================

// Get all board names (public — stream pages need this)
router.get('/board-names', (req, res) => {
    res.json({ boards: db.getAllBoardNames() });
});

// Get single board name (public)
router.get('/board-names/:boardNum', (req, res) => {
    const names = db.getBoardNames(parseInt(req.params.boardNum));
    res.json(names || { board_num: parseInt(req.params.boardNum), white_name: '', black_name: '' });
});

// Set board names (admin or board viewer password)
function requireBoardAccess(req, res, next) {
    const boardPw = process.env.BOARD_PASSWORD || 'MarioWins';
    if (req.cookies?.board_token === boardPw) return next();
    return requireAdmin(req, res, next);
}

router.post('/board-names/:boardNum', requireBoardAccess, (req, res) => {
    const boardNum = parseInt(req.params.boardNum);
    const { white_name, black_name, serial_nr } = req.body;
    db.setBoardNames(boardNum, white_name || '', black_name || '', serial_nr || '');
    res.json({ success: true });
});

// Clear all board names (admin only)
router.post('/board-names-clear', requireAdmin, (req, res) => {
    db.clearAllBoardNames();
    res.json({ success: true });
});

// Board order — custom serial → position mapping
router.get('/board-order', (req, res) => {
    res.json({ order: db.getBoardOrder() });
});

router.post('/board-order', requireBoardAccess, (req, res) => {
    const { serials } = req.body;
    if (!serials || !Array.isArray(serials)) {
        return res.status(400).json({ error: 'serials array required' });
    }
    db.saveBoardOrder(serials);
    res.json({ success: true });
});

// Autocomplete player names from history
router.get('/board-names/autocomplete/:query', (req, res) => {
    const names = db.searchNameHistory(req.params.query);
    res.json({ names });
});

// ============================================================
// Multi-board DGT endpoints — for stream display of multiple boards
// ============================================================

// List all active boards
router.get('/dgt/boards', (req, res) => {
    const boards = dgtBoard.getAllMultiBoardStates();
    res.json({ boards });
});

// Get a specific board's state
router.get('/dgt/boards/:boardId', (req, res) => {
    const state = dgtBoard.getMultiBoardState(req.params.boardId);
    if (!state) return res.status(404).json({ error: 'Board not found' });
    res.json(state);
});

// Push board state for a specific board (from multi-board relay OR browser viewer)
router.post('/dgt/boards/:boardId/state', (req, res) => {
    // Auth: relay secret, admin token, OR board viewer cookie
    const secret = process.env.DGT_RELAY_SECRET || process.env.ADMIN_PASSWORD || 'changeme';
    const boardPw = process.env.BOARD_PASSWORD || 'MarioWins';
    const provided = req.headers['x-relay-secret'] || req.headers['x-admin-token'];
    const hasBoardCookie = req.cookies?.board_token === boardPw;
    const hasAdminCookie = req.cookies?.admin_token === (db.getConfig('admin_password_override') || process.env.ADMIN_PASSWORD || 'changeme');
    if (provided !== secret && !hasBoardCookie && !hasAdminCookie) {
        return res.status(401).json({ error: 'Invalid relay secret' });
    }

    const result = dgtBoard.setMultiBoardState(req.params.boardId, req.body);
    if (result.error) {
        return res.status(400).json(result);
    }
    res.json(result);
});

module.exports = router;
