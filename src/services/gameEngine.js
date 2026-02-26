/**
 * Game Engine — Core logic for 960 Throne
 * Manages throne, queue flow, game lifecycle, sat accumulation
 */

const db = require('./database');
const chess960 = require('./chess960');
const { v4: uuidv4 } = require('uuid');

let io = null; // Socket.io instance, set by index.js
let gameStartTime = null; // When current game started (for sat calculation)
let onDeckTimer = null; // Timer for on-deck timeout
let winnerConfirmTimer = null; // Timer for auto-confirm when only winner reports
let venueCodeTimer = null; // Timer for venue code rotation
let satAccumulatorTimer = null; // Timer for periodic sat persistence
let scheduledResetTimer = null; // Timer for scheduled event reset

/**
 * Initialize the game engine with Socket.io
 */
function init(socketIo) {
    io = socketIo;

    // Resume state if there's an active game
    const activeGame = db.getActiveGame();
    if (activeGame && !activeGame.result) {
        gameStartTime = new Date(activeGame.started_at).getTime();
        console.log('♟️  Resumed active game:', activeGame.id);
    }

    // Start venue code rotation
    startVenueCodeRotation();

    // Clear any stale on-deck entries from before auto-start was implemented
    // (on-deck is no longer used — games auto-start from queue)
    const staleOnDeck = db.getOnDeckPlayer();
    if (staleOnDeck) {
        console.log(`🧹 Clearing stale on-deck entry for ${staleOnDeck.player_name}`);
        db.run ? null : null; // handled below
        // Reset their status back to waiting
        db.resetOnDeckToWaiting();
    }

    // Start the sat accumulator — persists earned sats to DB every 10 seconds
    startSatAccumulator();

    // Resume any scheduled reset from before a restart
    resumeScheduledReset();

    console.log('♟️  Game engine initialized');
}

// ============================================================
// Venue Code Management
// ============================================================

function generateVenueCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No I/O/0/1 for clarity
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

function rotateVenueCode() {
    const rotationMinutes = parseInt(db.getConfig('venue_code_rotation_minutes') || '30');
    const code = generateVenueCode();
    const expiresAt = new Date(Date.now() + rotationMinutes * 60 * 1000).toISOString();
    db.createVenueCode(code, expiresAt);
    console.log(`🔑 New venue code: ${code} (expires in ${rotationMinutes}min)`);
    broadcast('venue_code_updated', { code, expiresAt });
    return code;
}

function startVenueCodeRotation() {
    // Generate initial code if none exists
    const existing = db.getActiveVenueCode();
    if (!existing || (existing.expires_at && new Date(existing.expires_at) < new Date())) {
        rotateVenueCode();
    }

    // Rotate on interval
    const rotationMinutes = parseInt(db.getConfig('venue_code_rotation_minutes') || '30');
    if (venueCodeTimer) clearInterval(venueCodeTimer);
    venueCodeTimer = setInterval(rotateVenueCode, rotationMinutes * 60 * 1000);
}

// ============================================================
// Queue Management
// ============================================================

function joinQueue(playerId) {
    if (db.isPlayerInQueue(playerId)) {
        return { error: 'Already in queue' };
    }

    // Check if player is the current king
    const kingId = db.getConfig('current_king_id');
    if (kingId && parseInt(kingId) === playerId) {
        return { error: "You're the King! You can't queue against yourself." };
    }

    const queueId = db.addToQueue(playerId);
    const queue = db.getQueue();
    broadcast('queue_updated', { queue });

    // If no king, auto-crown the first person in queue
    if (!kingId || kingId === '') {
        const first = db.getNextInQueue();
        if (first) {
            console.log(`👑 Auto-crowning ${first.player_name} (first in queue, no king)`);
            db.removeFromQueue(first.id);
            crownKing(first.player_id);
            return { success: true, queueId, position: queue.length, autoCrowned: first.player_id === playerId };
        }
    }

    // If no active game, auto-start with the next challenger
    const activeGame = db.getActiveGame();
    if ((!activeGame || activeGame.result) && kingId) {
        callNextChallenger();
    }

    return { success: true, queueId, position: queue.length };
}

function leaveQueue(playerId) {
    db.removePlayerFromQueue(playerId);
    broadcast('queue_updated', { queue: db.getQueue() });
    return { success: true };
}

/**
 * Call next challenger and auto-start the game immediately.
 * No admin action needed — optimistically assumes challenger is present.
 * Admin can remove them if they don't show up (keeps same 960 position).
 * 
 * @param {number|null} forcedPosition - If provided, reuse this Chess960 position number
 */
function callNextChallenger(forcedPosition = null) {
    const kingId = parseInt(db.getConfig('current_king_id') || '0');
    if (!kingId) return null;

    // Don't start a new game if one is already active
    const activeGame = db.getActiveGame();
    if (activeGame && !activeGame.result) return null;

    const next = db.getNextInQueue();
    if (!next) {
        broadcast('queue_empty', {});
        return null;
    }

    // Auto-start the game immediately
    const king = db.getPlayerById(kingId);
    const challenger = db.getPlayerById(next.player_id);
    const posNumber = forcedPosition || chess960.randomPositionNumber();
    const position = chess960.positionToDisplay(posNumber);
    const reignId = parseInt(db.getConfig('current_reign_id') || '0');

    // Create game record
    const gameId = db.createGame(kingId, next.player_id, posNumber, reignId);
    db.setConfig('current_game_id', String(gameId));
    gameStartTime = Date.now();

    // Remove challenger from queue
    db.removeFromQueue(next.id);
    broadcast('queue_updated', { queue: db.getQueue() });

    const gameData = {
        gameId,
        king: { id: king.id, name: king.name },
        challenger: { id: challenger.id, name: challenger.name },
        position,
        chess960Position: posNumber,
        startedAt: new Date().toISOString(),
        timeControl: {
            base: parseInt(db.getConfig('time_control_base') || '180'),
            increment: parseInt(db.getConfig('time_control_increment') || '2')
        }
    };

    console.log(`♟️  Auto-started Game #${gameId}: ${king.name} vs ${challenger.name} — Position #${posNumber}`);
    broadcast('game_started', gameData);

    return next;
}

function handleOnDeckTimeout(queueId) {
    const onDeck = db.getOnDeckPlayer();
    if (!onDeck || onDeck.id !== queueId) return; // Already handled

    if (onDeck.timeout_count >= 1) {
        // Second timeout — remove from queue entirely
        db.removeFromQueue(queueId);
        console.log(`⏰ ${onDeck.player_name} removed from queue (2nd timeout)`);
        db.createNotification('timeout_removed', `${onDeck.player_name} removed from queue after 2nd no-show`);
        broadcast('player_removed_timeout', { player: onDeck });
    } else {
        // First timeout — send to back of line
        db.sendToBackOfQueue(queueId);
        console.log(`⏰ ${onDeck.player_name} sent to back of queue (1st timeout)`);
        broadcast('player_timeout_warning', { player: onDeck });
    }

    broadcast('queue_updated', { queue: db.getQueue() });

    // Call next challenger
    callNextChallenger();
}

function checkOnDeckTimeout() {
    const onDeck = db.getOnDeckPlayer();
    if (!onDeck || !onDeck.on_deck_since) return;

    const timeoutSeconds = parseInt(db.getConfig('queue_timeout_seconds') || '30');
    const elapsed = (Date.now() - new Date(onDeck.on_deck_since).getTime()) / 1000;

    if (elapsed >= timeoutSeconds) {
        handleOnDeckTimeout(onDeck.id);
    }
}

// ============================================================
// Throne Management
// ============================================================

function crownKing(playerId) {
    const player = db.getPlayerById(playerId);
    if (!player) return { error: 'Player not found' };

    // End any existing reign — flush sats first to get final accurate count
    // Capture a single timestamp so old reign end and new reign start are identical (no gap/overlap)
    const transitionTime = new Date().toISOString();
    const transitionMs = Date.now();
    const currentReignId = db.getConfig('current_reign_id');
    if (currentReignId) {
        flushAccumulatedSats(); // Ensure DB has latest sats before ending reign
        const reign = db.getReignById(parseInt(currentReignId));
        if (reign && !reign.dethroned_at) {
            const reignSeconds = (transitionMs - new Date(reign.crowned_at).getTime()) / 1000;
            const satRate = parseInt(db.getConfig('sat_rate_per_second') || '21');
            const finalSats = Math.floor(reignSeconds) * satRate;
            // Credit any remaining sats delta not yet flushed
            const satsDelta = finalSats - reign.total_sats_earned;
            if (satsDelta > 0) {
                db.addSatsToPlayer(reign.king_id, satsDelta);
            }
            db.endReign(parseInt(currentReignId), reignSeconds, finalSats, transitionTime);
            // Update the old king's reign time stats
            const oldKing = db.getPlayerById(reign.king_id);
            if (oldKing) {
                db.updatePlayerStats(reign.king_id, {
                    total_reign_seconds: oldKing.total_reign_seconds + reignSeconds,
                    longest_reign_seconds: Math.max(oldKing.longest_reign_seconds, reignSeconds)
                });
            }
        }
    }

    // Create new reign starting at exact same moment old one ended
    const reignId = db.createReign(playerId, transitionTime);
    db.setConfig('current_king_id', String(playerId));
    db.setConfig('current_reign_id', String(reignId));
    db.setConfig('current_game_id', '');

    // Update player stats
    db.updatePlayerStats(playerId, {
        times_as_king: player.times_as_king + 1
    });

    console.log(`👑 ${player.name} is the new King!`);
    broadcast('new_king', {
        king: player,
        reignId,
        crownedAt: new Date().toISOString()
    });

    // Remove new king from queue if they're in it
    db.removePlayerFromQueue(playerId);
    broadcast('queue_updated', { queue: db.getQueue() });

    // Call next challenger
    callNextChallenger();

    return { success: true, reignId };
}

// ============================================================
// Game Lifecycle
// ============================================================

function startGame() {
    const kingId = parseInt(db.getConfig('current_king_id') || '0');
    if (!kingId) return { error: 'No king on the throne' };

    const onDeck = db.getOnDeckPlayer();
    if (!onDeck) return { error: 'No challenger on deck' };

    // Cancel on-deck timer
    if (onDeckTimer) clearTimeout(onDeckTimer);

    const king = db.getPlayerById(kingId);
    const challenger = db.getPlayerById(onDeck.player_id);
    const posNumber = chess960.randomPositionNumber();
    const position = chess960.positionToDisplay(posNumber);
    const reignId = parseInt(db.getConfig('current_reign_id') || '0');

    // Create game record
    const gameId = db.createGame(kingId, onDeck.player_id, posNumber, reignId);
    db.setConfig('current_game_id', String(gameId));
    gameStartTime = Date.now();

    // Remove challenger from queue
    db.removeFromQueue(onDeck.id);
    broadcast('queue_updated', { queue: db.getQueue() });

    const gameData = {
        gameId,
        king: { id: king.id, name: king.name },
        challenger: { id: challenger.id, name: challenger.name },
        position,
        startedAt: new Date().toISOString(),
        timeControl: {
            base: parseInt(db.getConfig('time_control_base') || '180'),
            increment: parseInt(db.getConfig('time_control_increment') || '2')
        }
    };

    console.log(`♟️  Game #${gameId}: ${king.name} (King) vs ${challenger.name} — Position #${posNumber}`);
    broadcast('game_started', gameData);

    return { success: true, ...gameData };
}

function reportResult(playerId, result) {
    const gameId = parseInt(db.getConfig('current_game_id') || '0');
    if (!gameId) return { error: 'No active game' };

    const game = db.getActiveGame();
    if (!game) return { error: 'Game not found' };
    if (game.result) return { error: 'Game already finalized' };

    // Validate reporter is in this game
    if (playerId !== game.king_id && playerId !== game.challenger_id) {
        return { error: 'You are not in this game' };
    }

    // Validate result value
    if (!['king_won', 'challenger_won', 'draw', 'no_show'].includes(result)) {
        return { error: 'Invalid result. Must be king_won, challenger_won, draw, or no_show' };
    }

    // no_show is like king_won but doesn't count as a game played
    if (result === 'no_show') {
        return finalizeGameResult(gameId, 'no_show');
    }

    // Record the report
    const updatedGame = db.reportGameResult(gameId, playerId, result);

    // Determine if we can finalize
    const isKingReport = playerId === game.king_id;
    const isChallengerReport = playerId === game.challenger_id;

    // The LOSER's report is definitive
    const reporterClaimsToLose = (isKingReport && result === 'challenger_won') ||
        (isChallengerReport && result === 'king_won');

    // Draw reports: both must agree, or loser can report draw
    const isDrawReport = result === 'draw';

    // Check if both have reported
    const bothReported = updatedGame.king_reported && updatedGame.challenger_reported;

    let shouldFinalize = false;
    let finalResult = null;

    if (reporterClaimsToLose) {
        // Loser's report is definitive — finalize immediately
        shouldFinalize = true;
        finalResult = result;
    } else if (bothReported) {
        // Both reported — check for agreement
        if (updatedGame.king_reported === updatedGame.challenger_reported) {
            shouldFinalize = true;
            finalResult = updatedGame.king_reported;
        } else {
            // Conflict! Notify admin
            db.createNotification('result_conflict',
                `Game #${gameId}: King reported "${updatedGame.king_reported}" but Challenger reported "${updatedGame.challenger_reported}"`,
                gameId);
            broadcast('result_conflict', { gameId, game: updatedGame });
            notifyAdmin(`⚠️ Result conflict in Game #${gameId}! King: ${updatedGame.king_reported}, Challenger: ${updatedGame.challenger_reported}`);
            return { success: true, status: 'conflict', message: 'Results conflict. Admin has been notified.' };
        }
    } else if (isDrawReport) {
        // Only one side reported draw — wait for the other
        broadcast('result_pending', { gameId, waitingFor: isKingReport ? 'challenger' : 'king' });
        return { success: true, status: 'pending', message: 'Waiting for opponent to confirm draw.' };
    } else {
        // Winner reported — start auto-confirm timer
        const delay = parseInt(db.getConfig('winner_only_confirm_delay') || '60');
        if (winnerConfirmTimer) clearTimeout(winnerConfirmTimer);
        winnerConfirmTimer = setTimeout(() => {
            autoConfirmResult(gameId, result);
        }, delay * 1000);

        db.createNotification('winner_only_report',
            `Game #${gameId}: Only ${isKingReport ? 'King' : 'Challenger'} reported "${result}". Auto-confirming in ${delay}s.`,
            gameId);

        broadcast('result_pending', {
            gameId,
            reported: result,
            reportedBy: isKingReport ? 'king' : 'challenger',
            autoConfirmIn: delay
        });

        return { success: true, status: 'pending', message: `Waiting for opponent (auto-confirm in ${delay}s).` };
    }

    if (shouldFinalize) {
        return finalizeGameResult(gameId, finalResult);
    }

    return { success: true, status: 'recorded' };
}

function autoConfirmResult(gameId, result) {
    const game = db.getGameById(gameId);
    if (!game || game.result) return; // Already finalized

    console.log(`⏰ Auto-confirming Game #${gameId} result: ${result}`);
    db.createNotification('auto_confirmed',
        `Game #${gameId} auto-confirmed as "${result}" (only winner reported)`,
        gameId);
    notifyAdmin(`⏰ Game #${gameId} auto-confirmed: ${result}`);
    finalizeGameResult(gameId, result);
}

function finalizeGameResult(gameId, result) {
    if (winnerConfirmTimer) clearTimeout(winnerConfirmTimer);

    const game = db.getGameById(gameId);
    if (!game) return { error: 'Game not found' };

    // Flush accumulated sats before finalizing (ensures DB is up to date)
    flushAccumulatedSats();

    // Calculate game duration for record keeping
    const gameDuration = gameStartTime ? (Date.now() - gameStartTime) / 1000 : 0;

    // Get current reign sats for the game record (sats are accumulated continuously, not per-game)
    const reignId = parseInt(db.getConfig('current_reign_id') || '0');
    const reign = reignId ? db.getReignById(reignId) : null;
    const satsEarned = reign ? reign.total_sats_earned : 0;

    // Finalize the game record (sats_earned = total reign sats at time of game end, for record)
    const satRate = parseInt(db.getConfig('sat_rate_per_second') || '21');
    const gameSats = Math.floor(gameDuration) * satRate;
    db.finalizeGame(gameId, result, gameSats);
    db.setConfig('current_game_id', '');

    // no_show: doesn't count as a game played, king streak continues, just clears the game
    const isNoShow = result === 'no_show';

    // Update reign stats (games played, win streak — sats are handled by accumulator)
    if (reignId && reign && !isNoShow) {
        db.updateReign(reignId, {
            games_played: reign.games_played + 1,
            consecutive_wins: result === 'king_won' || result === 'draw'
                ? reign.consecutive_wins + 1
                : reign.consecutive_wins
        });
    }

    // Update player stats (skip for no_show — doesn't count as a real game)
    const king = db.getPlayerById(game.king_id);
    const challenger = db.getPlayerById(game.challenger_id);

    if (!isNoShow) {
        if (result === 'king_won') {
            db.updatePlayerStats(game.king_id, {
                games_played: king.games_played + 1,
                games_won: king.games_won + 1,
            });
            db.updatePlayerStats(game.challenger_id, {
                games_played: challenger.games_played + 1,
                games_lost: challenger.games_lost + 1,
            });
        } else if (result === 'challenger_won') {
            db.updatePlayerStats(game.king_id, {
                games_played: king.games_played + 1,
                games_lost: king.games_lost + 1,
            });
            db.updatePlayerStats(game.challenger_id, {
                games_played: challenger.games_played + 1,
                games_won: challenger.games_won + 1,
            });
        } else if (result === 'draw') {
            db.updatePlayerStats(game.king_id, {
                games_played: king.games_played + 1,
                games_drawn: king.games_drawn + 1,
            });
            db.updatePlayerStats(game.challenger_id, {
                games_played: challenger.games_played + 1,
                games_drawn: challenger.games_drawn + 1,
            });
        }

        // Update longest win streak for king
        if (reignId && (result === 'king_won' || result === 'draw')) {
            const updatedReign = db.getReignById(reignId);
            if (updatedReign && updatedReign.consecutive_wins > king.longest_win_streak) {
                db.updatePlayerStats(game.king_id, {
                    longest_win_streak: updatedReign.consecutive_wins
                });
            }
        }
    }

    const gameResult = {
        gameId,
        result,
        satsEarned,
        gameDuration: Math.floor(gameDuration),
        king: { id: game.king_id, name: game.king_name },
        challenger: { id: game.challenger_id, name: game.challenger_name },
    };

    // Handle throne transition
    if (result === 'challenger_won') {
        // crownKing() handles ending the old reign (with proper sat finalization)
        console.log(`⚔️  ${game.challenger_name} dethroned ${game.king_name}! Earned ${satsEarned} sats this reign.`);
        broadcast('game_ended', gameResult);

        // Crown the challenger as new king (this ends the old reign internally)
        crownKing(game.challenger_id);
    } else if (result === 'no_show') {
        // No-show — king stays, same position for next challenger
        console.log(`🚫 ${game.challenger_name} no-show vs ${game.king_name}. Position #${game.chess960_position} reused.`);
        broadcast('game_ended', gameResult);
        gameStartTime = null;

        // Call next challenger with the SAME position
        callNextChallenger(game.chess960_position);
    } else {
        // King stays (won or draw)
        console.log(`👑 ${game.king_name} defends the throne! (${result}) Earned ${satsEarned} sats.`);
        broadcast('game_ended', gameResult);
        gameStartTime = null;

        // Call next challenger (new random position)
        callNextChallenger();
    }

    return { success: true, ...gameResult };
}

function adminOverrideResult(gameId, result) {
    const game = db.getGameById(gameId);
    if (!game) return { error: 'Game not found' };

    if (game.result) {
        return { error: 'Game already finalized. Use "Undo Last Game" to reverse it.' };
    }

    console.log(`🔧 Admin override: Game #${gameId} → ${result}`);
    return finalizeGameResult(gameId, result);
}

/**
 * Undo a finalized game — reverses all stat changes and restores the previous king.
 * Use case: king misclicked a loss, admin needs to fix it.
 */
function adminUndoGame(gameId) {
    const game = db.getGameById(gameId);
    if (!game) return { error: 'Game not found' };
    if (!game.result) return { error: 'Game is not finalized yet' };

    const king = db.getPlayerById(game.king_id);
    const challenger = db.getPlayerById(game.challenger_id);
    if (!king || !challenger) return { error: 'Players not found' };

    // Reverse player stats
    if (game.result === 'king_won') {
        db.updatePlayerStats(game.king_id, {
            games_played: king.games_played - 1,
            games_won: king.games_won - 1,
        });
        db.updatePlayerStats(game.challenger_id, {
            games_played: challenger.games_played - 1,
            games_lost: challenger.games_lost - 1,
        });
    } else if (game.result === 'challenger_won') {
        db.updatePlayerStats(game.king_id, {
            games_played: king.games_played - 1,
            games_lost: king.games_lost - 1,
        });
        db.updatePlayerStats(game.challenger_id, {
            games_played: challenger.games_played - 1,
            games_won: challenger.games_won - 1,
        });
    } else if (game.result === 'draw') {
        db.updatePlayerStats(game.king_id, {
            games_played: king.games_played - 1,
            games_drawn: king.games_drawn - 1,
        });
        db.updatePlayerStats(game.challenger_id, {
            games_played: challenger.games_played - 1,
            games_drawn: challenger.games_drawn - 1,
        });
    }

    // Reverse sats credited to the king
    if (game.sats_earned > 0) {
        db.addSatsToPlayer(game.king_id, -game.sats_earned); // negative to subtract
    }

    // Clear the game result (mark it as undone)
    db.finalizeGame(gameId, null, 0);

    // If the challenger was crowned (challenger_won), we need to restore the original king
    if (game.result === 'challenger_won') {
        // End the challenger's reign that was created after this game
        const currentReignId = db.getConfig('current_reign_id');
        if (currentReignId) {
            const currentReign = db.getReignById(parseInt(currentReignId));
            if (currentReign && currentReign.king_id === game.challenger_id) {
                db.endReign(parseInt(currentReignId), 0, 0);
            }
        }

        // Restore the original king — re-crown them
        crownKing(game.king_id);
        console.log(`🔧 Admin undo: Restored ${king.name} as King (game #${gameId} reversed)`);
    } else {
        // King stayed on throne — just clear the game state
        db.setConfig('current_game_id', '');
        console.log(`🔧 Admin undo: Game #${gameId} reversed (${king.name} still King)`);
    }

    broadcast('game_undone', { gameId, originalResult: game.result });
    db.createNotification('game_undone', `Game #${gameId} was undone by admin (was: ${game.result})`, gameId);

    return { success: true, message: `Game #${gameId} undone. ${game.result === 'challenger_won' ? king.name + ' restored as King.' : 'King unchanged.'}` };
}

/**
 * Admin sets a specific player as the challenger, bypassing the queue.
 * If there's an active game, marks it as no_show first (keeps position).
 * Then creates a new game with this player as challenger.
 */
function adminSetChallenger(playerId) {
    const player = db.getPlayerById(playerId);
    if (!player) return { error: 'Player not found' };

    const kingId = db.getConfig('current_king_id');
    if (!kingId) return { error: 'No king on the throne' };
    if (parseInt(kingId) === playerId) {
        return { error: "Can't set the King as their own challenger" };
    }

    // If there's an active game, finalize it as no_show first
    const activeGame = db.getActiveGame();
    if (activeGame && !activeGame.result) {
        finalizeGameResult(activeGame.id, 'no_show');
    }

    // If the player is already in queue, remove them first
    if (db.isPlayerInQueue(playerId)) {
        db.removePlayerFromQueue(playerId);
    }

    // Add them to front of queue, then callNextChallenger will pick them up
    const queueId = db.addToQueue(playerId);
    // Move them to position 1 so they're next
    db.moveToFrontOfQueue(queueId);

    // Now call next challenger — this will auto-start the game
    callNextChallenger();

    console.log(`🔧 Admin set ${player.name} as challenger (game auto-started)`);
    return { success: true, message: `${player.name} set as challenger — game started` };
}

/**
 * Admin removes the current challenger from an active game.
 * The game is recorded as no_show (doesn't count as a real game).
 * The same Chess960 position is reused for the next challenger.
 */
function adminRemoveChallenger() {
    const gameId = parseInt(db.getConfig('current_game_id') || '0');
    if (!gameId) return { error: 'No active game' };

    const game = db.getActiveGame();
    if (!game) return { error: 'Game not found' };
    if (game.result) return { error: 'Game already finalized' };

    console.log(`🔧 Admin removing challenger ${game.challenger_name} from Game #${gameId}`);
    
    // Finalize as no_show — this keeps the position and calls next challenger
    return finalizeGameResult(gameId, 'no_show');
}

// ============================================================
// Sat Accumulation — Continuous while king is on the throne
// ============================================================

/**
 * Periodically flush accumulated sats to the database so they persist
 * across page reloads and server restarts. Runs every 10 seconds.
 * 
 * Sats accumulate continuously from the moment a king is crowned,
 * NOT just during active games.
 */
function startSatAccumulator() {
    if (satAccumulatorTimer) clearInterval(satAccumulatorTimer);
    satAccumulatorTimer = setInterval(flushAccumulatedSats, 10000);
}

function flushAccumulatedSats() {
    const reignId = db.getConfig('current_reign_id');
    const kingId = db.getConfig('current_king_id');
    if (!reignId || !kingId) return;

    const reign = db.getReignById(parseInt(reignId));
    if (!reign || reign.dethroned_at) return;

    // Calculate total sats earned since crowned — whole seconds only, no fractional rounding
    const reignSeconds = (Date.now() - new Date(reign.crowned_at).getTime()) / 1000;
    const satRate = parseInt(db.getConfig('sat_rate_per_second') || '21');
    const totalSatsNow = Math.floor(reignSeconds) * satRate;

    // Only update if sats increased (avoid unnecessary writes)
    if (totalSatsNow > reign.total_sats_earned) {
        const satsDelta = totalSatsNow - reign.total_sats_earned;

        // Update reign record
        db.updateReign(parseInt(reignId), {
            total_sats_earned: totalSatsNow
        });

        // Credit the delta to the king's balance and total
        db.addSatsToPlayer(parseInt(kingId), satsDelta);
    }
}

// ============================================================
// State Queries
// ============================================================

function getThoneState() {
    const kingId = db.getConfig('current_king_id');
    const reignId = db.getConfig('current_reign_id');
    const gameId = db.getConfig('current_game_id');
    const eventActive = db.getConfig('event_active') === 'true';

    const king = kingId ? db.getPlayerById(parseInt(kingId)) : null;
    const reign = reignId ? db.getReignById(parseInt(reignId)) : null;
    const game = gameId ? db.getGameById(parseInt(gameId)) : null;
    const queue = db.getQueue();
    const onDeck = db.getOnDeckPlayer();

    const satRate = parseInt(db.getConfig('sat_rate_per_second') || '21');

    // Calculate live sat count — sats accumulate from the moment of crowning
    let liveSats = 0;
    let reignSeconds = 0;
    if (reign && !reign.dethroned_at) {
        reignSeconds = (Date.now() - new Date(reign.crowned_at).getTime()) / 1000;
        liveSats = Math.floor(reignSeconds) * satRate;
    }

    return {
        eventActive,
        king,
        reign,
        reignSeconds: Math.floor(reignSeconds),
        liveSats,
        game: game && !game.result ? {
            ...game,
            position: chess960.positionToDisplay(game.chess960_position),
            elapsed: gameStartTime ? Math.floor((Date.now() - gameStartTime) / 1000) : 0,
        } : null,
        queue,
        onDeck,
        config: {
            satRate,
            timeControl: {
                base: parseInt(db.getConfig('time_control_base') || '180'),
                increment: parseInt(db.getConfig('time_control_increment') || '2'),
            },
            queueTimeout: parseInt(db.getConfig('queue_timeout_seconds') || '30'),
        },
        stats: db.getEventStats(),
        recentGames: db.getRecentGames(5),
        venueCode: db.getActiveVenueCode(),
        baseUrl: process.env.BASE_URL || 'http://localhost:3000',
    };
}

// ============================================================
// Admin Controls
// ============================================================

function setEventActive(active) {
    db.setConfig('event_active', active ? 'true' : 'false');
    broadcast('event_status', { active });
    if (active) {
        startVenueCodeRotation();
    }
}

function adminRemoveFromQueue(playerId) {
    db.removePlayerFromQueue(playerId);
    broadcast('queue_updated', { queue: db.getQueue() });
}

function adminAddToQueue(playerId) {
    return joinQueue(playerId);
}

// ============================================================
// Scheduled Reset — Admin sets a future time for a clean slate
// ============================================================

/**
 * Schedule an event data reset at a specific ISO time.
 * Backs up DB before reset, then clears all stats/games/reigns.
 * Stores the scheduled time in config so it persists across restarts.
 */
function scheduleReset(isoTime) {
    const resetTime = new Date(isoTime).getTime();
    const now = Date.now();
    if (resetTime <= now) return { error: 'Reset time must be in the future' };

    // Store in config (persists across server restarts)
    db.setConfig('scheduled_reset_at', isoTime);
    
    // Set the timer
    if (scheduledResetTimer) clearTimeout(scheduledResetTimer);
    const delay = resetTime - now;
    scheduledResetTimer = setTimeout(executeScheduledReset, delay);

    console.log(`⏰ Event reset scheduled for ${isoTime} (in ${Math.round(delay / 1000)}s)`);
    notifyAdmin(`⏰ Event reset scheduled for ${new Date(isoTime).toLocaleString()}`);
    broadcast('reset_scheduled', { resetAt: isoTime });

    return { success: true, resetAt: isoTime, inSeconds: Math.round(delay / 1000) };
}

function cancelReset() {
    if (scheduledResetTimer) {
        clearTimeout(scheduledResetTimer);
        scheduledResetTimer = null;
    }
    db.setConfig('scheduled_reset_at', '');
    console.log('❌ Scheduled reset cancelled');
    broadcast('reset_cancelled', {});
    return { success: true, message: 'Scheduled reset cancelled' };
}

function executeScheduledReset() {
    console.log('🧹 Executing scheduled event reset...');
    
    // Flush any accumulated sats first
    flushAccumulatedSats();
    
    // Backup the database before reset
    const backupPath = db.backupDatabase('pre-reset');
    
    // End any active reign cleanly
    const currentReignId = db.getConfig('current_reign_id');
    if (currentReignId) {
        const reign = db.getReignById(parseInt(currentReignId));
        if (reign && !reign.dethroned_at) {
            const reignSeconds = (Date.now() - new Date(reign.crowned_at).getTime()) / 1000;
            const satRate = parseInt(db.getConfig('sat_rate_per_second') || '21');
            const finalSats = Math.floor(reignSeconds) * satRate;
            const satsDelta = finalSats - reign.total_sats_earned;
            if (satsDelta > 0) db.addSatsToPlayer(reign.king_id, satsDelta);
            db.endReign(parseInt(currentReignId), reignSeconds, finalSats);
        }
    }
    
    // Reset all event data
    db.resetEventData();
    
    // Clear the scheduled time
    db.setConfig('scheduled_reset_at', '');
    scheduledResetTimer = null;
    gameStartTime = null;
    
    console.log(`🧹 Reset complete. Backup saved at: ${backupPath}`);
    notifyAdmin(`🧹 Event data has been reset! Backup saved. All stats, sats, and games cleared.`);
    broadcast('event_reset', { backupPath });
}

/**
 * Get info about scheduled reset (for admin UI)
 */
function getScheduledReset() {
    const resetAt = db.getConfig('scheduled_reset_at');
    if (!resetAt) return null;
    const resetTime = new Date(resetAt).getTime();
    if (resetTime <= Date.now()) {
        // Past due — clear it
        db.setConfig('scheduled_reset_at', '');
        return null;
    }
    return { resetAt, inSeconds: Math.round((resetTime - Date.now()) / 1000) };
}

/**
 * Resume a scheduled reset timer on server startup (if one was set)
 */
function resumeScheduledReset() {
    const resetAt = db.getConfig('scheduled_reset_at');
    if (!resetAt) return;
    const resetTime = new Date(resetAt).getTime();
    const now = Date.now();
    if (resetTime <= now) {
        // It was supposed to fire while server was down — execute now
        console.log('⏰ Executing overdue scheduled reset...');
        executeScheduledReset();
    } else {
        const delay = resetTime - now;
        scheduledResetTimer = setTimeout(executeScheduledReset, delay);
        console.log(`⏰ Resuming scheduled reset for ${resetAt} (in ${Math.round(delay / 1000)}s)`);
    }
}

// ============================================================
// Helpers
// ============================================================

function broadcast(event, data) {
    if (io) {
        io.emit(event, data);
    }
}

function notifyAdmin(message) {
    // Telegram notification if configured
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (botToken && chatId) {
        fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: `🏰 960 Throne: ${message}` })
        }).catch(err => console.warn('Telegram notification failed:', err.message));
    }
}

module.exports = {
    init,
    // Venue
    rotateVenueCode,
    // Queue
    joinQueue,
    leaveQueue,
    callNextChallenger,
    // Throne
    crownKing,
    // Game
    startGame,
    reportResult,
    adminOverrideResult,
    adminUndoGame,
    adminSetChallenger,
    adminRemoveChallenger,
    // State
    getThoneState,
    // Admin
    setEventActive,
    adminRemoveFromQueue,
    adminAddToQueue,
    // Scheduled Reset
    scheduleReset,
    cancelReset,
    getScheduledReset,
    // Sat accounting
    flushAccumulatedSats,
    // Helpers
    broadcast,
    notifyAdmin,
};
