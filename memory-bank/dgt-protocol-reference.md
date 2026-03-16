# DGT Protocol Reference (from dgt3000spec.txt)

## Communication Modes
| Mode | Command | Hex | Behavior |
|------|---------|-----|----------|
| IDLE | `DGT_SEND_RESET` | 0x40 | No automatic transfer |
| UPDATE | `DGT_SEND_UPDATE` | 0x43 | Field updates + clock every second |
| UPDATE_BOARD | `DGT_SEND_UPDATE_BRD` | 0x44 | Field updates only (NO clock) |
| UPDATE_NICE | `DGT_SEND_UPDATE_NICE` | 0x4b | Field updates + clock **only when changed** |

## Key Commands (PC → Board)
| Command | Hex | Response |
|---------|-----|----------|
| `DGT_SEND_CLK` | 0x41 | `DGT_MSG_BWTIME` (clock data) |
| `DGT_SEND_BRD` | 0x42 | `DGT_MSG_BOARD_DUMP` (64 squares) |

## Response Messages (Board → PC)
All have MSB set (0x80 OR'd with ID).

| Message | Hex | Size | Content |
|---------|-----|------|---------|
| `DGT_MSG_BOARD_DUMP` | 0x86 | 67 bytes | 3 header + 64 piece bytes |
| `DGT_MSG_BWTIME` | 0x8d | 10 bytes | Clock times for both players |
| `DGT_MSG_FIELD_UPDATE` | 0x8e | 5 bytes | Single square change |

## DGT_MSG_BWTIME Format (Clock Data)
```
byte 3: Right player hours (BCD, D0-D3) + flags (D4-D6)
  D4: flag fallen + blocked, D5: Fischer indicator, D6: flag fallen + running
  If (byte3 & 0x0f) == 0x0a → Clock Ack, NOT time data
byte 4: Right player minutes (BCD)
byte 5: Right player seconds (BCD)
byte 6: Left player hours (same format as byte 3)
byte 7: Left player minutes (BCD)
byte 8: Left player seconds (BCD)
byte 9: Status
  D0: clock running
  D1: tumbler position (1=right high)
  D3: right player's turn
  D4: left player's turn
  D5: NO clock connected (1=invalid reading)
```

**Left/Right = from FRONT of clock.** Standard setup: Right = White, Left = Black.

**BCD encoding:** High nibble = tens, low nibble = units. e.g. 0x35 = 35 minutes.

**Clock Ack vs Time:** If `(byte3 & 0x0f) == 0x0a` or `(byte6 & 0x0f) == 0x0a`, it's an ack response to a clock command, not actual time data. Ignore these.

## Message Length Encoding
2 bytes, 7-bit each: `length = (byte1 & 0x7f) << 7 | (byte2 & 0x7f)`

## Piece Codes
```
0x00=empty, 0x01=wP, 0x02=wR, 0x03=wN, 0x04=wB, 0x05=wK, 0x06=wQ
0x07=bP, 0x08=bR, 0x09=bN, 0x0A=bB, 0x0B=bK, 0x0C=bQ
```

## Board Square Numbering
Field 0 = a8 (top-left), Field 63 = h1 (bottom-right). Row by row, left to right.

## Our Implementation
- **Serial relay** (`dgt-relay-serial.js`): Uses UPDATE_NICE mode + periodic `DGT_SEND_CLK` every 1s
- **LiveChess relay** (`dgt-relay.ejs`): Polls eboards via WebSocket (LiveChess abstracts the serial protocol). Clock fields in eboards response may vary by LiveChess version.
- **Key insight**: `DGT_SEND_BRD` (0x42) only returns board data. Clock requires either UPDATE/UPDATE_NICE mode or explicit `DGT_SEND_CLK` (0x41).
