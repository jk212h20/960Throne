# Plan: Live Clock Display from DGT Board — ✅ IMPLEMENTED

## Goal
Show real-time chess clock data from the DGT 3000 clock on `/throne` (big screen) and potentially other pages.

## Current State
- **DGT relay** (`dgt-relay.ejs`) connects to LiveChess WebSocket, polls `eboards` every 500ms
- Relay extracts the FEN from eboards response and pushes to server via `POST /api/dgt/board-state`
- **`dgtBoard.setBoardState()`** already accepts `data.clock` (format: `{ white, black }` in seconds) and stores it in `currentState.clock`
- **`dgt_board` Socket.io event** already includes `clock` in its payload
- **BUT:** The relay page doesn't extract clock data from the eboards response — it only reads the FEN
- **AND:** `/throne` doesn't display clock data even if it receives it

## What DGT LiveChess Provides

The LiveChess eboards response includes board data per connected board. The exact clock fields depend on the LiveChess version, but typically:

```json
{
  "serialnr": "52264",
  "source": "...",
  "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR",
  "clock": { "white": 180, "black": 180 },
  // or sometimes:
  "clock": "03:00 / 03:00",
  // or:
  "whiteClockMs": 180000,
  "blackClockMs": 180000
}
```

**Action needed:** Test what fields the actual DGT 3000 + LiveChess 2.2.9 provides. Add debug logging in the relay page to capture the full board object and inspect clock fields.

## Implementation Plan

### Step 1: Relay Page — Extract Clock Data

**File: `src/views/dgt-relay.ejs`**

In the `handleLiveChessMsg()` function where we extract the FEN from the eboards response, also extract clock data:

```javascript
// After extracting FEN from the board object:
const fen = board.fen || board.board;

// Also extract clock (multiple possible field names)
let clock = null;
if (board.clock && typeof board.clock === 'object') {
    clock = { white: board.clock.white, black: board.clock.black };
} else if (board.whiteClockMs !== undefined) {
    clock = { white: Math.floor(board.whiteClockMs / 1000), black: Math.floor(board.blackClockMs / 1000) };
} else if (board.wtime !== undefined) {
    clock = { white: board.wtime, black: board.btime };
}
```

Then include `clock` in the push to server:
```javascript
body: JSON.stringify({ fen, clock, source: 'relay-page' })
```

Also display clock values on the relay page itself (in the "Server Push Status" card or a new card) for debugging.

### Step 2: Server — Already Handled ✅

`dgtBoard.setBoardState()` already stores clock and includes it in broadcasts. No changes needed.

### Step 3: `/throne` — Display Clock

**File: `src/views/throne.ejs`**

Add clock display elements near the board. In the `dgt_board` Socket.io handler:

```javascript
socket.on('dgt_board', (data) => {
    // ... existing board update code ...
    
    // Update clock display
    if (data.clock) {
        updateClockDisplay(data.clock);
    }
});

function updateClockDisplay(clock) {
    const whiteEl = document.getElementById('dgt-clock-white');
    const blackEl = document.getElementById('dgt-clock-black');
    if (whiteEl) whiteEl.textContent = formatClock(clock.white);
    if (blackEl) blackEl.textContent = formatClock(clock.black);
}

function formatClock(seconds) {
    if (seconds == null) return '--:--';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}
```

**Visual design for `/throne`:**
- Two large clock displays flanking the board (or above it)
- White clock on the left, black clock on the right (matching standard chess layout)
- Active clock has a bright background, inactive clock is dimmed
- Format: `MM:SS` in large monospace font
- Player names above each clock
- Clock elements are created dynamically (like the board) when DGT data arrives

```
┌──────────┐  ┌──────────────────┐  ┌──────────┐
│  ♔ White  │  │                  │  │  ♚ Black  │
│  12:45    │  │    Chess Board   │  │  09:32    │
│  [active] │  │                  │  │           │
└──────────┘  └──────────────────┘  └──────────┘
```

### Step 4: `/game` Player Page — Optional

The player's game page (`game.ejs`) could also show clock data. Less critical since players see the physical clock, but useful for remote spectators. Same Socket.io handler pattern.

### Step 5: Clock on Other Pages

- **`/admin`:** Show clock in the active game section (helpful for admin monitoring)
- **`/throne-live`:** Same as throne but for alternate display layout

## Edge Cases

- **Clock not available:** If LiveChess doesn't provide clock data for this board, clock elements stay hidden or show `--:--`
- **Clock stops:** When game ends, clock stops updating. Last value stays displayed until next game.
- **Turn indicator:** If LiveChess tells us whose turn it is (`turn: 'w'` or `run: 'w'`), highlight the active clock. Otherwise, we can't determine turn from clock alone (both could be counting down).
- **DGT 3000 paused state:** Clock shows `--:--` or 0 when not started. Don't display clock until it has meaningful values (> 0).

## Files to Modify

| File | Changes |
|------|---------|
| `src/views/dgt-relay.ejs` | Extract clock from eboards response, include in server push, show on relay page |
| `src/views/throne.ejs` | Add clock display elements, update from `dgt_board` event |
| `src/views/admin.ejs` | (Optional) Show clock in active game section |

## Dependencies
- Need to test what clock fields the actual DGT 3000 + LiveChess 2.2.9 combination provides
- May need to add a debug mode to the relay page that logs the full raw board object

## Implementation Estimate
~1-2 hours once we know the exact clock field format from LiveChess.
