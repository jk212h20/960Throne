# 960 Throne — Active Context

## Current State (Feb 24, 2026)
MVP is **built and running**. All core features implemented. First test run confirms:
- Registration flow works (name → PIN generated → session cookie)
- Throne dashboard renders with real-time state
- Admin login flow works with password auth
- CSS builds correctly via Tailwind

## What Was Just Built
Complete King of the Hill Chess960 app for a live event in Prospera, Roatán:
- Express + EJS + Tailwind + Socket.io + SQLite stack
- Player registration with 4-digit PIN auth
- Queue system with venue codes, on-deck notifications
- Game engine with Chess960 position generation
- Real-time throne dashboard for venue big screen
- Admin panel with game control, queue management, config
- Lightning (Voltage LND) integration for sat payouts

## Known Issues to Fix
1. **Session cookie not persisting** — After registration, the "Continue →" link doesn't maintain the session. The cookie is set via `res.cookie()` in the API POST response, but the page redirect loses it. Need to debug cookie path/domain settings.
2. **Admin password** — `.env` has `ADMIN_PASSWORD=changeme`, needs to be updated before event
3. **Lightning not tested** — Voltage LND credentials not configured yet

## Key Files
| File | Purpose |
|------|---------|
| `src/index.js` | Express server + Socket.io setup |
| `src/services/database.js` | SQLite schema, all DB queries |
| `src/services/gameEngine.js` | Game state machine, sat tracking, king transitions |
| `src/services/chess960.js` | Chess960 random position generator |
| `src/services/lightning.js` | Voltage LND Lightning payments |
| `src/routes/api.js` | All REST API endpoints |
| `src/routes/pages.js` | Page rendering routes |
| `src/views/*.ejs` | All frontend templates |
| `.env` | Config (admin pass, LN creds, base URL) |

## Architecture
```
Player Phone → Website (EJS) → Express API → SQLite
                    ↕ Socket.io (real-time)
Venue Screen → /throne (auto-updates)
Admin Phone → /admin (game control)
                    ↕
              Voltage LND (Lightning payouts)
```
