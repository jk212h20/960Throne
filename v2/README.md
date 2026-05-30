# 960 Throne v2

Clean-room/extracted v2 built in `v2/` so the current production app remains intact.

## What is preserved

- Live king-of-the-hill Chess960 event flow.
- First queued player is crowned king.
- King is always black; challenger is white.
- Next challenger auto-starts when possible.
- No-show reuses the same Chess960 position.
- DGT relay endpoint and setup verification.
- Live Socket.io stage display updates.
- Continuous sats accrual for the king.
- Payout ledger with reserve/complete/fail/refund states.
- Admin lock, reset, backup, rotate venue code, crown, result override.

## Current backup of v1 before v2 work

Created before this folder was started:

- Git tag: `pre-v2-rewrite-20260530-010449`
- Backup dir: `backups/pre-v2-20260530-010449`
- DB snapshot: `backups/pre-v2-20260530-010449/throne.db`
- Env snapshot: `backups/pre-v2-20260530-010449/env.snapshot`
- Git bundle: `backups/pre-v2-20260530-010449/repo-4e348ed.bundle`

## Run locally

From repo root:

```bash
PORT=3002 \
DATABASE_PATH=./v2/data/throne-v2.db \
SESSION_SECRET=dev-secret \
ADMIN_PASSWORD=admin-dev \
DGT_RELAY_SECRET=relay-dev \
BOARD_PASSWORD=board-dev \
node v2/src/server.js
```

Then open:

- Stage: <http://localhost:3002/stage>
- Join: <http://localhost:3002/join>
- Admin: <http://localhost:3002/admin>
- Ops: <http://localhost:3002/ops> after admin login
- Health: <http://localhost:3002/api/healthz>

## Test

```bash
node v2/tests/smoke.test.js
```

## DGT relay

Post board state to:

```http
POST /api/dgt/board-state
x-relay-secret: <DGT_RELAY_SECRET>
content-type: application/json

{
  "fen": "... piece placement or full FEN ...",
  "clock": { "white": 180, "black": 180, "running": true, "activeSide": "white" }
}
```

Clock display can be physically swapped with:

```bash
DGT_CLOCK_SWAP_SIDES=true
```

The default is **not swapped**: white clock renders on white challenger side; black clock renders on black king side.

## Production safety

When `NODE_ENV=production`, v2 refuses unsafe missing/default secrets for:

- `ADMIN_PASSWORD`
- `DGT_RELAY_SECRET`
- `BOARD_PASSWORD`
- `SESSION_SECRET`
- `BASE_URL`

## Notes

This is a first extracted v2 scaffold, not yet a full replacement for every v1 feature. Not yet ported:

- Real LNURL-auth UI/crypto flow.
- Real LNURL-withdraw callback and LND payment execution.
- Telegram notifications.
- Multi-board stream operator pages.
- Full styling parity for admin/player pages.

The stage display is intentionally reimagined and ready for visual iteration.
