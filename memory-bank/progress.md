# 960 Throne — Progress

## What Works ✅
- [x] Express server with Socket.io real-time
- [x] SQLite database with full schema (players, games, queue, reigns, config, venue_codes, notifications)
- [x] Player registration via Lightning login (LNURL-auth QR scan)
- [x] Player login via Lightning wallet (cryptographic, no passwords)
- [x] Extensible auth system (`src/services/auth/`) — strategy pattern for future methods
- [x] Admin merge accounts (for locked-out players who create new accounts)
- [x] Chess960 position generator (all 960 valid positions)
- [x] Game engine state machine (start game → report result → king transitions)
- [x] Sat accumulation tracking (21 sats/sec, calculated on game end)
- [x] Queue system with venue codes, position tracking, on-deck status
- [x] Throne dashboard (`/throne`) — real-time big-screen display
- [x] Player dashboard (`/player`) — stats, balance, queue status
- [x] Admin panel (`/admin`) — game control, crown king, queue mgmt, config editor
- [x] Admin auth (password-protected)
- [x] Leaderboard page with top kings/earners
- [x] Venue code generation with auto-rotation
- [x] Lightning integration code (Voltage LND via REST API)
- [x] Tailwind CSS build with custom throne theme
- [x] Notification system for admin (draw disputes, queue timeouts)

## What's Left to Build 🔨

### High Priority
- [ ] End-to-end test of full game flow (crown king → start game → report → new king)
- [x] Configure Voltage LND credentials and test Lightning payouts (node "predictions", 620k sats)
- [ ] Add Railway persistent volume (mount `/app/data` for SQLite persistence across deploys)
- [x] Set `BASE_URL` env var on Railway to `https://960throne-production.up.railway.app`
- [ ] Connect Railway to GitHub for auto-deploy (currently manual `railway up`)

### Medium Priority
- [ ] QR code generation for venue code URLs
- [ ] Sound effects / animations for throne transitions
- [ ] Mobile responsiveness polish
- [ ] Push notifications (via Service Worker) for on-deck players

### Low Priority
- [ ] Player photo/avatar uploads
- [ ] Historical stats across multiple events
- [ ] Spectator chat/reactions
- [ ] Export game history to PGN format

## Database Schema
| Table | Purpose |
|-------|---------|
| `players` | id, name, pin, auth_type, auth_id, session_token, sats_balance, created_at |
| `games` | id, king_id, challenger_id, chess960_position, result, sats_earned, timestamps |
| `queue` | id, player_id, position, status (waiting/on_deck/called), timeout_count |
| `reigns` | id, king_id, start_time, end_time, games_won, games_played, total_sats |
| `config` | key-value store for sat_rate, time_control, etc. |
| `venue_codes` | code, active flag, expiry |
| `admin_notifications` | type, message, resolved flag |

## API Routes
| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/api/auth/lightning` | Generate LNURL-auth challenge + QR |
| GET | `/api/auth/lightning/callback` | Wallet callback (sig verification) |
| GET | `/api/auth/status` | Poll auth status (frontend) |
| POST | `/api/auth/set-name` | Set display name after Lightning auth |
| POST | `/api/admin/merge-accounts` | Merge two player accounts (admin) |
| POST | `/api/queue/join` | Join queue (requires venue code) |
| POST | `/api/queue/leave` | Leave queue |
| POST | `/api/game/:id/result` | Report game result |
| POST | `/api/player/claim-sats` | Claim sats via Lightning |
| POST | `/api/admin/login` | Admin auth |
| POST | `/api/admin/crown` | Crown a player as King |
| POST | `/api/admin/start-game` | Start next game |
| POST | `/api/admin/override-result` | Override game result |
| POST | `/api/admin/rotate-venue-code` | Generate new venue code |
| POST | `/api/admin/config` | Update config values |
| POST | `/api/admin/queue/add` | Add player to queue |
| POST | `/api/admin/queue/remove` | Remove from queue |
| POST | `/api/admin/undo-game` | Undo finalized game, reverse stats, restore king |
| POST | `/api/admin/set-challenger` | Set specific player as challenger (bypass queue) |
