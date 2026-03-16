# Plan: Live Clock Display from DGT Board — ✅ IMPLEMENTED (needs venue laptop reload)

## Current Status (March 15, 2026)
- **All code is deployed** — relay page extracts clock, server broadcasts it, throne displays it
- **Root cause of "clocks stuck at full time":** The venue laptop running the relay page hadn't been reloaded after the clock code was deployed. It was running old code that only sent board FEN, no clock data.
- **Fix:** Reload the relay page on the venue laptop. The new code subscribes with `clock: true` and has debug logging in the Activity Log.

## Architecture (how clock data flows)

```
DGT Board + Clock → LiveChess Software → Relay Page (dgt-relay.ejs) → POST /api/dgt/board-state → dgtBoard.js → Socket.io 'dgt_board' → throne.ejs
```

### Relay Page (`dgt-relay.ejs`)
- Connects to LiveChess WebSocket at `ws://localhost:1982/api/v1.0`
- Subscribes with `{ board: true, clock: true }` for push events
- Also polls `eboards` every 500ms as fallback
- Tries extracting clock via `extractClockFromBoard()` — supports 4 field name formats
- Logs RAW board object keys on first discovery for debugging
- Pushes `{ fen, clock: { white, black }, source: 'relay-page' }` to server

### Server (`dgtBoard.js`)
- `setBoardState()` stores clock in `currentState.clock`
- Broadcasts via `io.emit('dgt_board', { fen, board, clock, ... })`

### Throne Page (`throne.ejs`)
- Listens for `dgt_board` event, calls `updateClockDisplay(data.clock)`
- Pure pass-through: displays whatever the hardware reports (no local countdown)
- Active/inactive styling based on which clock value changed

### Serial Relay (`dgt-relay-serial.js`) — alternative path
- Uses DGT serial protocol directly (no LiveChess needed)
- UPDATE_NICE mode (0x4b) + explicit DGT_SEND_CLK (0x41) every 1s
- Parses DGT_MSG_BWTIME (0x8d) with BCD decoding
- See `memory-bank/dgt-protocol-reference.md` for protocol details

## Unknown: LiveChess Clock Field Format
We still don't know exactly what field names LiveChess 2.2.9 uses for clock data in the eboards response. The relay page now logs the raw object — check the Activity Log after connecting. The `extractClockFromBoard()` function handles these known formats:
1. `{ clock: { white: 180, black: 180 } }` — seconds as numbers
2. `{ whiteClockMs: 180000, blackClockMs: 180000 }` — milliseconds  
3. `{ wtime: 180, btime: 180 }` — seconds
4. `{ clock: "03:00 / 03:00" }` — string format

If none of these match, the raw log will show what format to add.
