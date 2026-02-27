# 960 Throne — Active Context

## Current State (Feb 27, 2026)
MVP is **deployed to Railway** and live at https://960throne-production.up.railway.app

**GitHub repo**: https://github.com/jk212h20/960Throne (public)
**Railway project**: https://railway.com/project/640d9f08-a87f-4658-8fa0-21df70003fbf

## What Was Just Done
### Event Timeline Page + Admin QR (Feb 27, 2026)
- **Timeline page (`/timeline`)**: Full chronological event history page — scrollable vertical timeline showing every game and king crowning. Features:
  - Summary stats at top (total games, total kings, longest reign, best win streak)
  - Color-coded reign history bar — visual proportional bar showing each king's reign duration with unique colors per player
  - Timeline entries: crown nodes (gold) for crownings, green/red/gray dots for game results
  - Mini Chess960 position display per game (using unicode pieces on alternating squares)
  - Shows king color (white/black pieces) per game
  - Current king indicator at bottom if someone is reigning
  - Public page, no auth required
  - New files: `src/views/timeline.ejs`, `db.getTimelineData()` in database.js
  - Route added in `src/routes/pages.js`
- **Admin Venue QR display**: Admin panel now shows the venue QR code image (from `/api/admin/venue-qr` endpoint) directly in the Venue Code section with a "Print QR" button that opens a clean printable full-page view
- **Timeline navigation links**: Added 📜 Timeline links to leaderboard footer nav and admin header nav
- **chess960 import**: Added `require('../services/chess960')` to pages.js for position piece rendering

### Piece Display Corrections (Feb 26, 2026)
- **White square on right**: Board squares now alternate dark→light (left to right) so rightmost square (h1) is always light — matching chess convention.
- **King's color pieces**: Display uses white pieces (♔♕♖♗♘) when king is white, black pieces (♚♛♜♝♞) when king is black.
- **Board mirroring**: When king plays black, piece order is reversed (viewed from black's perspective).
- Files changed: `throne.ejs`, `throne-live.ejs`, `game.ejs`

### Random Color Assignment (Feb 26, 2026)
- **King gets random color each game**: `king_color` column in `games` table, randomly assigned white or black (50/50) at game creation.
- Files changed: `database.js`, `gameEngine.js`, `game.ejs`, `throne.ejs`, `throne-live.ejs`, `admin.ejs`

### Result Conflict Self-Resolution (Feb 26, 2026)
- **Conflict detection & player notification**: When king and challenger report incompatible results, both see a warning with buttons re-enabled to re-submit.
- Files changed: `database.js`, `gameEngine.js`, `game.ejs`

### Previous changes — see git log for details
- Game auto-start, no-show handling, camera fix, on-deck removal
- UTC timezone fix, QR scanner, non-expiring sessions, optional email
- Railway volume mount, accounting audit, inline venue code scan
- Admin cookie path fix, scheduled event reset, sat persistence
- Lightning login (LNURL-auth) replacing PIN system

## Player Flow
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
| `src/services/chess960.js` | Chess960 position generation |
| `src/routes/api.js` | All REST API endpoints (auth, game, admin) |
| `src/routes/pages.js` | Page rendering + auth flow routing |
| `src/views/timeline.ejs` | Event timeline page |

## Next Steps (TODO for next session)

### 1. Mobile Responsiveness Polish — MEDIUM PRIORITY
- Review all views on narrow viewports (especially game.ejs, leaderboard.ejs)
- Ensure buttons are tap-friendly (min 44px touch targets)
- Check text readability on small screens

### 2. Lightning Status Panel in Admin — MEDIUM PRIORITY
- Show LND node connection status, alias, channel balance in admin panel
- Useful for monitoring payout capacity during events

### 3. Error Handling & Resilience — LOW PRIORITY
- Rate limiting on API endpoints
- Server crash mid-game recovery
- Duplicate tab detection for same player

### 4. Payout History in Admin — LOW PRIORITY
- Show recent payouts with status (completed/failed) in admin panel

## Known Issues Still Open
1. **Railway deploy is manual** — `railway up --detach` needed after each push (auto-deploy from GitHub not configured)
2. **`getThoneState` typo** — Function name has typo (missing 'r'), used consistently everywhere so not a bug, just cosmetic

## Architecture
```
Player Phone → Website (EJS) → Express API → SQLite (sql.js)
                    ↕ Socket.io (real-time)
Venue Screen → /throne (auto-updates)
Admin Phone → /admin (game control)
                    ↕
Auth: LNURL-auth (Lightning wallet signs challenge)
Payouts: Voltage LND node "predictions" (configured, 620k sats channel balance)
```
