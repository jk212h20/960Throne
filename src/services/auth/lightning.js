/**
 * Lightning Auth Strategy — LNURL-auth
 * 
 * Implements the LNURL-auth protocol (LUD-04):
 * https://github.com/lnurl/luds/blob/luds/04.md
 * 
 * Flow:
 * 1. Server generates a random k1 challenge
 * 2. Encodes callback URL as LNURL (bech32)
 * 3. User scans QR with Lightning wallet
 * 4. Wallet derives a linking key for this domain
 * 5. Wallet signs k1 with the linking key
 * 6. Wallet hits callback with sig + key
 * 7. Server verifies signature → user authenticated by their linking key (pubkey)
 */

const crypto = require('crypto');
const secp256k1 = require('secp256k1');

// Bech32 encoding for LNURL
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32Polymod(values) {
    const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const v of values) {
        const b = chk >> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ v;
        for (let i = 0; i < 5; i++) {
            if ((b >> i) & 1) chk ^= GEN[i];
        }
    }
    return chk;
}

function bech32HrpExpand(hrp) {
    const ret = [];
    for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5);
    ret.push(0);
    for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
    return ret;
}

function bech32CreateChecksum(hrp, data) {
    const values = bech32HrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
    const polymod = bech32Polymod(values) ^ 1;
    const ret = [];
    for (let i = 0; i < 6; i++) ret.push((polymod >> (5 * (5 - i))) & 31);
    return ret;
}

function bech32Encode(hrp, data) {
    const combined = data.concat(bech32CreateChecksum(hrp, data));
    let ret = hrp + '1';
    for (const d of combined) ret += CHARSET[d];
    return ret;
}

function convertBits(data, fromBits, toBits, pad) {
    let acc = 0;
    let bits = 0;
    const ret = [];
    const maxv = (1 << toBits) - 1;
    for (const value of data) {
        acc = (acc << fromBits) | value;
        bits += fromBits;
        while (bits >= toBits) {
            bits -= toBits;
            ret.push((acc >> bits) & maxv);
        }
    }
    if (pad) {
        if (bits > 0) ret.push((acc << (toBits - bits)) & maxv);
    }
    return ret;
}

/**
 * Encode a URL as LNURL (bech32 with hrp "lnurl")
 */
function encodeLnurl(url) {
    const urlBytes = Buffer.from(url, 'utf8');
    const data = convertBits(Array.from(urlBytes), 8, 5, true);
    return bech32Encode('lnurl', data).toUpperCase();
}

class LightningAuth {
    getType() {
        return 'lightning';
    }

    /**
     * Generate a new LNURL-auth challenge
     * Returns { k1, encodedUrl, rawUrl }
     */
    generateChallenge() {
        const k1 = crypto.randomBytes(32).toString('hex');
        const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
        const rawUrl = `${baseUrl}/api/auth/lightning/callback?tag=login&k1=${k1}&action=login`;
        const encodedUrl = encodeLnurl(rawUrl);

        return {
            k1,
            encodedUrl,
            rawUrl,
            // lightning: URI for deep linking on mobile
            deepLink: `lightning:${encodedUrl}`,
        };
    }

    /**
     * Verify a callback from a Lightning wallet
     * Params: { sig, key } (hex-encoded)
     * Returns { success, authId, error }
     */
    verifyCallback(k1, params) {
        const { sig, key } = params;

        if (!sig || !key) {
            return { success: false, error: 'Missing sig or key parameter' };
        }

        try {
            // Convert hex strings to buffers
            const k1Buffer = Buffer.from(k1, 'hex');
            const sigBuffer = Buffer.from(sig, 'hex');
            const keyBuffer = Buffer.from(key, 'hex');

            // Validate key is a valid public key
            if (!secp256k1.publicKeyVerify(keyBuffer)) {
                return { success: false, error: 'Invalid public key' };
            }

            // Parse DER signature to compact format for secp256k1
            const sigCompact = secp256k1.signatureImport(sigBuffer);

            // Verify: the wallet signed the k1 challenge with their linking key
            const valid = secp256k1.ecdsaVerify(sigCompact, k1Buffer, keyBuffer);

            if (!valid) {
                return { success: false, error: 'Invalid signature' };
            }

            // The linking key (public key hex) is the unique auth identifier
            return {
                success: true,
                authId: key,
            };
        } catch (err) {
            console.error('LNURL-auth verification error:', err.message);
            return { success: false, error: `Verification failed: ${err.message}` };
        }
    }
}

module.exports = LightningAuth;
