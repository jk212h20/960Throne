# 960 Throne — Active Context

## Current State (Feb 25, 2026)
MVP is **deployed to Railway** and live at https://960throne-production.up.railway.app

**GitHub repo**: https://github.com/jk212h20/960Throne (public)
**Railway project**: https://railway.com/project/640d9f08-a87f-4658-8fa0-21df70003fbf

## What Was Just Done
### Game Auto-Start, No-Show, Camera Fix, On-Deck Removal (Feb 25, 2026)
- **QR Camera fix round 2**: Force 2x zoom after starting scanner to hit main camera lens (many phones default to ultra-wide). Also apply zoom via raw MediaStreamTrack constraints as fallback. Use `facingMode: { exact: 'environment' }` for stricter rear camera.
- **On-deck step fully removed**: Players go straight from queue → active game. No 30-second "show up" timer. If they don't show, admin hits "No Show" to skip to next challenger.
- **Games auto-start**: When a challenger is called from queue, the game starts immediately — no admin "Start Game" button needed. `callNextChallenger()` creates the game record automatically.
- **No-show result**: New `no_show` result type — doesn't count as a real game, reuses same Chess960 position for next challenger. Available as 4th button on game.ejs and admin.ejs.
- **Admin remove challenger**: `POST /api/admin/remove-challenger` — marks current game as no_show, same position reused.
- **adminSetChallenger**: Now auto-starts a game immediately (ends any active game as no_show first).
- **Elapsed timers**: All active game views (game.ejs, player.ejs, admin.ejs) show "⏱️ Started X:XX ago" with live ticking timer.
- **Stale on-deck cleanup**: On server init, any stale on-deck entries are reset to 'waiting' via `resetOnDeckToWaiting()`.

### Previous changes (Feb 25, 2026) — see git log for details
- UTC timezone fix for timers, QR scanner rewrite (html5-qrcode), non-expiring sessions, optional email
- Railway volume mount fix, accounting audit flush-before-audit, inline venue code scan on player page
- Admin cookie path fix, scheduled event reset, sat persistence/correctness, throne page split
- Lightning login (LNURL-auth) replacing PIN system, auth architecture

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
2. **Lightning payouts not tested** — Voltage LND credentials not configured

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
