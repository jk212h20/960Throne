# 960 Throne — Active Context

## Current State (Feb 24, 2026)
MVP is **built and running**. Critical session bug fixed. Registration → player dashboard flow works end-to-end.

## What Was Just Fixed
### Critical Bug: `save()` before `last_insert_rowid()` in sql.js
- `db.export()` (called by `save()`) resets `last_insert_rowid()` to 0 in sql.js
- `createPlayer()` was returning id=0, so `setPlayerSession()` did `UPDATE WHERE id=0` (no match)
- All session_tokens stayed null → no player could ever stay logged in
- **Fixed in**: `createPlayer`, `createGame`, `createReign`, `createPayout`, `addToQueue`
- **Rule**: In sql.js, ALWAYS call `last_insert_rowid()` BEFORE `save()`

### Registration switched to form POST
- Was: fetch() API call + client-side redirect (cookie issues in some browsers)
- Now: `<form method="POST" action="/register">` → server sets cookie + `res.redirect('/player')`
- Login also uses form POST via `POST /login` in pages.js

## Known Issues Still Open
1. **Admin password** — `.env` has `ADMIN_PASSWORD=changeme`, needs to be updated before event
2. **Lightning not tested** — Voltage LND credentials not configured yet
3. **Full game flow untested** — Need to test: crown king → start game → report result → new king cycle

## Key Files
| File | Purpose |
|------|---------|
| `src/index.js` | Express server + Socket.io setup |
| `src/services/database.js` | SQLite schema, all DB queries |
| `src/services/gameEngine.js` | Game state machine, sat tracking, king transitions |
| `src/services/chess960.js` | Chess960 random position generator |
| `src/services/lightning.js` | Voltage LND Lightning payments |
| `src/routes/api.js` | All REST API endpoints |
| `src/routes/pages.js` | Page rendering + form POST registration/login |
| `src/views/*.ejs` | All frontend templates |
| `.env` | Config (admin pass, LN creds, base URL) |

## Architecture
```
Player Phone → Website (EJS) → Express API → SQLite (sql.js in-memory + file persist)
                    ↕ Socket.io (real-time)
Venue Screen → /throne (auto-updates)
Admin Phone → /admin (game control)
                    ↕
              Voltage LND (Lightning payouts)
```

## Critical sql.js Gotcha
**NEVER call `save()` before `last_insert_rowid()`** — `db.export()` resets the rowid counter to 0. Pattern:
```js
db.run(`INSERT INTO ...`, [params]);
const result = db.exec(`SELECT last_insert_rowid()`);  // BEFORE save()
const id = result[0].values[0][0];
save();  // AFTER getting the id
return id;
```
