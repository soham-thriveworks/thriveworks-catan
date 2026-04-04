'use strict';

const { v4: uuidv4 } = require('uuid');
const Player = require('./Player');

const RESOURCE_TYPES = Player.RESOURCE_TYPES;

class TradeManager {
  constructor() {
    /** Map of tradeId → trade object */
    this._trades = new Map();
  }

  // ---------------------------------------------------------------------------
  // Player-to-Player trades
  // ---------------------------------------------------------------------------

  /**
   * Create a new trade proposal.
   * @param {string} fromPlayerId
   * @param {{ [resource]: number }} offering
   * @param {{ [resource]: number }} requesting
   * @returns {{ tradeId: string, error?: string }}
   */
  createTrade(fromPlayerId, offering, requesting) {
    const err = this._validateTradeResources(offering, requesting);
    if (err) return { error: err };

    const tradeId = uuidv4();
    this._trades.set(tradeId, {
      tradeId,
      fromPlayerId,
      offering: { ...offering },
      requesting: { ...requesting },
      status: 'pending', // 'pending' | 'accepted' | 'declined'
      toPlayerId: null,
      createdAt: Date.now(),
    });

    return { tradeId };
  }

  /**
   * Accept a trade.
   * Validates both players have the required resources and performs the exchange.
   * @returns {{ error?: string, trade?: object }}
   */
  acceptTrade(tradeId, toPlayerId, gameState) {
    const trade = this._trades.get(tradeId);
    if (!trade) return { error: 'Trade not found.' };
    if (trade.status !== 'pending') return { error: 'Trade is no longer pending.' };
    if (trade.fromPlayerId === toPlayerId) return { error: 'Cannot trade with yourself.' };

    const fromPlayer = gameState.getPlayer(trade.fromPlayerId);
    const toPlayer = gameState.getPlayer(toPlayerId);
    if (!fromPlayer) return { error: 'Offering player not found.' };
    if (!toPlayer) return { error: 'Accepting player not found.' };

    // Validate fromPlayer has what they're offering
    for (const [res, amt] of Object.entries(trade.offering)) {
      if ((fromPlayer.resources[res] || 0) < amt) {
        return { error: `${fromPlayer.name} no longer has enough ${res}.` };
      }
    }

    // Validate toPlayer has what's being requested
    for (const [res, amt] of Object.entries(trade.requesting)) {
      if ((toPlayer.resources[res] || 0) < amt) {
        return { error: `${toPlayer.name} does not have enough ${res}.` };
      }
    }

    // Execute trade
    fromPlayer.deductResources(trade.offering);
    fromPlayer.addResources(trade.requesting);
    toPlayer.deductResources(trade.requesting);
    toPlayer.addResources(trade.offering);

    trade.status = 'accepted';
    trade.toPlayerId = toPlayerId;

    return { trade };
  }

  /**
   * Decline a trade.
   * @returns {{ error?: string, trade?: object }}
   */
  declineTrade(tradeId, playerId) {
    const trade = this._trades.get(tradeId);
    if (!trade) return { error: 'Trade not found.' };
    if (trade.status !== 'pending') return { error: 'Trade is no longer pending.' };

    // Track per-player declines without closing the trade for everyone
    if (!trade.decliners) trade.decliners = new Set();
    trade.decliners.add(playerId);
    return { trade };
  }

  // ---------------------------------------------------------------------------
  // Bank trades
  // ---------------------------------------------------------------------------

  /**
   * Trade with the bank (or port).
   * @param {string} playerId
   * @param {string} giving        Resource type player is giving
   * @param {number} givingCount   How many of that resource
   * @param {string} receiving     Resource type player wants back (1 unit)
   * @param {object} gameState     Current GameState instance
   * @returns {{ error?: string }}
   */
  bankTrade(playerId, giving, givingCount, receiving, gameState) {
    if (!RESOURCE_TYPES.includes(giving)) {
      return { error: `Invalid resource to give: ${giving}` };
    }
    if (!RESOURCE_TYPES.includes(receiving)) {
      return { error: `Invalid resource to receive: ${receiving}` };
    }
    if (giving === receiving) {
      return { error: 'Cannot trade a resource for itself.' };
    }

    const player = gameState.getPlayer(playerId);
    if (!player) return { error: 'Player not found.' };

    // Determine best trade ratio available to this player
    const ratio = this._getBestTradeRatio(player, giving, gameState);

    if (givingCount !== ratio) {
      return { error: `You must trade exactly ${ratio} ${giving} for 1 ${receiving} (your best available rate).` };
    }

    if ((player.resources[giving] || 0) < givingCount) {
      return { error: `Not enough ${giving}.` };
    }

    // Execute
    player.resources[giving] -= givingCount;
    player.resources[receiving] = (player.resources[receiving] || 0) + 1;

    return {};
  }

  /**
   * Determine the best (lowest) trade ratio for a specific resource given a player's ports.
   */
  _getBestTradeRatio(player, resource, gameState) {
    let best = 4; // default bank rate

    const board = gameState.board;
    if (!board) return best;

    // Check all settlements / cities the player has built
    const playerVertexIds = [
      ...player.practiceLocations,
      ...player.stateNetworks,
    ];

    for (const vid of playerVertexIds) {
      const vertex = board.getVertex(vid);
      if (!vertex || !vertex.port) continue;
      const port = vertex.port;
      if (port.resource === 'generic' && port.ratio < best) {
        best = port.ratio; // 3:1
      } else if (port.resource === resource && port.ratio < best) {
        best = port.ratio; // 2:1
      }
    }

    return best;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  getTrade(tradeId) {
    return this._trades.get(tradeId) || null;
  }

  _validateTradeResources(offering, requesting) {
    const offerValues = Object.values(offering || {});
    const reqValues = Object.values(requesting || {});

    if (!offering || offerValues.length === 0) return 'Must offer at least one resource.';
    if (!requesting || reqValues.length === 0) return 'Must request at least one resource.';

    for (const [res, amt] of Object.entries(offering)) {
      if (!RESOURCE_TYPES.includes(res)) return `Unknown resource: ${res}`;
      if (typeof amt !== 'number' || amt <= 0) return `Invalid amount for ${res}.`;
    }
    for (const [res, amt] of Object.entries(requesting)) {
      if (!RESOURCE_TYPES.includes(res)) return `Unknown resource: ${res}`;
      if (typeof amt !== 'number' || amt <= 0) return `Invalid amount for ${res}.`;
    }

    return null;
  }

  /** Clean up old resolved trades (optional housekeeping) */
  cleanup(maxAgeMs = 5 * 60 * 1000) {
    const now = Date.now();
    for (const [id, trade] of this._trades) {
      if (trade.status !== 'pending' && now - trade.createdAt > maxAgeMs) {
        this._trades.delete(id);
      }
    }
  }
}

module.exports = TradeManager;
