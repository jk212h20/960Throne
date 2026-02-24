# 960 Throne — Progress

## What Works ✅
- [x] Express server with Socket.io real-time
- [x] SQLite database with full schema (players, games, queue, reigns, config, venue_codes, notifications)
- [x] Player registration (name → auto-generated 4-digit PIN)
- [x] Player login (name + PIN → session cookie)
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
- [ ] Fix session cookie persistence (registration → player redirect broken)
- [ ] End-to-end test of full game flow (crown king → start game → report → new king)
- [ ] Configure Voltage LND credentials and test Lightning payouts
- [ ] Set real admin password in `.env`

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
| `players` | id, name, pin, lightning_address, sats_balance, created_at |
| `games` | id, king_id, challenger_id, chess960_position, result, sats_earned, timestamps |
| `queue` | id, player_id, position, status (waiting/on_deck/called), timeout_count |
| `reigns` | id, king_id, start_time, end_time, games_won, games_played, total_sats |
| `config` | key-value store for sat_rate, time_control, etc. |
| `venue_codes` | code, active flag, expiry |
| `admin_notifications` | type, message, resolved flag |

## API Routes
| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/api/register` | Create player |
| POST | `/api/login` | Login with name+PIN |
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
