'use strict';

const { v4: uuidv4 } = require('uuid');
const GameState = require('./GameState');

/**
 * Rules.js — Room management for Thriveworks Catan.
 *
 * Manages:
 *   - Room creation and joining
 *   - Game lifecycle (start)
 *   - In-memory rooms store
 */

class Rules {
  constructor() {
    /**
     * Map of roomCode → {
     *   roomCode: string,
     *   host: socketId,
     *   playerDefs: [{ id, name, color, socketId }],
     *   gameState: GameState | null,
     *   started: boolean,
     * }
     */
    this.rooms = new Map();
  }

  // ---------------------------------------------------------------------------
  // Room creation
  // ---------------------------------------------------------------------------

  /**
   * Create a new room.
   * @param {string} playerName
   * @param {string} color
   * @param {string} socketId
   * @returns {{ roomCode: string, playerId: string, error?: string }}
   */
  createRoom(playerName, color, socketId) {
    if (!playerName || !color) {
      return { error: 'playerName and color are required.' };
    }

    const roomCode = this._generateRoomCode();
    const playerId = uuidv4();

    this.rooms.set(roomCode, {
      roomCode,
      host: socketId,
      playerDefs: [{ id: playerId, name: playerName, color, socketId }],
      gameState: null,
      started: false,
    });

    return { roomCode, playerId };
  }

  // ---------------------------------------------------------------------------
  // Room joining
  // ---------------------------------------------------------------------------

  /**
   * Join an existing room.
   * @returns {{ players, roomCode, playerId, error? }}
   */
  joinRoom(roomCode, playerName, color, socketId) {
    if (!playerName || !color) {
      return { error: 'playerName and color are required.' };
    }

    const room = this.rooms.get(roomCode);
    if (!room) return { error: 'Room not found.' };
    if (room.started) return { error: 'Game has already started.' };
    if (room.playerDefs.length >= 4) return { error: 'Room is full (max 4 players).' };

    // Validate color uniqueness
    if (room.playerDefs.some(p => p.color === color)) {
      return { error: 'That color is already taken.' };
    }

    // Validate name uniqueness
    if (room.playerDefs.some(p => p.name === playerName)) {
      return { error: 'That name is already taken.' };
    }

    const playerId = uuidv4();
    room.playerDefs.push({ id: playerId, name: playerName, color, socketId });

    const players = room.playerDefs.map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
    }));

    return { players, roomCode, playerId };
  }

  // ---------------------------------------------------------------------------
  // Game start
  // ---------------------------------------------------------------------------

  /**
   * Start the game for a room.
   * @param {string} roomCode
   * @param {string} hostSocketId
   * @returns {{ gameState: GameState, error? }}
   */
  startGame(roomCode, hostSocketId) {
    const room = this.rooms.get(roomCode);
    if (!room) return { error: 'Room not found.' };
    if (room.host !== hostSocketId) return { error: 'Only the host can start the game.' };
    if (room.started) return { error: 'Game has already started.' };
    if (room.playerDefs.length < 2) return { error: 'Need at least 2 players to start.' };

    const gameState = new GameState(room.playerDefs);
    const startResult = gameState.start();
    if (startResult.error) return startResult;

    room.gameState = gameState;
    room.started = true;

    return { gameState };
  }

  // ---------------------------------------------------------------------------
  // Lookup helpers
  // ---------------------------------------------------------------------------

  getRoom(roomCode) {
    return this.rooms.get(roomCode) || null;
  }

  getGameState(roomCode) {
    const room = this.rooms.get(roomCode);
    return room ? room.gameState : null;
  }

  /**
   * Find which room a socket belongs to.
   * Returns { room, player } or null.
   */
  findRoomBySocket(socketId) {
    for (const room of this.rooms.values()) {
      const player = room.playerDefs.find(p => p.socketId === socketId);
      if (player) return { room, player };
    }
    return null;
  }

  /**
   * Update the socketId for a player (e.g. reconnection).
   */
  updatePlayerSocket(roomCode, playerId, newSocketId) {
    const room = this.rooms.get(roomCode);
    if (!room) return false;
    const player = room.playerDefs.find(p => p.id === playerId);
    if (!player) return false;
    player.socketId = newSocketId;
    if (room.gameState) {
      const gp = room.gameState.getPlayer(playerId);
      if (gp) {
        gp.socketId = newSocketId;
        gp.isConnected = true;
      }
    }
    return true;
  }

  /**
   * Mark a player as disconnected.
   */
  markPlayerDisconnected(socketId) {
    const found = this.findRoomBySocket(socketId);
    if (!found) return null;
    const { room, player } = found;
    if (room.gameState) {
      const gp = room.gameState.getPlayer(player.id);
      if (gp) gp.isConnected = false;
    }
    return { room, player };
  }

  /**
   * Remove a room entirely.
   */
  destroyRoom(roomCode) {
    this.rooms.delete(roomCode);
  }

  // ---------------------------------------------------------------------------
  // Room code generation
  // ---------------------------------------------------------------------------

  _generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // avoid ambiguous chars
    let code;
    do {
      let suffix = '';
      for (let i = 0; i < 4; i++) {
        suffix += chars[Math.floor(Math.random() * chars.length)];
      }
      code = `THRV-${suffix}`;
    } while (this.rooms.has(code));
    return code;
  }
}

module.exports = Rules;
