# DGT Board Setup — 960 Throne

## Overview

The DGT board displays the live chess position on the 960 Throne big screen. There are **4 ways** to get data from the board to the server. Pick whichever works.

```
DGT Board → [relay script on venue laptop] → 960 Throne Server → Big Screen
```

## Quick Start (try in order)

### Option 1: LiveChess WebSocket (RECOMMENDED)

**What it is:** DGT LiveChess software reads the board and exposes a local WebSocket API. Our relay script connects to it and pushes positions to the server. **No tournament setup needed — it reads the raw board.**

**Requirements:**
- DGT LiveChess software installed and running on the venue laptop
- DGT board connected via USB to that laptop
- Node.js 18+ on the laptop
- Internet connection

**Steps:**
```bash
# 1. Make sure DGT LiveChess is running and board is connected
#    Check: open http://localhost:1982 in a browser — should show something

# 2. Install ws package (needed for WebSocket)
cd dgt-relay
npm install ws

# 3. Run the relay
node dgt-relay-livechess.js

# That's it! Move a piece on the board — the big screen should update.
```

**If you need to change the server URL or secret:**
```bash
SERVER_URL=https://960throne-production.up.railway.app \
RELAY_SECRET=throne960 \
node dgt-relay-livechess.js
```

---

### Option 2: Direct USB Serial

**What it is:** Bypasses LiveChess entirely. Talks directly to the DGT board over USB serial using the DGT binary protocol.

**When to use:** LiveChess software isn't available, won't install, or isn't cooperating.

**Requirements:**
- DGT board connected via USB (NOT Bluetooth — serial doesn't work over BT)
- Node.js 18+
- LiveChess should NOT be running (it locks the serial port)

**Steps:**
```bash
cd dgt-relay
npm install serialport

# Auto-detects the board
node dgt-relay-serial.js

# Or specify the port manually
SERIAL_PORT=/dev/tty.usbserial-12345 node dgt-relay-serial.js
```

**Finding the serial port:**
- Mac: `ls /dev/tty.usb*`
- Linux: `ls /dev/ttyUSB*`
- Windows: Check Device Manager → Ports (COM & LPT)

---

### Option 3: FEN Manual Input

**What it is:** Type or paste FEN strings manually. Nuclear fallback — always works.

**When to use:** Nothing else works, or you're getting FEN from some other tool.

**Steps:**
```bash
cd dgt-relay
node dgt-relay-fen.js

# Then type FEN strings:
# FEN> rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR
```

**File watch mode** — if any DGT tool can export FEN to a file:
```bash
node dgt-relay-fen.js /path/to/fen-output.txt
# Updates automatically when the file changes
```

**One-shot from command line:**
```bash
echo "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR" | node dgt-relay-fen.js --stdin
```

**curl directly (no Node needed):**
```bash
curl -X POST https://960throne-production.up.railway.app/api/dgt/board-state \
  -H "Content-Type: application/json" \
  -H "x-relay-secret: throne960" \
  -d '{"fen": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR", "source": "manual"}'
```

---

### Option 4: LiveChessCloud (Tournament Mode)

**What it is:** The DGT software streams moves to the cloud. Our server polls their API. Already configured.

**When to use:** The DGT team insists on running their tournament software.

**Downside:** Requires starting a new game/round in DGT software for each game. NOT autopilot.

**Steps:**
1. DGT team creates a tournament in their software
2. Get the tournament ID (UUID from the LiveChessCloud URL)
3. Go to 960 Throne admin panel → set the tournament ID
4. Server polls automatically every 3 seconds

---

## Troubleshooting

### "Is DGT LiveChess running?"
- Open http://localhost:1982 in a browser on the venue laptop
- If it shows a JSON response or web page → LiveChess is running ✅
- If connection refused → start LiveChess software

### "Board not detected"
- Check USB cable is firmly connected
- Try a different USB port
- On Mac: `ls /dev/tty.usb*` should show something
- On Mac: `system_profiler SPUSBDataType` lists USB devices

### "LiveChess shows the board but relay doesn't work"
- The WebSocket API might be on a different port. Try:
  ```bash
  LIVECHESS_URL=ws://localhost:1982/api/v1.0 node dgt-relay-livechess.js
  ```
- Or check LiveChess settings for the API port

### "Serial port locked"
- Close DGT LiveChess — it locks the serial port
- Only one program can use the serial port at a time

### "Server push failed: 401"
- The relay secret doesn't match. Check `RELAY_SECRET` matches the server's `DGT_RELAY_SECRET` or `ADMIN_PASSWORD`

### "Board shows on server but not on big screen"
- Open the throne page: https://960throne-production.up.railway.app/throne
- Check browser console for Socket.io connection errors
- Try refreshing the page

## Authentication

The relay authenticates via the `x-relay-secret` header. By default it uses `throne960`. The server accepts either:
- `DGT_RELAY_SECRET` env var (if set on Railway)
- `ADMIN_PASSWORD` env var (fallback)

## Hardware Info

**DGT 3000** = the chess clock (handles timing, not board reading)
**DGT Smart Board / USB Board** = the actual board with piece sensors (RFID)

The board reads which piece is on which square. The clock is separate — our system doesn't need clock data (the throne tracks game duration independently).
