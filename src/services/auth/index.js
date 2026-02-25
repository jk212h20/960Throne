/**
 * Auth Manager — Extensible authentication system
 * 
 * Supports multiple auth strategies (lightning, future: nostr, email, etc.)
 * Each strategy must implement:
 *   - generateChallenge() → { k1, encodedUrl, rawUrl }
 *   - verifyCallback(params) → { success, authId, error }
 *   - getType() → string (e.g., 'lightning')
 */

const LightningAuth = require('./lightning');

// Registry of auth strategies
const strategies = {
    lightning: new LightningAuth(),
    // Future: nostr: new NostrAuth(),
    // Future: email: new EmailAuth(),
};

// In-memory store for pending auth challenges
// Map<k1, { strategy, createdAt, authId?, sessionToken?, status }>
const pendingChallenges = new Map();

// Clean up expired challenges every 5 minutes
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [k1, challenge] of pendingChallenges) {
        if (now - challenge.createdAt > CHALLENGE_TTL_MS) {
            pendingChallenges.delete(k1);
        }
    }
}, 60 * 1000);

/**
 * Get a strategy by name
 */
function getStrategy(name) {
    return strategies[name] || null;
}

/**
 * List available auth strategies
 */
function getAvailableStrategies() {
    return Object.keys(strategies);
}

/**
 * Create a new auth challenge for a given strategy
 */
function createChallenge(strategyName) {
    const strategy = strategies[strategyName];
    if (!strategy) {
        throw new Error(`Unknown auth strategy: ${strategyName}`);
    }

    const challenge = strategy.generateChallenge();
    
    pendingChallenges.set(challenge.k1, {
        strategy: strategyName,
        createdAt: Date.now(),
        status: 'pending',
        authId: null,
        sessionToken: null,
    });

    return challenge;
}

/**
 * Process a callback from a wallet/auth provider
 */
function processCallback(k1, params) {
    const pending = pendingChallenges.get(k1);
    if (!pending) {
        return { success: false, error: 'Challenge expired or not found' };
    }

    if (pending.status !== 'pending') {
        return { success: false, error: 'Challenge already completed' };
    }

    const strategy = strategies[pending.strategy];
    const result = strategy.verifyCallback(k1, params);

    if (result.success) {
        pending.status = 'verified';
        pending.authId = result.authId;
    } else {
        pending.status = 'failed';
    }

    return result;
}

/**
 * Get the status of a pending challenge
 */
function getChallengeStatus(k1) {
    const pending = pendingChallenges.get(k1);
    if (!pending) {
        return { status: 'expired' };
    }
    return {
        status: pending.status,
        authId: pending.authId,
        strategy: pending.strategy,
        sessionToken: pending.sessionToken,
    };
}

/**
 * Mark a challenge as fully completed (session created)
 */
function completeChallenge(k1, sessionToken) {
    const pending = pendingChallenges.get(k1);
    if (pending) {
        pending.status = 'complete';
        pending.sessionToken = sessionToken;
    }
}

/**
 * Clean up a challenge after it's been consumed
 */
function consumeChallenge(k1) {
    pendingChallenges.delete(k1);
}

module.exports = {
    getStrategy,
    getAvailableStrategies,
    createChallenge,
    processCallback,
    getChallengeStatus,
    completeChallenge,
    consumeChallenge,
};
