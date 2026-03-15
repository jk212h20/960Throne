# Plan: Position Verification Before Game Start

## Goal
Verify that the physical DGT board matches the intended Chess960 starting position before a game begins.

## Current Flow
1. `callNextChallenger()` picks a Chess960 position from Bitcoin blockhash (with game-count offset)
2. Position is stored in DB immediately at game creation
3. Game auto-starts — no verification that the physical board matches

## Proposed Flow (Soft Verification)

### Server Side (`dgtBoard.js`)
- **New function: `checkPositionMatch(expectedPositionNumber)`**
  - Takes the Chess960 position number (0-959)
  - Generates the expected starting FEN for that position (both ranks 1 and 8)
  - Compares against `currentState.fen` (the live DGT board FEN)
  - Returns `{ matches: true/false, expected: 'fen', actual: 'fen', details: '...' }`
- **Expose in `getState()`** — include `expectedPosition` and `positionMatch` fields so pages can show the status

### Game Engine Integration (`gameEngine.js`)
- After `callNextChallenger()` picks a position and creates the game:
  - Store the expected starting FEN on the game state (already has `chess960_position` number)
  - The DGT board service checks live board vs expected on every `setBoardState()` call
  - Broadcast position match status as part of `dgt_board` events

### Display (`throne.ejs`)
- When a game is active and DGT is connected:
  - Show indicator above/below board:
    - 🟢 **"Board ready — Position #518"** (green) when board matches expected starting position
    - 🔴 **"Set up Position #518: R N B Q K B N R"** (red) when board doesn't match
  - Show the expected piece arrangement visually (small reference diagram)
- The indicator updates live as pieces are moved on the physical board

### Display (`admin.ejs`)
- Same position match indicator in the admin panel's game section
- Admin can see at a glance whether the board is set up correctly

### FEN Comparison Logic
- Chess960 starting position = all pawns on ranks 2/7, specific back rank pieces on ranks 1/8
- Expected FEN for position #518: `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR`
- Compare only piece placement (first part of FEN before the space)
- Case-insensitive comparison isn't needed — FEN uses case for color (uppercase=white, lowercase=black)

### Edge Cases
- **No DGT connected:** Don't show any verification indicator. Games proceed normally.
- **Board partially set up:** Show red indicator with the specific differences
- **Game already in progress:** Stop checking starting position once moves have been made (board won't match starting FEN anymore). Could track "game started" flag.
- **Position reuse on no-show:** Same position stays, verification continues for the next challenger

### Enforcement Level
- **Phase 1 (soft):** Informational only — indicator on screen, games start regardless
- **Phase 2 (hard, future):** `callNextChallenger()` creates the game record but sets a `pending_board_setup` flag. Game clock doesn't start until board matches. Requires a "Board Ready" confirmation (automatic when DGT matches, or manual admin button).

## Files to Modify
| File | Changes |
|------|---------|
| `src/services/chess960.js` | Add `positionToStartingFen(posNumber)` — generates full starting FEN from position number |
| `src/services/dgtBoard.js` | Add `setExpectedPosition(posNumber)`, `checkPositionMatch()`. Include match status in `getState()` and `broadcast()` |
| `src/services/gameEngine.js` | After creating game, call `dgtBoard.setExpectedPosition(posNumber)` |
| `src/views/throne.ejs` | Add position match indicator in the `dgt_board` handler |
| `src/views/admin.ejs` | Add position match indicator |

## Implementation Estimate
~2-3 hours. Mostly logic in chess960.js and dgtBoard.js, plus UI indicators in throne/admin templates.
