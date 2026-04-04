'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');
const Rules = require('./game/Rules');

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const app = express();
const httpServer = http.createServer(app);

app.use(cors());
app.use(express.json());

// Serve client static files
const clientDir = path.join(__dirname, '..', 'client');
app.use('/src', express.static(path.join(clientDir, 'src')));
app.use('/public', express.static(path.join(clientDir, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(clientDir, 'public', 'index.html')));

const io = new Server(httpServer, {
  cors: { origin: '*' },
});

const PORT = process.env.PORT || 3001;
const rules = new Rules();

// Maps socketId → roomCode so clients never need to send the room code
const socketToRoom = new Map();

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get('/health', (req, res) => {
  res.json({ status: 'ok', rooms: rules.rooms.size });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Broadcast the current game state to every player in the room,
 * sending each their personalised perspective (own resources + cards).
 */
function broadcastGameState(roomCode) {
  const room = rules.getRoom(roomCode);
  if (!room || !room.gameState) return;

  for (const playerDef of room.playerDefs) {
    const publicState = room.gameState.toPublicState(playerDef.id);
    io.to(playerDef.socketId).emit('game_state_update', { gameState: publicState });
  }
}

/**
 * Send an error to a single socket.
 */
function sendError(socket, message) {
  socket.emit('error', { message });
}

/**
 * Find room + validate player is in it.
 * Returns { room, gameState, player } or emits error and returns null.
 */
function getRoomContext(socket) {
  const roomCode = socketToRoom.get(socket.id);
  if (!roomCode) {
    sendError(socket, 'You are not in a room.');
    return null;
  }
  const room = rules.getRoom(roomCode);
  if (!room) {
    sendError(socket, 'Room not found.');
    return null;
  }
  const playerDef = room.playerDefs.find(p => p.socketId === socket.id);
  if (!playerDef) {
    sendError(socket, 'You are not in this room.');
    return null;
  }
  return { room, roomCode, gameState: room.gameState, playerDef };
}

// ---------------------------------------------------------------------------
// Socket events
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  // -------------------------------------------------------------------------
  // create_room
  // -------------------------------------------------------------------------
  socket.on('create_room', ({ playerName, color } = {}) => {
    const result = rules.createRoom(playerName, color, socket.id);
    if (result.error) return sendError(socket, result.error);

    socket.join(result.roomCode);
    socketToRoom.set(socket.id, result.roomCode);
    socket.emit('room_created', { roomCode: result.roomCode, playerId: result.playerId });
    console.log(`[room_created] ${result.roomCode} by ${playerName}`);
  });

  // -------------------------------------------------------------------------
  // join_room
  // -------------------------------------------------------------------------
  socket.on('join_room', ({ roomCode: joinRoomCode, playerName, color } = {}) => {
    const result = rules.joinRoom(joinRoomCode, playerName, color, socket.id);
    if (result.error) return sendError(socket, result.error);

    socket.join(joinRoomCode);
    socketToRoom.set(socket.id, joinRoomCode);

    // Send the joining player their own playerId
    socket.emit('room_joined', {
      players: result.players,
      roomCode: result.roomCode,
      playerId: result.playerId,
    });

    // Tell everyone else in the room about the updated player list (no playerId)
    socket.to(joinRoomCode).emit('room_joined', {
      players: result.players,
      roomCode: result.roomCode,
    });

    console.log(`[room_joined] ${playerName} → ${joinRoomCode}`);
  });

  // -------------------------------------------------------------------------
  // start_game
  // -------------------------------------------------------------------------
  socket.on('start_game', () => {
    const ctx = getRoomContext(socket);
    if (!ctx) return;

    const { roomCode } = ctx;
    const result = rules.startGame(roomCode, socket.id);
    if (result.error) return sendError(socket, result.error);

    const room = rules.getRoom(roomCode);

    // Send each player their personal view of the initial game state
    for (const playerDef of room.playerDefs) {
      const publicState = result.gameState.toPublicState(playerDef.id);
      io.to(playerDef.socketId).emit('game_started', { gameState: publicState });
    }

    console.log(`[game_started] ${roomCode}`);
  });

  // -------------------------------------------------------------------------
  // roll_dice
  // -------------------------------------------------------------------------
  const DEV_INCIDENT_MESSAGES = [
    '🚨 Booking platform is down!',
    '🔥 AWS outage!',
    '💥 AMD update caused a meltdown!!',
    '😩 Cross state clinician got double booked :(',
    '⚠️ HL7 port outage!',
    '🛑 ThriveCare authentication service is unreachable!',
    '📉 Reporting dashboard just crashed mid-demo!',
    '🔴 Payer eligibility API is timing out!',
    '😱 Prod deploy rolled back after 5 minutes!',
    '🌩️ Database failover triggered in us-east-1!',
  ];

  socket.on('roll_dice', () => {
    const ctx = getRoomContext(socket);
    if (!ctx || !ctx.gameState) return sendError(socket, 'Game not started.');

    const { roomCode, gameState, playerDef } = ctx;
    const result = gameState.rollDice(playerDef.id);
    if (result.error) return sendError(socket, result.error);

    const devIncidentMessage = result.total === 7
      ? DEV_INCIDENT_MESSAGES[Math.floor(Math.random() * DEV_INCIDENT_MESSAGES.length)]
      : null;

    io.to(roomCode).emit('dice_rolled', {
      dice: result.dice,
      total: result.total,
      playerId: playerDef.id,
      playerName: playerDef.name,
      resourcesProduced: result.resourcesProduced || [],
      devIncidentMessage,
    });

    // If dev incident triggered, notify players who must discard
    if (result.total === 7) {
      if (gameState.pendingDiscards && gameState.pendingDiscards.size > 0) {
        for (const [pid, mustDiscard] of gameState.pendingDiscards) {
          const p = gameState.getPlayer(pid);
          if (p) {
            io.to(p.socketId).emit('discard_required', { playerId: pid, mustDiscard });
          }
        }
        io.to(roomCode).emit('dev_incident_triggered', {
          playersOverLimit: [...gameState.pendingDiscards.entries()].map(([id, count]) => ({
            playerId: id,
            count,
          })),
        });
      } else {
        io.to(roomCode).emit('dev_incident_triggered', { playersOverLimit: [] });
      }
    }

    broadcastGameState(roomCode);
  });

  // -------------------------------------------------------------------------
  // place_initial_settlement
  // -------------------------------------------------------------------------
  socket.on('place_initial_settlement', ({ vertexId } = {}) => {
    const ctx = getRoomContext(socket);
    if (!ctx || !ctx.gameState) return sendError(socket, 'Game not started.');

    const { roomCode, gameState, playerDef } = ctx;
    const result = gameState.placeInitialSettlement(playerDef.id, vertexId);
    if (result.error) return sendError(socket, result.error);

    broadcastGameState(roomCode);
  });

  // -------------------------------------------------------------------------
  // place_initial_road
  // -------------------------------------------------------------------------
  socket.on('place_initial_road', ({ edgeId } = {}) => {
    const ctx = getRoomContext(socket);
    if (!ctx || !ctx.gameState) return sendError(socket, 'Game not started.');

    const { roomCode, gameState, playerDef } = ctx;
    const result = gameState.placeInitialRoad(playerDef.id, edgeId);
    if (result.error) return sendError(socket, result.error);

    broadcastGameState(roomCode);
  });

  // -------------------------------------------------------------------------
  // build_settlement
  // -------------------------------------------------------------------------
  socket.on('build_settlement', ({ vertexId } = {}) => {
    const ctx = getRoomContext(socket);
    if (!ctx || !ctx.gameState) return sendError(socket, 'Game not started.');

    const { roomCode, gameState, playerDef } = ctx;
    const result = gameState.buildSettlement(playerDef.id, vertexId);
    if (result.error) return sendError(socket, result.error);

    broadcastGameState(roomCode);
    if (result.winner) _handleGameOver(roomCode, result.winner, gameState);
  });

  // -------------------------------------------------------------------------
  // build_city
  // -------------------------------------------------------------------------
  socket.on('build_city', ({ vertexId } = {}) => {
    const ctx = getRoomContext(socket);
    if (!ctx || !ctx.gameState) return sendError(socket, 'Game not started.');

    const { roomCode, gameState, playerDef } = ctx;
    const result = gameState.buildCity(playerDef.id, vertexId);
    if (result.error) return sendError(socket, result.error);

    broadcastGameState(roomCode);
    if (result.winner) _handleGameOver(roomCode, result.winner, gameState);
  });

  // -------------------------------------------------------------------------
  // build_road
  // -------------------------------------------------------------------------
  socket.on('build_road', ({ edgeId } = {}) => {
    const ctx = getRoomContext(socket);
    if (!ctx || !ctx.gameState) return sendError(socket, 'Game not started.');

    const { roomCode, gameState, playerDef } = ctx;
    const result = gameState.buildRoad(playerDef.id, edgeId);
    if (result.error) return sendError(socket, result.error);

    broadcastGameState(roomCode);
    if (result.winner) _handleGameOver(roomCode, result.winner, gameState);
  });

  // -------------------------------------------------------------------------
  // buy_funding_card
  // -------------------------------------------------------------------------
  socket.on('buy_funding_card', () => {
    const ctx = getRoomContext(socket);
    if (!ctx || !ctx.gameState) return sendError(socket, 'Game not started.');

    const { roomCode, gameState, playerDef } = ctx;
    const result = gameState.buyFundingCard(playerDef.id);
    if (result.error) return sendError(socket, result.error);

    broadcastGameState(roomCode);
    if (result.winner) _handleGameOver(roomCode, result.winner, gameState);
  });

  // -------------------------------------------------------------------------
  // play_engineer
  // -------------------------------------------------------------------------
  socket.on('play_engineer', ({ hexId, targetPlayerId } = {}) => {
    const ctx = getRoomContext(socket);
    if (!ctx || !ctx.gameState) return sendError(socket, 'Game not started.');

    const { roomCode, gameState, playerDef } = ctx;
    const result = gameState.playEngineer(playerDef.id, hexId, targetPlayerId);
    if (result.error) return sendError(socket, result.error);

    broadcastGameState(roomCode);
    if (result.winner) _handleGameOver(roomCode, result.winner, gameState);
  });

  // -------------------------------------------------------------------------
  // play_network_expansion
  // -------------------------------------------------------------------------
  socket.on('play_network_expansion', ({ edgeId1, edgeId2 } = {}) => {
    const ctx = getRoomContext(socket);
    if (!ctx || !ctx.gameState) return sendError(socket, 'Game not started.');

    const { roomCode, gameState, playerDef } = ctx;
    const result = gameState.playNetworkExpansion(playerDef.id, edgeId1, edgeId2);
    if (result.error) return sendError(socket, result.error);

    broadcastGameState(roomCode);
    if (result.winner) _handleGameOver(roomCode, result.winner, gameState);
  });

  // -------------------------------------------------------------------------
  // play_recruitment_drive
  // -------------------------------------------------------------------------
  socket.on('play_recruitment_drive', ({ resource1, resource2 } = {}) => {
    const ctx = getRoomContext(socket);
    if (!ctx || !ctx.gameState) return sendError(socket, 'Game not started.');

    const { roomCode, gameState, playerDef } = ctx;
    const result = gameState.playRecruitmentDrive(playerDef.id, resource1, resource2);
    if (result.error) return sendError(socket, result.error);

    broadcastGameState(roomCode);
  });

  // -------------------------------------------------------------------------
  // play_exclusive_payer_contract
  // -------------------------------------------------------------------------
  socket.on('play_exclusive_payer_contract', ({ resource } = {}) => {
    const ctx = getRoomContext(socket);
    if (!ctx || !ctx.gameState) return sendError(socket, 'Game not started.');

    const { roomCode, gameState, playerDef } = ctx;
    const result = gameState.playExclusivePayerContract(playerDef.id, resource);
    if (result.error) return sendError(socket, result.error);

    broadcastGameState(roomCode);
  });

  // -------------------------------------------------------------------------
  // discard_cards  (dev incident discard phase)
  // -------------------------------------------------------------------------
  socket.on('discard_cards', ({ cards } = {}) => {
    const ctx = getRoomContext(socket);
    if (!ctx || !ctx.gameState) return sendError(socket, 'Game not started.');

    const { roomCode, gameState, playerDef } = ctx;
    const result = gameState.discardCards(playerDef.id, cards || {});
    if (result.error) return sendError(socket, result.error);

    broadcastGameState(roomCode);
  });

  // -------------------------------------------------------------------------
  // move_dev_incident  (dev incident move phase — also used for engineer card
  //                     when triggered via rollDice; separate event here for
  //                     the post-roll robber movement)
  // -------------------------------------------------------------------------
  socket.on('move_dev_incident', ({ hexId, targetPlayerId } = {}) => {
    const ctx = getRoomContext(socket);
    if (!ctx || !ctx.gameState) return sendError(socket, 'Game not started.');

    const { roomCode, gameState, playerDef, room } = ctx;

    // Phase: DEV_INCIDENT_MOVE
    if (gameState.phase === 'dev_incident_move') {
      const result = gameState.moveDevIncident(playerDef.id, hexId);
      if (result.error) return sendError(socket, result.error);

      broadcastGameState(roomCode);

      // If we immediately need to steal (stealTargets present), client will emit steal
      return;
    }

    // Phase: DEV_INCIDENT_STEAL
    if (gameState.phase === 'dev_incident_steal') {
      if (!targetPlayerId) {
        const result = gameState.skipSteal(playerDef.id);
        if (result.error) return sendError(socket, result.error);
        broadcastGameState(roomCode);
        return;
      }
      const result = gameState.stealResource(playerDef.id, targetPlayerId);
      if (result.error) return sendError(socket, result.error);

      broadcastGameState(roomCode);

      // Animate the steal on everyone's screen
      io.to(roomCode).emit('steal_animation', {
        thiefId: playerDef.id,
        victimId: targetPlayerId,
      });

      // Notify both players of what was stolen
      if (result.stolenResource) {
        // Tell the thief what they got
        socket.emit('resource_stolen', {
          stolenResource: result.stolenResource,
          fromPlayerId: targetPlayerId,
          fromPlayerName: room.playerDefs.find(p => p.id === targetPlayerId)?.name || targetPlayerId,
          isVictim: false,
        });
        // Tell the victim they lost a card (no resource type revealed to victim)
        const victimDef = room.playerDefs.find(p => p.id === targetPlayerId);
        if (victimDef) {
          io.to(victimDef.socketId).emit('resource_stolen', {
            stolenResource: null,
            fromPlayerId: playerDef.id,
            fromPlayerName: playerDef.name,
            isVictim: true,
          });
        }
      }
      return;
    }

    sendError(socket, 'Cannot move dev incident now.');
  });

  // -------------------------------------------------------------------------
  // propose_trade
  // -------------------------------------------------------------------------
  socket.on('propose_trade', ({ offering, requesting } = {}) => {
    const ctx = getRoomContext(socket);
    if (!ctx || !ctx.gameState) return sendError(socket, 'Game not started.');

    const { roomCode, gameState, playerDef } = ctx;
    const result = gameState.proposeTrade(playerDef.id, offering, requesting);
    if (result.error) return sendError(socket, result.error);

    io.to(roomCode).emit('trade_proposed', {
      tradeId: result.tradeId,
      fromPlayerId: playerDef.id,
      offering,
      requesting,
    });
  });

  // -------------------------------------------------------------------------
  // accept_trade
  // -------------------------------------------------------------------------
  socket.on('accept_trade', ({ tradeId } = {}) => {
    const ctx = getRoomContext(socket);
    if (!ctx || !ctx.gameState) return sendError(socket, 'Game not started.');

    const { roomCode, gameState, playerDef } = ctx;
    const result = gameState.acceptTrade(tradeId, playerDef.id);
    if (result.error) return sendError(socket, result.error);

    const trade = result.trade;
    io.to(roomCode).emit('trade_resolved', {
      tradeId: trade.tradeId,
      accepted: true,
      fromPlayerId: trade.fromPlayerId,
      toPlayerId: trade.toPlayerId,
      offering: trade.offering,
      requesting: trade.requesting,
    });

    broadcastGameState(roomCode);
  });

  // -------------------------------------------------------------------------
  // decline_trade
  // -------------------------------------------------------------------------
  socket.on('decline_trade', ({ tradeId } = {}) => {
    const ctx = getRoomContext(socket);
    if (!ctx || !ctx.gameState) return sendError(socket, 'Game not started.');

    const { roomCode, gameState, playerDef } = ctx;
    const result = gameState.declineTrade(tradeId, playerDef.id);
    if (result.error) return sendError(socket, result.error);

    const trade = result.trade;
    // Only emit to the player who declined — other players can still accept
    socket.emit('trade_resolved', {
      tradeId: trade.tradeId,
      accepted: false,
      fromPlayerId: trade.fromPlayerId,
      toPlayerId: trade.toPlayerId,
    });
  });

  // -------------------------------------------------------------------------
  // bank_trade
  // -------------------------------------------------------------------------
  socket.on('bank_trade', ({ giving, givingCount, receiving } = {}) => {
    const ctx = getRoomContext(socket);
    if (!ctx || !ctx.gameState) return sendError(socket, 'Game not started.');

    const { roomCode, gameState, playerDef } = ctx;
    const result = gameState.bankTrade(playerDef.id, giving, givingCount, receiving);
    if (result.error) return sendError(socket, result.error);

    broadcastGameState(roomCode);
  });

  // -------------------------------------------------------------------------
  // send_chat
  // -------------------------------------------------------------------------
  socket.on('send_chat', ({ message } = {}) => {
    const ctx = getRoomContext(socket);
    if (!ctx) return;

    const { roomCode, playerDef } = ctx;
    if (!message || typeof message !== 'string') return sendError(socket, 'Invalid message.');

    const trimmed = message.trim().slice(0, 500);
    if (!trimmed) return;

    io.to(roomCode).emit('chat_message', {
      playerId: playerDef.id,
      playerName: playerDef.name,
      message: trimmed,
    });
  });

  // -------------------------------------------------------------------------
  // end_turn
  // -------------------------------------------------------------------------
  socket.on('end_turn', () => {
    const ctx = getRoomContext(socket);
    if (!ctx || !ctx.gameState) return sendError(socket, 'Game not started.');

    const { roomCode, gameState, playerDef } = ctx;
    const result = gameState.endTurn(playerDef.id);
    if (result.error) return sendError(socket, result.error);

    broadcastGameState(roomCode);
  });

  // -------------------------------------------------------------------------
  // hurry_up — any non-active player nudges the current player
  // -------------------------------------------------------------------------
  socket.on('hurry_up', () => {
    const ctx = getRoomContext(socket);
    if (!ctx) return;
    const { roomCode, playerDef } = ctx;
    io.to(roomCode).emit('hurry_up', { fromPlayerName: playerDef.name });
  });

  // -------------------------------------------------------------------------
  // rejoin_room
  // -------------------------------------------------------------------------
  socket.on('rejoin_room', ({ roomCode, playerId } = {}) => {
    if (!roomCode || !playerId) return sendError(socket, 'roomCode and playerId required.');

    const room = rules.getRoom(roomCode);
    if (!room) return sendError(socket, 'Room not found or has ended.');

    const playerDef = room.playerDefs.find(p => p.id === playerId);
    if (!playerDef) return sendError(socket, 'Player not found in that room.');

    // Update socket mapping
    rules.updatePlayerSocket(roomCode, playerId, socket.id);
    socket.join(roomCode);
    socketToRoom.set(socket.id, roomCode);

    if (room.gameState) {
      // Game is in progress — send current state back
      const publicState = room.gameState.toPublicState(playerId);
      socket.emit('rejoin_success', {
        playerId,
        roomCode,
        gameState: publicState,
        gameStarted: true,
      });
    } else {
      // Still in lobby
      const players = room.playerDefs.map(p => ({ id: p.id, name: p.name, color: p.color }));
      socket.emit('rejoin_success', {
        playerId,
        roomCode,
        players,
        gameStarted: false,
      });
    }

    console.log(`[rejoin] ${playerDef.name} rejoined ${roomCode}`);
  });

  // -------------------------------------------------------------------------
  // disconnect
  // -------------------------------------------------------------------------
  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id}`);
    socketToRoom.delete(socket.id);
    const found = rules.markPlayerDisconnected(socket.id);
    if (found) {
      const { room } = found;
      broadcastGameState(room.roomCode);
    }
  });
});

// ---------------------------------------------------------------------------
// Game over helper
// ---------------------------------------------------------------------------

function _handleGameOver(roomCode, winnerId, gameState) {
  const winner = gameState.getPlayer(winnerId);
  if (!winner) return;
  io.to(roomCode).emit('game_over', {
    winnerId,
    winnerName: winner.name,
  });
}

// ---------------------------------------------------------------------------
// Start listening
// ---------------------------------------------------------------------------

httpServer.listen(PORT, () => {
  console.log(`Thriveworks Catan server running on port ${PORT}`);
});

module.exports = { app, httpServer, io };
