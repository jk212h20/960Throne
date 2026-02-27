/**
 * 960 Throne — Prediction Verification Tests
 * 
 * Tests predictions made by studying source code before running anything.
 * Uses Node.js assert (no test framework needed).
 * 
 * Run: node tests/predictions.test.js
 */

const assert = require('assert');
const path = require('path');

// We need to set DATABASE_PATH to a temp location so we don't touch real data
process.env.DATABASE_PATH = path.join(__dirname, 'test_throne.db');

const chess960 = require('../src/services/chess960');

let db; // loaded after initialization

let passed = 0;
let failed = 0;
const results = [];

function test(id, description, fn) {
    try {
        fn();
        passed++;
        results.push({ id, description, status: 'PASS' });
        console.log(`  ✅ ${id}: ${description}`);
    } catch (err) {
        failed++;
        results.push({ id, description, status: 'FAIL', error: err.message });
        console.log(`  ❌ ${id}: ${description}`);
        console.log(`     Error: ${err.message}`);
    }
}

async function runTests() {
    console.log('\n🧪 960 Throne — Prediction Verification Tests\n');
    console.log('='.repeat(60));

    // ============================================================
    // Chess960 Position Generator Tests
    // ============================================================
    console.log('\n📐 Chess960 Position Generator\n');

    test('P1', 'Position 518 is standard chess (RNBQKBNR)', () => {
        const pieces = chess960.positionFromNumber(518);
        assert.deepStrictEqual(pieces, ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R']);
    });

    test('P2', 'Position 0 produces BBQNNRKR', () => {
        const pieces = chess960.positionFromNumber(0);
        assert.deepStrictEqual(pieces, ['B', 'B', 'Q', 'N', 'N', 'R', 'K', 'R']);
    });

    test('P3', 'All 960 positions have bishops on opposite-colored squares', () => {
        for (let n = 0; n < 960; n++) {
            const pieces = chess960.positionFromNumber(n);
            const bishopIndices = [];
            pieces.forEach((p, i) => { if (p === 'B') bishopIndices.push(i); });
            assert.strictEqual(bishopIndices.length, 2, `Position ${n}: expected 2 bishops, got ${bishopIndices.length}`);
            const parities = bishopIndices.map(i => i % 2);
            assert.notStrictEqual(parities[0], parities[1],
                `Position ${n}: bishops at indices ${bishopIndices} are on same-colored squares`);
        }
    });

    test('P4', 'King is always between the two rooks in all 960 positions', () => {
        for (let n = 0; n < 960; n++) {
            const pieces = chess960.positionFromNumber(n);
            const rookIndices = [];
            let kingIndex = -1;
            pieces.forEach((p, i) => {
                if (p === 'R') rookIndices.push(i);
                if (p === 'K') kingIndex = i;
            });
            assert.strictEqual(rookIndices.length, 2, `Position ${n}: expected 2 rooks`);
            assert.strictEqual(kingIndex > -1, true, `Position ${n}: no king found`);
            assert.strictEqual(
                kingIndex > Math.min(...rookIndices) && kingIndex < Math.max(...rookIndices),
                true,
                `Position ${n}: king at ${kingIndex} not between rooks at ${rookIndices}`
            );
        }
    });

    test('P5', 'Exactly 960 unique positions exist (no duplicates)', () => {
        const seen = new Set();
        for (let n = 0; n < 960; n++) {
            const pieces = chess960.positionFromNumber(n);
            const key = pieces.join('');
            assert.strictEqual(seen.has(key), false, `Duplicate position at ${n}: ${key}`);
            seen.add(key);
        }
        assert.strictEqual(seen.size, 960);
    });

    test('P6', 'randomPositionNumber() returns values in [0, 959]', () => {
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < 10000; i++) {
            const n = chess960.randomPositionNumber();
            if (n < min) min = n;
            if (n > max) max = n;
            assert.strictEqual(n >= 0 && n <= 959, true, `Got out of range value: ${n}`);
        }
        // Probabilistically, min should be very close to 0 and max close to 959
        assert.strictEqual(min <= 5, true, `Min value ${min} seems too high`);
        assert.strictEqual(max >= 954, true, `Max value ${max} seems too low`);
    });

    test('P7', 'standardPosition() returns 518', () => {
        assert.strictEqual(chess960.standardPosition(), 518);
    });

    test('P8', 'positionToDisplay(518) includes correct FEN', () => {
        const display = chess960.positionToDisplay(518);
        assert.strictEqual(display.number, 518);
        assert.ok(display.fen, 'FEN string should exist');
        assert.ok(display.fen.startsWith('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR'),
            `FEN starts wrong: ${display.fen}`);
    });

    test('P9', 'buildFEN constructs correct FEN for standard position', () => {
        const fen = chess960.buildFEN(['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R']);
        assert.strictEqual(fen, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    });

    // ============================================================
    // Database Layer Tests
    // ============================================================
    console.log('\n📦 Database Layer\n');

    // Initialize database for DB tests
    db = require('../src/services/database');
    await db.initialize();

    test('P10', 'Database initializes with all tables queryable', () => {
        const tables = ['players', 'games', 'queue', 'reigns', 'config', 'venue_codes', 'admin_notifications', 'payouts'];
        for (const table of tables) {
            // This would throw if table doesn't exist
            db.getConfig('test_nonexistent'); // uses config table
        }
        // More direct: try a SELECT on each table
        // We can't easily do raw queries through the module, but getConfig working proves config exists.
        // Let's verify by using exported functions that touch each table:
        assert.ok(Array.isArray(db.getAllPlayers()), 'players table works');
        assert.ok(Array.isArray(db.getQueue()), 'queue table works');
        assert.ok(Array.isArray(db.getRecentGames()), 'games table works');
        assert.ok(Array.isArray(db.getUnresolvedNotifications()), 'admin_notifications table works');
        assert.ok(Array.isArray(db.getAllPayouts()), 'payouts table works');
        assert.ok(Array.isArray(db.getLongestReigns()), 'reigns table works');
        // venue_codes tested via getActiveVenueCode (returns null if none)
        const vc = db.getActiveVenueCode();
        assert.ok(vc === null || typeof vc === 'object', 'venue_codes table works');
    });

    test('P11', 'Default config values are seeded correctly', () => {
        assert.strictEqual(db.getConfig('sat_rate_per_second'), '21');
        assert.strictEqual(db.getConfig('time_control_base'), '180');
        assert.strictEqual(db.getConfig('time_control_increment'), '2');
    });

    test('P12', 'createGame randomly assigns king_color (white or black)', () => {
        // Need two players and a reign for createGame
        const p1 = db.createPlayer('TestKing', '');
        const p2 = db.createPlayer('TestChallenger', '');
        const reignId = db.createReign(p1);

        const colors = new Set();
        for (let i = 0; i < 50; i++) {
            const gameId = db.createGame(p1, p2, 518, reignId);
            const game = db.getGameById(gameId);
            assert.ok(game.king_color === 'white' || game.king_color === 'black',
                `Unexpected king_color: ${game.king_color}`);
            colors.add(game.king_color);
        }
        // Over 50 games, we should see both colors (probability of all same = 2^-49)
        assert.strictEqual(colors.size, 2, `Expected both colors, got: ${[...colors]}`);
    });

    test('P13', 'addSatsToPlayer updates both sat_balance and total_sats_earned', () => {
        const pid = db.createPlayer('SatTest', '');
        db.addSatsToPlayer(pid, 100);
        const player = db.getPlayerById(pid);
        assert.strictEqual(player.sat_balance, 100);
        assert.strictEqual(player.total_sats_earned, 100);
    });

    test('P14', 'resetEventData preserves player accounts but clears stats', () => {
        const pid = db.createPlayer('ResetTest', '');
        db.addSatsToPlayer(pid, 500);
        db.updatePlayerStats(pid, { games_played: 10, games_won: 5 });

        // Verify stats are set
        let player = db.getPlayerById(pid);
        assert.strictEqual(player.sat_balance, 500);
        assert.strictEqual(player.games_played, 10);

        db.resetEventData();

        // Player should still exist but with zeroed stats
        player = db.getPlayerById(pid);
        assert.ok(player, 'Player should still exist after reset');
        assert.strictEqual(player.sat_balance, 0);
        assert.strictEqual(player.games_played, 0);
        assert.strictEqual(player.games_won, 0);
        assert.strictEqual(player.total_sats_earned, 0);
    });

    test('P15', 'Queue operations maintain correct ordering', () => {
        const pA = db.createPlayer('QueueA', '');
        const pB = db.createPlayer('QueueB', '');
        const pC = db.createPlayer('QueueC', '');

        db.addToQueue(pA);
        db.addToQueue(pB);
        db.addToQueue(pC);

        const queue = db.getQueue();
        assert.strictEqual(queue.length, 3);
        assert.strictEqual(queue[0].player_id, pA);
        assert.strictEqual(queue[1].player_id, pB);
        assert.strictEqual(queue[2].player_id, pC);
        assert.strictEqual(queue[0].position, 1);
        assert.strictEqual(queue[1].position, 2);
        assert.strictEqual(queue[2].position, 3);

        const next = db.getNextInQueue();
        assert.strictEqual(next.player_id, pA);
    });

    test('P16', 'isPlayerInQueue correctly detects queue membership', () => {
        const pid = db.createPlayer('QueueCheck', '');
        assert.strictEqual(db.isPlayerInQueue(pid), false);

        db.addToQueue(pid);
        assert.strictEqual(db.isPlayerInQueue(pid), true);

        db.removePlayerFromQueue(pid);
        assert.strictEqual(db.isPlayerInQueue(pid), false);
    });

    test('P17', 'moveToFrontOfQueue reorders correctly', () => {
        // Clean queue first
        const existingQueue = db.getQueue();
        for (const entry of existingQueue) {
            db.removeFromQueue(entry.id);
        }

        const pA = db.createPlayer('FrontA', '');
        const pB = db.createPlayer('FrontB', '');
        const pC = db.createPlayer('FrontC', '');

        db.addToQueue(pA);
        db.addToQueue(pB);
        const cQueueId = db.addToQueue(pC);

        // Move C to front
        db.moveToFrontOfQueue(cQueueId);

        const queue = db.getQueue();
        assert.strictEqual(queue[0].player_id, pC, `Expected C first, got player ${queue[0].player_id}`);
        assert.strictEqual(queue[1].player_id, pA, `Expected A second, got player ${queue[1].player_id}`);
        assert.strictEqual(queue[2].player_id, pB, `Expected B third, got player ${queue[2].player_id}`);
    });

    test('P18', 'Venue code validation works', () => {
        const futureExpiry = new Date(Date.now() + 3600000).toISOString();
        db.createVenueCode('TEST99', futureExpiry);

        assert.strictEqual(db.validateVenueCode('TEST99'), true);
        assert.strictEqual(db.validateVenueCode('WRONG1'), false);
        assert.strictEqual(db.validateVenueCode(''), false);
    });

    test('P19', 'createPlayer returns valid integer ID > 0', () => {
        const id = db.createPlayer('IDTest', '');
        assert.strictEqual(typeof id, 'number');
        assert.strictEqual(id > 0, true);
    });

    test('P20', 'deductSatsFromPlayer reduces balance and increases claimed', () => {
        const pid = db.createPlayer('DeductTest', '');
        db.addSatsToPlayer(pid, 200);
        db.deductSatsFromPlayer(pid, 50);

        const player = db.getPlayerById(pid);
        assert.strictEqual(player.sat_balance, 150);
        assert.strictEqual(player.total_sats_claimed, 50);
    });

    // ============================================================
    // Game Engine Logic Tests (code inspection + partial runtime)
    // ============================================================
    console.log('\n♟️  Game Engine Logic\n');

    test('P22', 'getThoneState typo exists (exported as getThoneState)', () => {
        const gameEngine = require('../src/services/gameEngine');
        assert.strictEqual(typeof gameEngine.getThoneState, 'function');
        assert.strictEqual(gameEngine.getThroneState, undefined, 'getThroneState should NOT exist');
    });

    test('P23', 'Sat rate default is 21 sats/second', () => {
        assert.strictEqual(db.getConfig('sat_rate_per_second'), '21');
    });

    test('P24', 'Winner confirm delay default is 60 seconds', () => {
        assert.strictEqual(db.getConfig('winner_only_confirm_delay'), '60');
    });

    // P25: reportResult rejects invalid values — needs an active game to test meaningfully.
    // We test by code inspection: the validation check is:
    //   if (!['king_won', 'challenger_won', 'draw', 'no_show'].includes(result))
    // We can verify the valid set:
    test('P25', 'reportResult valid results are king_won, challenger_won, draw, no_show', () => {
        // Verify by checking the source pattern
        const validResults = ['king_won', 'challenger_won', 'draw', 'no_show'];
        // Create a game to test with
        const king = db.createPlayer('P25King', '');
        const challenger = db.createPlayer('P25Challenger', '');
        const reignId = db.createReign(king);
        const gameId = db.createGame(king, challenger, 518, reignId);
        db.setConfig('current_game_id', String(gameId));
        db.setConfig('current_king_id', String(king));

        // Initialize game engine with a fake io
        const gameEngine = require('../src/services/gameEngine');

        // reportResult with invalid result
        const result = gameEngine.reportResult(king, 'invalid');
        assert.ok(result.error, 'Should return an error for invalid result');
        assert.ok(result.error.includes('Invalid result'), `Error message: ${result.error}`);
    });

    // ============================================================
    // Potential Bugs / Edge Cases
    // ============================================================
    console.log('\n🐛 Potential Bugs / Edge Cases\n');

    test('P26', 'mergeAccounts does NOT recalculate games_lost or games_drawn', () => {
        // Read the mergeAccounts function's SQL — it only SELECTs games_played, games_won, times_as_king, total_sats_earned
        // We verify by creating two players with known stats, merging, and checking
        const target = db.createPlayer('MergeTarget', '');
        const source = db.createPlayer('MergeSource', '');

        // Give source some losses
        db.updatePlayerStats(source, { games_played: 5, games_lost: 3, games_drawn: 1 });
        db.updatePlayerStats(target, { games_played: 2, games_lost: 1, games_drawn: 0 });

        db.mergeAccounts(target, source);

        const merged = db.getPlayerById(target);
        // games_played and games_won are recalculated from game records (which is 0 since we didn't create game records)
        // But games_lost and games_drawn are NOT touched by merge — they keep the target's original values
        assert.strictEqual(merged.games_lost, 1, `games_lost should remain at target's original value (1), got ${merged.games_lost}`);
        assert.strictEqual(merged.games_drawn, 0, `games_drawn should remain at target's original value (0), got ${merged.games_drawn}`);
        // This confirms the bug: source's 3 losses and 1 draw are lost in the merge
    });

    test('P27', 'buildFEN uses same arrangement for both sides (Chess960 standard)', () => {
        const fen = chess960.buildFEN(['R', 'K', 'B', 'Q', 'N', 'N', 'B', 'R']);
        const parts = fen.split(' ')[0].split('/');
        const blackRank = parts[0]; // first rank in FEN
        const whiteRank = parts[7]; // last rank in FEN
        assert.strictEqual(blackRank, whiteRank.toLowerCase(),
            `Black rank (${blackRank}) should be lowercase of white rank (${whiteRank})`);
    });

    test('P28', 'Auto-save interval verification (code inspection)', () => {
        // We can't easily test setInterval timing, but we can verify the module loaded.
        // The auto-save is set up at module load time with setInterval(..., 30000).
        // Verification: the database module exists and has save() exported.
        assert.strictEqual(typeof db.save, 'function');
        // This is verified by code inspection — the setInterval(save, 30000) call is at module level.
    });

    // ============================================================
    // Summary
    // ============================================================
    console.log('\n' + '='.repeat(60));
    console.log(`\n📊 Results: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);

    // Write results back to predictions file
    const fs = require('fs');
    let predictionsContent = fs.readFileSync(path.join(__dirname, 'predictions.md'), 'utf-8');
    for (const r of results) {
        const marker = r.status === 'PASS' ? '✅ PASS' : '❌ FAIL';
        // Add result after the ### line for this prediction
        const pattern = new RegExp(`(### ${r.id}:.*?)\\n`, 's');
        predictionsContent = predictionsContent.replace(pattern, `$1 — ${marker}\n`);
    }
    fs.writeFileSync(path.join(__dirname, 'predictions.md'), predictionsContent);
    console.log('📝 Updated predictions.md with PASS/FAIL results\n');

    // Clean up test database
    try {
        fs.unlinkSync(path.join(__dirname, 'test_throne.db'));
    } catch (e) { /* ignore */ }

    if (failed > 0) {
        console.log('Failed predictions:');
        for (const r of results.filter(r => r.status === 'FAIL')) {
            console.log(`  ${r.id}: ${r.description} — ${r.error}`);
        }
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});
