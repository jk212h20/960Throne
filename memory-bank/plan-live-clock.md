# Plan: Live Clock Display from DGT Board — ✅ WORKING (Web Serial)

## Current Status (March 15, 2026)
- **Working!** Relay page reads DGT board directly via Chrome Web Serial API
- **No LiveChess needed** — Chrome talks to the DGT board over USB serial
- **No installs needed** on venue laptop — just Chrome
- **Clock shows per-second ticks** with correct active side from byte 9 status bits

## Architecture (how clock data flows)

```
DGT Board + Clock → USB Serial → Chrome Web Serial API → Relay Page JS → POST /api/dgt/board-state → dgtBoard.js → Socket.io 'dgt_board' → throne.ejs
```

### Relay Page (`dgt-relay.ejs`) — Web Serial Mode (primary)
- "Connect USB Board" button → `navigator.serial.requestPort()` → user picks port
- Opens at 9600 baud, parses raw DGT protocol bytes in browser JS
- Sends DGT_SEND_BRD (0x42) every 5s, DGT_SEND_CLK (0x41) every 1s
- Enters UPDATE_NICE mode (0x4b) for field updates + clock on change
- Parses DGT_MSG_BWTIME (0x8d) byte 9: D0=running, D3=white turn, D4=black turn
- Sends `{ fen, clock: { white, black, running, activeSide }, source: 'relay-page' }`
- **LiveChess must be QUIT** before connecting (it locks the serial port)

### Server (`dgtBoard.js`)
- `setBoardState()` detects changes in white/black/activeSide/running
- Broadcasts via `io.emit('dgt_board', { fen, board, clock, ... })`

### Throne Page (`throne.ejs`)
- Displays clock values from server, uses `activeSide` for green/gray styling
- `dgt-clock-active` (green) = this clock is ticking
- `dgt-clock-inactive` (gray) = this clock is paused

### LiveChess Fallback (still available, collapsed in UI)
- LiveChess `run` field is just `true/false/null` — no turn info
- Clock values only update on events (clock press), not per-second
- **Not recommended** — Web Serial is strictly better

## Key Learnings
- LiveChess 2.2.9 clock format: `{ white: 180, black: 180, run: true/false/null, time: timestamp }`
- LiveChess `run` field does NOT indicate which side — just boolean running state
- LiveChess subscribe API broken in 2.2.9: "expects 2 arguments, got 3"
- Web Serial API requires Chrome 89+ desktop, HTTPS or localhost
- DGT standard setup: right side (from front) = White, left = Black
