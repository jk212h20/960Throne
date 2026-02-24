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

    // Start the on-deck check loop
    setInterval(checkOnDeckTimeout, 5000);

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

    // If no one is on deck and no active game, call next
    const onDeck = db.getOnDeckPlayer();
    const activeGame = db.getActiveGame();
    if (!onDeck && (!activeGame || activeGame.result) && kingId) {
        callNextChallenger();
    }

    return { success: true, queueId, position: queue.length };
}

function leaveQueue(playerId) {
    db.removePlayerFromQueue(playerId);
    broadcast('queue_updated', { queue: db.getQueue() });
    return { success: true };
}

function callNextChallenger() {
    const next = db.getNextInQueue();
    if (!next) {
        broadcast('queue_empty', {});
        return null;
    }

    db.setOnDeck(next.id);
    const timeoutSeconds = parseInt(db.getConfig('queue_timeout_seconds') || '30');

    broadcast('on_deck', {
        player: next,
        timeoutSeconds,
        queue: db.getQueue()
    });

    // Start timeout timer
    if (onDeckTimer) clearTimeout(onDeckTimer);
    onDeckTimer = setTimeout(() => handleOnDeckTimeout(next.id), timeoutSeconds * 1000);

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

    // End any existing reign
    const currentReignId = db.getConfig('current_reign_id');
    if (currentReignId) {
        const reign = db.getReignById(parseInt(currentReignId));
        if (reign && !reign.dethroned_at) {
            const reignSeconds = (Date.now() - new Date(reign.crowned_at).getTime()) / 1000;
            db.endReign(parseInt(currentReignId), reignSeconds, reign.total_sats_earned);
        }
    }

    // Create new reign
    const reignId = db.createReign(playerId);
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
    if (!['king_won', 'challenger_won', 'draw'].includes(result)) {
        return { error: 'Invalid result. Must be king_won, challenger_won, or draw' };
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

    // Calculate sats earned by king during this game
    const gameDuration = gameStartTime ? (Date.now() - gameStartTime) / 1000 : 0;
    const satRate = parseInt(db.getConfig('sat_rate_per_second') || '21');
    const satsEarned = Math.floor(gameDuration * satRate);

    // Finalize the game record
    db.finalizeGame(gameId, result, satsEarned);
    db.setConfig('current_game_id', '');

    // Credit sats to king
    if (satsEarned > 0) {
        db.addSatsToPlayer(game.king_id, satsEarned);
    }

    // Update reign stats
    const reignId = parseInt(db.getConfig('current_reign_id') || '0');
    if (reignId) {
        const reign = db.getReignById(reignId);
        if (reign) {
            db.updateReign(reignId, {
                total_sats_earned: reign.total_sats_earned + satsEarned,
                games_played: reign.games_played + 1,
                consecutive_wins: result === 'king_won' || result === 'draw'
                    ? reign.consecutive_wins + 1
                    : reign.consecutive_wins
            });
        }
    }

    // Update player stats
    const king = db.getPlayerById(game.king_id);
    const challenger = db.getPlayerById(game.challenger_id);

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
        const reign = db.getReignById(reignId);
        if (reign && reign.consecutive_wins > king.longest_win_streak) {
            db.updatePlayerStats(game.king_id, {
                longest_win_streak: reign.consecutive_wins
            });
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
        // Dethrone the king
        if (reignId) {
            const reign = db.getReignById(reignId);
            const totalReignSeconds = (Date.now() - new Date(reign.crowned_at).getTime()) / 1000;
            db.endReign(reignId, totalReignSeconds, reign.total_sats_earned + satsEarned);

            // Update king's total reign time
            db.updatePlayerStats(game.king_id, {
                total_reign_seconds: king.total_reign_seconds + totalReignSeconds,
                longest_reign_seconds: Math.max(king.longest_reign_seconds, totalReignSeconds)
            });
        }

        console.log(`⚔️  ${game.challenger_name} dethroned ${game.king_name}! Earned ${satsEarned} sats.`);
        broadcast('game_ended', gameResult);

        // Crown the challenger as new king
        crownKing(game.challenger_id);
    } else {
        // King stays (won or draw)
        console.log(`👑 ${game.king_name} defends the throne! (${result}) Earned ${satsEarned} sats.`);
        broadcast('game_ended', gameResult);
        gameStartTime = null;

        // Call next challenger
        callNextChallenger();
    }

    return { success: true, ...gameResult };
}

function adminOverrideResult(gameId, result) {
    const game = db.getGameById(gameId);
    if (!game) return { error: 'Game not found' };

    if (game.result) {
        return { error: 'Game already finalized' };
    }

    console.log(`🔧 Admin override: Game #${gameId} → ${result}`);
    return finalizeGameResult(gameId, result);
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

    // Calculate live sat count
    let liveSats = reign ? reign.total_sats_earned : 0;
    if (gameStartTime && game && !game.result) {
        const elapsed = (Date.now() - gameStartTime) / 1000;
        const satRate = parseInt(db.getConfig('sat_rate_per_second') || '21');
        liveSats += Math.floor(elapsed * satRate);
    }

    // Calculate reign duration
    let reignSeconds = 0;
    if (reign && !reign.dethroned_at) {
        reignSeconds = (Date.now() - new Date(reign.crowned_at).getTime()) / 1000;
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
            satRate: parseInt(db.getConfig('sat_rate_per_second') || '21'),
            timeControl: {
                base: parseInt(db.getConfig('time_control_base') || '180'),
                increment: parseInt(db.getConfig('time_control_increment') || '2'),
            },
            queueTimeout: parseInt(db.getConfig('queue_timeout_seconds') || '30'),
        },
        stats: db.getEventStats(),
        recentGames: db.getRecentGames(5),
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
    // State
    getThoneState,
    // Admin
    setEventActive,
    adminRemoveFromQueue,
    adminAddToQueue,
    // Helpers
    broadcast,
    notifyAdmin,
};
