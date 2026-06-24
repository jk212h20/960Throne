# 960 Throne v2 Deploy Checklist

## Required production environment

- `NODE_ENV=production`
- `PORT` set by host/Railway
- `BASE_URL=https://<real-public-domain>`
- `DATABASE_PATH=/app/data/throne.db` (existing persisted v1 DB)
- `ADMIN_PASSWORD=<strong existing admin password>`
- `SESSION_SECRET=<strong random secret>`
- `DGT_RELAY_SECRET=<strong relay secret>`
- `BOARD_PASSWORD=<strong board/operator password>`

Do not use the v2 default DB path in production unless intentionally starting blank:

- Bad for continuity: `v2/data/throne-v2.db`
- Good for continuity: `/app/data/throne.db`

## Start command

Preferred while migrating:

```bash
npm run start:v2
```

This keeps root `npm start` as v1 until the final cutover decision.

## Pre-cutover checks

1. Back up the production DB from the Railway volume.
2. Confirm v2 can boot against a copy of the production DB.
3. Confirm `/api/healthz` returns 200.
4. Confirm unauthenticated `/admin` shows only login.
5. Confirm admin login works with the existing password.
6. Confirm `/api/auth/lightning` LNURL decodes to the production `BASE_URL`, not localhost.
7. Confirm returning Lightning player can log in and keeps name.
8. Confirm claimable balances are visible.
9. Click admin Backup before event reset.
10. Run admin Reset Event to clear this-event counters while preserving balances.
11. Confirm `/leaderboard` starts clean/zeroed for the event.
12. Test two-wallet join flow.
13. Test pause/resume next-game gate.
14. Test DGT relay with actual eBoard hardware.

## Event reset behavior

v2 reset clears:

- queue
- games
- reigns
- admin notifications
- current king/game/reign config
- this-event player counters (`total_sats_earned`, W/L/D, reign stats)

v2 reset preserves:

- players
- Lightning auth identities
- names
- claimable `sat_balance`
- `reserved_sats`
- `total_sats_claimed`
- payout history

## Payout mode for this event

Automatic LND/LNURL-withdraw payout execution is not yet ported to v2. Current v2 supports manual admin payout accounting:

- reserve payout
- mark complete
- mark failed/refunded
- mark manual payout paid

Use manual payout operations unless/until full LND payment execution is ported and tested.
