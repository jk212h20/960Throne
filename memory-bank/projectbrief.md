# 960 Throne — Project Brief

## Concept
King of the Hill Chess960 — a live event format where a "King" defends their throne against all challengers in speed chess (Chess960/Fischer Random). The King earns **21 satoshis per second** while on the throne. When dethroned, the challenger becomes the new King.

## Event Context
- **Location:** Prospera, Roatán (Honduras)
- **Format:** In-person OTB (over-the-board) chess with digital tracking
- **Time Control:** 3+2 (configurable)
- **Currency:** Bitcoin (Lightning Network satoshis)

## Core Rules
1. The King sits at the board and takes all challengers
2. Challengers queue up digitally (scan QR / enter venue code)
3. Each game uses a random Chess960 starting position
4. King earns 21 sats/sec for entire reign (across multiple games)
5. When King loses → challenger becomes new King, old King collects earned sats
6. When King wins → next challenger steps up, King keeps accumulating
7. Draws → King retains throne, challenger goes to back of queue

## Tech Stack
| Layer | Tech |
|-------|------|
| Server | Node.js + Express |
| Views | EJS templates |
| Styling | Tailwind CSS |
| Real-time | Socket.io |
| Database | SQLite (better-sqlite3) |
| Payments | Lightning Network via Voltage LND |

## Pages
| Route | Purpose |
|-------|---------|
| `/` | Player registration + login |
| `/player` | Player dashboard (stats, balance, queue) |
| `/throne` | Big-screen venue display (projected) |
| `/queue` | Public queue view |
| `/leaderboard` | Stats leaderboard |
| `/admin` | Admin panel (game control, queue mgmt) |
| `/join?code=XXX` | QR code landing for queue join |
| `/game/:id` | Individual game view |

## Sat Economics
- 21 sats/sec ≈ 1,260 sats/min ≈ 75,600 sats/hour
- Players claim earned sats via Lightning invoice
- Prize pool is pre-funded (not entry-fee based)
