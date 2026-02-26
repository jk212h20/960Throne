# 960 Throne — Active Context

## Current State (Feb 25, 2026)
MVP is **deployed to Railway** and live at https://960throne-production.up.railway.app

**GitHub repo**: https://github.com/jk212h20/960Throne (public)
**Railway project**: https://railway.com/project/640d9f08-a87f-4658-8fa0-21df70003fbf

## What Was Just Done
### Admin Cookie Path Fix + Dev Port (Feb 25, 2026)
- **Bug**: `admin_token` cookie was set without `Path=/`, so browsers defaulted to `/api/admin` (the login endpoint path). Cookie was never sent to `/admin` or `/throne` page routes — admin login appeared broken.
- **Fix**: Added `path: '/'` to `res.cookie()` in `POST /api/admin/login` (`src/routes/api.js`)
- **Dev port**: Changed local dev port from 3000 → **3960** to avoid conflicts with other projects (`.env` only, not committed)

### Scheduled Event Reset (Feb 25, 2026)
- Admin can schedule a future time to reset all event data (stats, sats, games, reigns, queue)
- Requires re-entering admin password (high security double-check)
- Live countdown timer on admin page shows time until reset
- Auto-creates timestamped DB backup before reset (`data/throne_pre-reset_*.db`)
- Keeps player accounts & config, only clears event data
- Persists across server restarts (stored in `config.scheduled_reset_at`, timer resumes on boot)
- Socket events notify all clients when reset fires/is scheduled/cancelled
- Files: `database.js` (backupDatabase, resetEventData), `gameEngine.js` (scheduleReset, cancelReset, executeScheduledReset), `api.js` (3 endpoints), `admin.ejs` (UI)

### Balance vs Total Sats Distinction (Feb 25, 2026)
- Player header now shows "sat balance" (withdrawable) vs "total earned" (lifetime, unaffected by withdrawals)
- `sat_balance` decreases on withdrawal; `total_sats_earned` never decreases
- Throne displays show king's all-time stats (total sats, total reign time, # reigns) below current reign

### Sat Persistence & Correctness Fix (Feb 25, 2026)
- **Sats now accumulate continuously from the moment a king is crowned** (not just during games)
- **Single source of truth**: `sats = floor((now - crowned_at) * sat_rate)` — a pure function of time
- Server-side accumulator flushes to DB every 10s so sats survive page reloads/restarts
- Client-side counters use the same formula (derive from `crowned_at` timestamp)
- Reign finalization computes exact final sats from timestamps, no incremental drift
- Leaderboard shows active reign with live sats/time
- All sat crediting goes through `crownKing()` → no double-counting on dethronement

### Throne Page Split — Admin-Protected + Public Live View (Feb 25, 2026)
- `/throne` now requires admin password (reuses same `admin_token` cookie as `/admin`)
- `/live` — new public web view with same throne info but **no QR code/venue code**
- Public live view shows URL hint instead of QR ("Watch live at .../live")
- New file: `src/views/throne-live.ejs`

### Lightning Login (LNURL-auth) — Replaced PIN Login (Feb 25, 2026)
- Built extensible auth system at `src/services/auth/` with strategy pattern
- Implemented LNURL-auth (LUD-04) for "Login with Lightning" via QR code
- New flow: scan QR with Lightning wallet → cryptographic auth → choose display name → play
- Added `auth_type` and `auth_id` columns to `players` table (with migration for existing DBs)
- **PIN system fully removed** — Lightning is the only auth method
- Admin merge accounts feature added (for locked-out players who create new accounts)
- New dependencies: `secp256k1`, `qrcode`
- `BASE_URL` env var set on Railway for LNURL-auth callbacks

### Auth Architecture (extensible for future methods)
```
src/services/auth/
  ├── index.js      # Auth manager — challenge store, strategy routing
  └── lightning.js   # LNURL-auth: bech32 encoding, secp256k1 sig verification
```
To add new auth (e.g., Nostr): create `src/services/auth/nostr.js`, register in `index.js` strategies map.

### New/Modified Files
| File | Change |
|------|--------|
| `src/services/auth/index.js` | NEW — Auth manager with in-memory challenge store |
| `src/services/auth/lightning.js` | NEW — LNURL-auth strategy (bech32, secp256k1) |
| `src/services/database.js` | Added `auth_type`, `auth_id` columns, migration, `createPlayerWithAuth`, `getPlayerByAuthId`, `setPlayerName` |
| `src/routes/api.js` | Added `/api/auth/lightning`, `/api/auth/lightning/callback`, `/api/auth/status`, `/api/auth/set-name` |
| `src/routes/pages.js` | Added `/set-name` route, name-check redirects on `/` and `/player` |
| `src/views/index.ejs` | Replaced name+PIN form with Lightning QR code + polling |
| `src/views/set-name.ejs` | NEW — Name selection page after Lightning auth |
| `src/views/player.ejs` | Shows "⚡ Lightning login" instead of PIN for lightning users |

## Player Flow (updated)
1. QR at venue → `/?code=XXXXX` → Lightning login QR displayed
2. Player scans with Lightning wallet (Phoenix, Zeus, Alby, etc.)
3. Wallet signs challenge → callback verified → session created
4. If new player: choose display name on `/set-name`
5. Player dashboard → join queue → play games → cash out sats

## Key Files
| File | Purpose |
|------|---------|
| `src/index.js` | Express server + Socket.io setup |
| `src/services/auth/index.js` | Extensible auth manager |
| `src/services/auth/lightning.js` | LNURL-auth implementation |
| `src/services/database.js` | SQLite schema, all DB queries |
| `src/services/gameEngine.js` | Game state machine, sat tracking |
| `src/routes/api.js` | All REST API endpoints (auth, game, admin) |
| `src/routes/pages.js` | Page rendering + auth flow routing |

## Known Issues Still Open
1. **Railway deploy is manual** — `railway up` needed after each push
2. **No persistent volume** — DB resets on redeploy
3. **Lightning payouts not tested** — Voltage LND credentials not configured

## Architecture
```
Player Phone → Website (EJS) → Express API → SQLite (sql.js)
                    ↕ Socket.io (real-time)
Venue Screen → /throne (auto-updates)
Admin Phone → /admin (game control)
                    ↕
Auth: LNURL-auth (Lightning wallet signs challenge)
Payouts: Voltage LND (not yet configured)
```
