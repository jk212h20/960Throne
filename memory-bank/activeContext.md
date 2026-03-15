# 960 Throne — Active Context

## Current State (Feb 27, 2026)
MVP is **deployed to Railway** and live at https://960throne-production.up.railway.app

**GitHub repo**: https://github.com/jk212h20/960Throne (public)
**Railway project**: https://railway.com/project/640d9f08-a87f-4658-8fa0-21df70003fbf

## What Was Just Done
### Game-Count Position Offset (Mar 11, 2026)
- **Problem**: Multiple games within the same Bitcoin block got the same Chess960 position
- **Fix**: `fetchBitcoinPosition()` now tracks `_gameCountInBlock` — each call offsets the base position by `(basePosition + gameCount) % 960`. Counter resets when block hash changes.
- Block API data cached 30s (avoid hammering mempool.space), but position derivation always uses latest game counter
- Log format: `₿ Position #X from block Y (game Z in block, base #W)`
- Deployed to Railway

### SVG Piece Icons on Board (Mar 11, 2026)
- Extracted 12 piece SVGs from `btc-chess-widget(5).html` into `public/pieces/` (wK/wQ/wR/wB/wN/wP + black variants)
- Replaced Unicode chess characters with `<img src="/pieces/XX.svg">` in: game.ejs, throne.ejs, throne-live.ejs, timeline.ejs
- White pieces: light fill (#e6e6e6) with dark stroke; Black pieces: no fill with light stroke (#e6e6e6)
- Deployed to Railway

### Bitcoin-Derived Chess960 Positions + Admin QR Fix (Mar 11, 2026)
- **Chess960 positions from Bitcoin blockhash**: Game positions are now deterministically derived from the latest Bitcoin block hash via mempool.space API, with fallback to random if API is unavailable
- **New functions in `chess960.js`**: `hashToPosition(hexHash)` maps any hash to position 0-959 using Bishop placement constraints; `fetchBitcoinPosition()` fetches latest block and returns `{ positionNumber, blockHeight, blockHash, pieces }`
- **New API endpoint**: `GET /api/bitcoin-position` — returns current Bitcoin-derived position info
- **Game engine updated**: `callNextChallenger()` is now async, tries Bitcoin position first with random fallback. Logs `₿ Position #X from block Y` on success.
- **Admin QR code fix**: Changed venue QR `<img>` src from authenticated `/api/admin/venue-qr?format=png` to public `/api/venue-qr.png` — the authenticated endpoint wasn't accessible to `<img>` tags reliably
- **Enlarge button**: Already present with fullscreen overlay (`enlargeQR()`) + print button
- Status: **deployed to Railway**

### Custom SVG Icon System (Mar 5, 2026)
- **Replaced all emoji with custom SVG icons** across every EJS template (12 files)
- **Icon library**: 25 hand-crafted SVGs in `public/icons/` — crown, trophy, lightning, crossed-swords, shield, handshake, coins, castle, chess-piece, gear, chart, scroll, globe, stopwatch, medal, bell, queue, gamepad, key, warning, checkmark, cross, hourglass, eye, pawn
- **Icon server family**: `960-throne` in icon-server MCP with full style guide (2px stroke, 24×24 viewBox, rounded caps, gold/purple/gray palette)
- **Icon include system**: `app.locals.icon(name, size, cls)` helper in `src/index.js` + EJS partial `src/views/partials/icon.ejs` — cached file reads, inline SVG injection with size/class params
- **CSS**: Added `.icon { display: inline-block; vertical-align: middle; flex-shrink: 0; }` base styles in `src/styles/input.css`
- **Files changed**: All 12 EJS view files, `src/index.js`, `src/styles/input.css`, new `src/views/partials/icon.ejs`, new `public/icons/*.svg` (25 files)
- **Note**: A few emoji remain in JS `textContent` strings (error fallbacks in join.ejs, set-name.ejs) and admin.ejs header/sections where inline replacement wasn't needed. Timeline game entries still use emoji for result display (🛡️⚔️🤝) in JS-generated content.
- Status: **verified working locally**, not yet deployed

### Telegram Player Notifications (Mar 4, 2026)
- **Telegram bot for player notifications**: Players can link their Telegram account to receive push notifications for:
  - 🔔 On-deck (you're next in the queue)
  - ⚔️ Game started (opponent name, position number, your color)
  - 👑 Became king
- **New file**: `src/services/telegram.js` — Bot polling, link code management, send helpers
- **DB changes**: `telegram_chat_id` column on players, `telegram_link_codes` table
- **API endpoints**: `POST /api/telegram/link`, `GET /api/telegram/status`, `POST /api/telegram/unlink`
- **Player UI**: New "🔔 Telegram Notifications" card on player.ejs with link/unlink flow
- **Link flow**: Player clicks "Connect Telegram" → deep link to bot → `/start CODE` → bot verifies code → linked
- **Bot**: `@CoraTelegramBot` (token in `.env` as `TELEGRAM_BOT_TOKEN`)
- **Env var**: `TELEGRAM_BOT_TOKEN` (required), existing `TELEGRAM_CHAT_ID` still used for admin alerts
- Status: **working locally, not yet verified by user on live**

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
| `src/index.js` | Express server + Socket.io setup + icon helper |
| `src/services/auth/index.js` | Extensible auth manager |
| `src/services/auth/lightning.js` | LNURL-auth implementation |
| `src/services/database.js` | SQLite schema, all DB queries |
| `src/services/gameEngine.js` | Game state machine, sat tracking |
| `src/services/chess960.js` | Chess960 position generation |
| `src/routes/api.js` | All REST API endpoints (auth, game, admin) |
| `src/routes/pages.js` | Page rendering + auth flow routing |
| `src/services/telegram.js` | Telegram bot polling + player notifications |
| `src/views/timeline.ejs` | Event timeline page |
| `src/views/partials/icon.ejs` | SVG icon include partial |
| `public/icons/*.svg` | 25 custom SVG icons (960-throne family) |

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
1. **`getThoneState` typo** — Function name has typo (missing 'r'), used consistently everywhere so not a bug, just cosmetic

## Railway Infrastructure
- **Auto-deploy**: GitHub repo trigger on `jk212h20/960Throne` → `master` branch
- **Volume**: `960throne-volume` mounted at `/app/data` (1.6GB/50GB used)
- **DATABASE_PATH**: `/app/data/throne.db` (persists across deploys)
- **Project ID**: `640d9f08-a87f-4658-8fa0-21df70003fbf`
- **Service ID**: `2ebaaa5c-c93a-4b35-80a3-0cdcb4dbe711`
- **Environment ID**: `c89ea800-e875-453b-8f75-8c72d0d08c40`

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
