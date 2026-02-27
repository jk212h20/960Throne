# 960 Throne — Predictions

Made by studying the source code before running any tests.
Each prediction is numbered and marked PASS/FAIL after verification.

## Chess960 Position Generator (`src/services/chess960.js`)

### P1: Position 518 is standard chess (RNBQKBNR) — ✅ PASS — ✅ PASS
The Scharnagl numbering system assigns 518 to the standard starting position.
**Prediction:** `positionFromNumber(518)` returns `['R','N','B','Q','K','B','N','R']`

### P2: Position 0 produces a specific arrangement — ✅ PASS — ✅ PASS
Working through the algorithm with n=0:
- Step 1: b1 = (0%4)*2+1 = 1 → Bishop at index 1
- Step 2: n2=0, b2 = (0%4)*2 = 0 → Bishop at index 0
- Step 3: n3=0, q = 0%6 = 0 → Queen at first empty (index 2)
- Step 4: n4=0, knightPlacements[0] = [0,1] → Knights at 1st and 2nd empty positions (indices 3,4)
- Step 5: Remaining [5,6,7] → R,K,R
**Prediction:** `positionFromNumber(0)` returns `['B','B','Q','N','N','R','K','R']`

### P3: All 960 positions have bishops on opposite-colored squares — ✅ PASS — ✅ PASS
The algorithm places one bishop on even indices (dark squares) and one on odd indices (light squares).
**Prediction:** For every position 0-959, one bishop is on an even index and one on an odd index.

### P4: King is always between the two rooks — ✅ PASS — ✅ PASS
Step 5 places pieces as R, K, R in the three remaining empty squares (in order).
**Prediction:** For every position 0-959, the king's index is between the two rook indices.

### P5: Exactly 960 unique positions exist — ✅ PASS — ✅ PASS
4 (light bishop) × 4 (dark bishop) × 6 (queen) × 10 (knights) = 960.
**Prediction:** Generating all positions 0-959 produces 960 distinct arrangements with no duplicates.

### P6: `randomPositionNumber()` returns values in range [0, 959] — ✅ PASS — ✅ PASS
Uses `Math.floor(Math.random() * 960)`.
**Prediction:** Over 10,000 calls, all values are >= 0 and <= 959.

### P7: `standardPosition()` returns 518 — ✅ PASS — ✅ PASS
**Prediction:** The function returns exactly 518.

### P8: `positionToDisplay` includes FEN string — ✅ PASS — ✅ PASS
**Prediction:** `positionToDisplay(518).fen` is a valid FEN string starting with `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR`

### P9: `buildFEN` constructs correct FEN — ✅ PASS — ✅ PASS
The black back rank is generated as lowercase of the input pieces, white rank stays uppercase.
**Prediction:** `buildFEN(['R','N','B','Q','K','B','N','R'])` equals `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1`

## Database Layer (`src/services/database.js`)

### P10: Database initializes successfully with all tables — ✅ PASS — ✅ PASS
**Prediction:** After `db.initialize()`, querying each table (players, games, queue, reigns, config, venue_codes, admin_notifications, payouts) doesn't throw.

### P11: Default config values are seeded — ✅ PASS — ✅ PASS
**Prediction:** After initialization, `getConfig('sat_rate_per_second')` returns `'21'`, `getConfig('time_control_base')` returns `'180'`, `getConfig('time_control_increment')` returns `'2'`.

### P12: `createGame` randomly assigns king_color — ✅ PASS — ✅ PASS
**Prediction:** `createGame()` without explicit kingColor sets `king_color` to either `'white'` or `'black'`. Over many calls, both values appear.

### P13: `addSatsToPlayer` updates both balance and total earned — ✅ PASS — ✅ PASS
**Prediction:** After creating a player and calling `addSatsToPlayer(id, 100)`, the player's `sat_balance` is 100 AND `total_sats_earned` is 100.

### P14: `resetEventData` preserves player accounts — ✅ PASS — ✅ PASS
**Prediction:** After creating a player, adding sats, then calling `resetEventData()`, the player still exists (by ID) but their `sat_balance`, `games_played`, etc. are all 0.

### P15: Queue operations maintain correct ordering — ✅ PASS — ✅ PASS
**Prediction:** Adding 3 players to queue results in positions 1, 2, 3. `getNextInQueue()` returns the first player added.

### P16: `isPlayerInQueue` correctly detects queue membership — ✅ PASS — ✅ PASS
**Prediction:** Returns false before adding, true after adding, false after removing.

### P17: `moveToFrontOfQueue` reorders correctly — ✅ PASS — ✅ PASS
**Prediction:** After adding players A, B, C (positions 1,2,3), moving C to front makes C position 1 and A position 2.

### P18: Venue code validation works — ✅ PASS — ✅ PASS
**Prediction:** `validateVenueCode` returns true for the active code and false for a random wrong code.

### P19: `last_insert_rowid()` is read before `save()` in createPlayer — ✅ PASS — ✅ PASS
Looking at the code: `db.run(INSERT...)`, then `db.exec(SELECT last_insert_rowid())`, then `save()`.
**Prediction:** `createPlayer` returns a valid integer ID > 0.

### P20: `deductSatsFromPlayer` reduces balance and increases claimed — ✅ PASS — ✅ PASS
**Prediction:** After adding 200 sats then deducting 50, player has `sat_balance` = 150 and `total_sats_claimed` = 50.

## Game Engine Logic (`src/services/gameEngine.js`)

### P21: Venue code format — 6 chars from restricted alphabet
`generateVenueCode()` uses `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no I, O, 0, 1).
**Prediction:** Generated codes are always exactly 6 characters, all from that character set.

### P22: `getThoneState` typo exists (not `getThroneState`) — ✅ PASS — ✅ PASS
**Prediction:** The exported function is named `getThoneState` (missing 'r').

### P23: Sat rate default is 21 sats/second — ✅ PASS — ✅ PASS
**Prediction:** `getConfig('sat_rate_per_second')` returns `'21'` after init.

### P24: Winner confirm delay default is 60 seconds — ✅ PASS — ✅ PASS
**Prediction:** `getConfig('winner_only_confirm_delay')` returns `'60'` after init.

### P25: `reportResult` rejects invalid result values — ✅ PASS — ✅ PASS
**Prediction:** Calling `reportResult` with result `'invalid'` returns `{ error: 'Invalid result...' }`.

## Potential Bugs / Edge Cases

### P26: `mergeAccounts` doesn't recalculate games_lost or games_drawn — ✅ PASS — ✅ PASS
The SQL in `mergeAccounts` recalculates `games_played`, `games_won`, `times_as_king`, and `total_sats_earned` — but NOT `games_lost` or `games_drawn`.
**Prediction:** After merging, the target player's `games_lost` and `games_drawn` are stale (not recalculated from game records).

### P27: `buildFEN` uses the same piece arrangement for both sides — ✅ PASS — ✅ PASS
The black rank is `backRank.join('').toLowerCase()` and white rank is `backRank.join('')`. Both sides get the same Chess960 arrangement.
**Prediction:** This is intentional for Chess960 (both sides mirror the same starting position).

### P28: Auto-save interval is 30 seconds — ✅ PASS — ✅ PASS
**Prediction:** The `setInterval` in database.js for auto-save uses 30000ms.
