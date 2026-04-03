'use strict';

const Board = require('./Board');
const Player = require('./Player');
const FundingDeck = require('./FundingDeck');
const TradeManager = require('./TradeManager');

const BUILD_COSTS = Player.BUILD_COSTS;
const RESOURCE_TYPES = Player.RESOURCE_TYPES;

const PHASES = {
  LOBBY: 'lobby',
  SETUP_SETTLEMENT: 'setup_settlement',
  SETUP_ROAD: 'setup_road',
  ROLL: 'roll',
  DEV_INCIDENT_DISCARD: 'dev_incident_discard',
  DEV_INCIDENT_MOVE: 'dev_incident_move',
  DEV_INCIDENT_STEAL: 'dev_incident_steal',
  MAIN: 'main',
  GAME_OVER: 'game_over',
};

// VP threshold for victory
const VICTORY_POINTS_NEEDED = 10;
// Minimum roads for Largest Network
const MIN_LONGEST_ROAD = 5;
// Minimum engineers for Largest Engineering Team
const MIN_ENGINEERS = 3;

class GameState {
  constructor(players, seed) {
    this.board = new Board(seed);
    this.fundingDeck = new FundingDeck(this.board._rng);
    this.tradeManager = new TradeManager();

    /** Map of playerId → Player */
    this.players = new Map();
    /** Ordered array of playerIds */
    this.playerOrder = [];

    for (const p of players) {
      this.players.set(p.id, new Player(p));
      this.playerOrder.push(p.id);
    }

    this.phase = PHASES.LOBBY;
    this.currentPlayerIndex = 0;
    this.setupForward = true;      // true = forward order in setup, false = reverse
    this.setupSettlementsDone = 0; // total settlements placed so far in setup

    /** playerId of who holds Largest Network (null = nobody yet) */
    this.largestNetworkHolder = null;
    this.largestNetworkLength = 0;

    /** playerId of who holds Largest Engineering Team */
    this.largestEngineeringTeamHolder = null;
    this.largestEngineeringTeamCount = 0;

    /** Pending discards during dev incident: Map playerId → mustDiscard count */
    this.pendingDiscards = new Map();

    /** Current dev incident move state */
    this.devIncidentStealTargets = []; // player ids on the chosen hex

    /** Last dice roll */
    this.lastRoll = null;

    /** Has the current player rolled this turn? */
    this.hasRolled = false;

    /** Has the current player played a funding card this turn? */
    this.hasPlayedFundingCard = false;

    /** Track last dev incident hex to prevent re-placement on same hex in same move */
    this.devIncidentMoveFrom = null;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  get currentPlayerId() {
    return this.playerOrder[this.currentPlayerIndex];
  }

  getPlayer(id) {
    return this.players.get(id) || null;
  }

  getAllPlayers() {
    return this.playerOrder.map(id => this.players.get(id));
  }

  _nextPlayer() {
    this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.playerOrder.length;
  }

  _prevPlayer() {
    this.currentPlayerIndex =
      (this.currentPlayerIndex - 1 + this.playerOrder.length) % this.playerOrder.length;
  }

  _checkWin() {
    for (const player of this.players.values()) {
      if (player.victoryPoints() >= VICTORY_POINTS_NEEDED) {
        this.phase = PHASES.GAME_OVER;
        this.winnerId = player.id;
        return player;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Game Start
  // ---------------------------------------------------------------------------

  start() {
    if (this.phase !== PHASES.LOBBY) return { error: 'Game already started.' };
    if (this.playerOrder.length < 2) return { error: 'Need at least 2 players.' };

    // Shuffle turn order
    this._shuffleTurnOrder();

    this.phase = PHASES.SETUP_SETTLEMENT;
    this.currentPlayerIndex = 0;
    this.setupForward = true;
    this.setupSettlementsDone = 0;

    return {};
  }

  _shuffleTurnOrder() {
    const rng = this.board._rng;
    const arr = [...this.playerOrder];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    this.playerOrder = arr;
  }

  // ---------------------------------------------------------------------------
  // Setup Phase
  // ---------------------------------------------------------------------------

  placeInitialSettlement(playerId, vertexId) {
    if (this.phase !== PHASES.SETUP_SETTLEMENT) {
      return { error: 'Not in settlement placement phase.' };
    }
    if (playerId !== this.currentPlayerId) {
      return { error: 'Not your turn.' };
    }

    const vertex = this.board.getVertex(vertexId);
    if (!vertex) return { error: 'Invalid vertex.' };
    if (vertex.ownerId !== null) return { error: 'Vertex already occupied.' };

    // Distance rule check
    for (const nv of this.board.getVertexNeighborVertices(vertexId)) {
      const nVertex = this.board.getVertex(nv);
      if (nVertex && nVertex.ownerId !== null) {
        return { error: 'Too close to another settlement (distance rule).' };
      }
    }

    // Place settlement
    vertex.ownerId = playerId;
    vertex.buildingType = 'practiceLocation';

    const player = this.getPlayer(playerId);
    player.practiceLocations.push(vertexId);

    // Second round: give resources from adjacent hexes
    const isSecondRound = !this.setupForward;
    if (isSecondRound) {
      const hexIds = this.board.getHexesOnVertex(vertexId);
      for (const hexId of hexIds) {
        const hex = this.board.getHex(hexId);
        if (hex && hex.resource !== 'desert') {
          player.resources[hex.resource] = (player.resources[hex.resource] || 0) + 1;
        }
      }
    }

    this.phase = PHASES.SETUP_ROAD;
    return {};
  }

  placeInitialRoad(playerId, edgeId) {
    if (this.phase !== PHASES.SETUP_ROAD) {
      return { error: 'Not in road placement phase.' };
    }
    if (playerId !== this.currentPlayerId) {
      return { error: 'Not your turn.' };
    }

    const edge = this.board.getEdge(edgeId);
    if (!edge) return { error: 'Invalid edge.' };
    if (edge.ownerId !== null) return { error: 'Edge already occupied.' };

    // Must connect to this player's last placed settlement
    const player = this.getPlayer(playerId);
    const lastSettlement = player.practiceLocations[player.practiceLocations.length - 1];

    const [v1, v2] = edge.vertexIds;
    if (v1 !== lastSettlement && v2 !== lastSettlement) {
      return { error: 'Road must connect to your most recently placed settlement.' };
    }

    edge.ownerId = playerId;
    player.networks.push(edgeId);

    this._advanceSetup();
    return {};
  }

  _advanceSetup() {
    const n = this.playerOrder.length;
    this.setupSettlementsDone++;

    if (this.setupForward) {
      if (this.currentPlayerIndex < n - 1) {
        this._nextPlayer();
        this.phase = PHASES.SETUP_SETTLEMENT;
      } else {
        // Switch to reverse order
        this.setupForward = false;
        this.phase = PHASES.SETUP_SETTLEMENT;
        // Don't advance — same player (last) goes again
      }
    } else {
      if (this.currentPlayerIndex > 0) {
        this._prevPlayer();
        this.phase = PHASES.SETUP_SETTLEMENT;
      } else {
        // Setup complete — start main game
        this.phase = PHASES.ROLL;
        this.hasRolled = false;
        this.hasPlayedFundingCard = false;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Dice Roll
  // ---------------------------------------------------------------------------

  rollDice(playerId) {
    if (playerId !== this.currentPlayerId) return { error: 'Not your turn.' };
    if (this.hasRolled) return { error: 'Already rolled this turn.' };
    if (this.phase !== PHASES.ROLL) return { error: 'Cannot roll dice now.' };

    const rng = this.board._rng;
    const d1 = Math.floor(rng() * 6) + 1;
    const d2 = Math.floor(rng() * 6) + 1;
    const total = d1 + d2;

    this.lastRoll = { dice: [d1, d2], total };
    this.hasRolled = true;

    let resourcesProduced = [];
    if (total === 7) {
      this._handleDevIncident(playerId);
    } else {
      resourcesProduced = this._produceResources(total);
      this.phase = PHASES.MAIN;
    }

    return { dice: [d1, d2], total, resourcesProduced };
  }

  _produceResources(number) {
    const produced = [];
    for (const hex of this.board.hexes.values()) {
      if (hex.number !== number || hex.hasDevIncident) continue;
      const verts = this.board.getVerticesOnHex(hex.id);
      for (const vid of verts) {
        const vertex = this.board.getVertex(vid);
        if (!vertex || vertex.ownerId === null) continue;
        const player = this.getPlayer(vertex.ownerId);
        if (!player) continue;
        const amount = vertex.buildingType === 'stateNetwork' ? 2 : 1;
        player.resources[hex.resource] = (player.resources[hex.resource] || 0) + amount;
        produced.push({ playerId: vertex.ownerId, resource: hex.resource, hexId: hex.id, amount });
      }
    }
    return produced;
  }

  _handleDevIncident(activePlayerId) {
    // Step 1: check who must discard (8+ cards → discard half, rounded down)
    this.pendingDiscards = new Map();
    for (const player of this.players.values()) {
      const count = player.totalResourceCount();
      if (count >= 8) {
        const mustDiscard = Math.floor(count / 2);
        this.pendingDiscards.set(player.id, mustDiscard);
      }
    }

    this.devIncidentMoveFrom = this.board.getDevIncidentHex()?.id || null;

    if (this.pendingDiscards.size > 0) {
      this.phase = PHASES.DEV_INCIDENT_DISCARD;
    } else {
      this.phase = PHASES.DEV_INCIDENT_MOVE;
    }
  }

  discardCards(playerId, cards) {
    if (this.phase !== PHASES.DEV_INCIDENT_DISCARD) {
      return { error: 'Not in discard phase.' };
    }
    if (!this.pendingDiscards.has(playerId)) {
      return { error: 'You do not need to discard.' };
    }

    const mustDiscard = this.pendingDiscards.get(playerId);
    const player = this.getPlayer(playerId);

    // Validate the submitted cards
    let totalDiscarded = 0;
    for (const res of RESOURCE_TYPES) {
      const amt = cards[res] || 0;
      if (amt < 0) return { error: 'Cannot discard negative amounts.' };
      if ((player.resources[res] || 0) < amt) {
        return { error: `Not enough ${res} to discard.` };
      }
      totalDiscarded += amt;
    }

    if (totalDiscarded !== mustDiscard) {
      return { error: `Must discard exactly ${mustDiscard} cards, submitted ${totalDiscarded}.` };
    }

    // Deduct
    for (const res of RESOURCE_TYPES) {
      player.resources[res] = (player.resources[res] || 0) - (cards[res] || 0);
    }

    this.pendingDiscards.delete(playerId);

    // If all pending discards are resolved, move to dev incident move phase
    if (this.pendingDiscards.size === 0) {
      this.phase = PHASES.DEV_INCIDENT_MOVE;
    }

    return {};
  }

  moveDevIncident(playerId, hexId) {
    if (this.phase !== PHASES.DEV_INCIDENT_MOVE) {
      return { error: 'Not in dev incident move phase.' };
    }
    if (playerId !== this.currentPlayerId) {
      return { error: 'Not your turn.' };
    }

    const hex = this.board.getHex(hexId);
    if (!hex) return { error: 'Invalid hex.' };
    if (hex.id === this.devIncidentMoveFrom) {
      return { error: 'Must move Dev Incident to a different hex.' };
    }

    this.board.setDevIncident(hexId);

    // Determine who can be stolen from
    const playersOnHex = this.board.getPlayersOnHex(hexId, this);
    this.devIncidentStealTargets = playersOnHex.filter(id => id !== playerId);

    if (this.devIncidentStealTargets.length > 0) {
      this.phase = PHASES.DEV_INCIDENT_STEAL;
    } else {
      // Nobody to steal from
      this.phase = PHASES.MAIN;
    }

    return { stealTargets: this.devIncidentStealTargets };
  }

  skipSteal(playerId) {
    if (this.phase !== PHASES.DEV_INCIDENT_STEAL) return { error: 'Not in steal phase.' };
    if (playerId !== this.currentPlayerId) return { error: 'Not your turn.' };
    this.phase = PHASES.MAIN;
    return {};
  }

  stealResource(activePlayerId, targetPlayerId) {
    if (this.phase !== PHASES.DEV_INCIDENT_STEAL) {
      return { error: 'Not in steal phase.' };
    }
    if (activePlayerId !== this.currentPlayerId) {
      return { error: 'Not your turn.' };
    }
    if (!this.devIncidentStealTargets.includes(targetPlayerId)) {
      return { error: 'Invalid steal target.' };
    }

    const target = this.getPlayer(targetPlayerId);
    const active = this.getPlayer(activePlayerId);

    const stolenResource = this._stealRandomResource(target, active);
    this.phase = PHASES.MAIN;

    return { stolenResource };
  }

  _stealRandomResource(fromPlayer, toPlayer) {
    const available = [];
    for (const res of RESOURCE_TYPES) {
      for (let i = 0; i < (fromPlayer.resources[res] || 0); i++) {
        available.push(res);
      }
    }
    if (available.length === 0) return null;

    const rng = this.board._rng;
    const chosen = available[Math.floor(rng() * available.length)];
    fromPlayer.resources[chosen]--;
    toPlayer.resources[chosen] = (toPlayer.resources[chosen] || 0) + 1;
    return chosen;
  }

  // ---------------------------------------------------------------------------
  // Build actions (during MAIN phase)
  // ---------------------------------------------------------------------------

  buildSettlement(playerId, vertexId) {
    if (this.phase !== PHASES.MAIN) return { error: 'Not in main phase.' };
    if (playerId !== this.currentPlayerId) return { error: 'Not your turn.' };

    const player = this.getPlayer(playerId);
    if (!player.canAfford('practiceLocation')) {
      return { error: 'Not enough resources.' };
    }

    const vertex = this.board.getVertex(vertexId);
    if (!vertex) return { error: 'Invalid vertex.' };
    if (vertex.ownerId !== null) return { error: 'Vertex already occupied.' };

    // Distance rule
    for (const nv of this.board.getVertexNeighborVertices(vertexId)) {
      const nVertex = this.board.getVertex(nv);
      if (nVertex && nVertex.ownerId !== null) {
        return { error: 'Too close to another settlement (distance rule).' };
      }
    }

    // Must be connected by player's road
    const adjEdges = this.board.getEdgesOnVertex(vertexId);
    const connected = adjEdges.some(eid => {
      const e = this.board.getEdge(eid);
      return e && e.ownerId === playerId;
    });
    if (!connected) {
      return { error: 'Settlement must be connected to your road network.' };
    }

    player.deductResources(BUILD_COSTS.practiceLocation);
    vertex.ownerId = playerId;
    vertex.buildingType = 'practiceLocation';
    player.practiceLocations.push(vertexId);

    this._checkSpecialCards();
    const winner = this._checkWin();
    return { winner: winner ? winner.id : null };
  }

  buildCity(playerId, vertexId) {
    if (this.phase !== PHASES.MAIN) return { error: 'Not in main phase.' };
    if (playerId !== this.currentPlayerId) return { error: 'Not your turn.' };

    const player = this.getPlayer(playerId);
    if (!player.canAfford('stateNetwork')) {
      return { error: 'Not enough resources.' };
    }

    const vertex = this.board.getVertex(vertexId);
    if (!vertex) return { error: 'Invalid vertex.' };
    if (vertex.ownerId !== playerId || vertex.buildingType !== 'practiceLocation') {
      return { error: 'Must upgrade your own settlement.' };
    }

    player.deductResources(BUILD_COSTS.stateNetwork);

    // Remove from practiceLocations, add to stateNetworks
    player.practiceLocations = player.practiceLocations.filter(v => v !== vertexId);
    player.stateNetworks.push(vertexId);
    vertex.buildingType = 'stateNetwork';

    this._checkSpecialCards();
    const winner = this._checkWin();
    return { winner: winner ? winner.id : null };
  }

  buildRoad(playerId, edgeId) {
    if (this.phase !== PHASES.MAIN) return { error: 'Not in main phase.' };
    if (playerId !== this.currentPlayerId) return { error: 'Not your turn.' };

    const player = this.getPlayer(playerId);
    if (!player.canAfford('network')) {
      return { error: 'Not enough resources.' };
    }

    const result = this._placeRoad(playerId, edgeId);
    if (result.error) return result;

    player.deductResources(BUILD_COSTS.network);
    this._checkSpecialCards();
    const winner = this._checkWin();
    return { winner: winner ? winner.id : null };
  }

  _placeRoad(playerId, edgeId) {
    const edge = this.board.getEdge(edgeId);
    if (!edge) return { error: 'Invalid edge.' };
    if (edge.ownerId !== null) return { error: 'Edge already occupied.' };
    if (!this.board.isEdgeBuildable(edgeId, playerId, this)) {
      return { error: 'Cannot build road here — not connected to your network.' };
    }

    edge.ownerId = playerId;
    const player = this.getPlayer(playerId);
    player.networks.push(edgeId);
    return {};
  }

  buyFundingCard(playerId) {
    if (this.phase !== PHASES.MAIN) return { error: 'Not in main phase.' };
    if (playerId !== this.currentPlayerId) return { error: 'Not your turn.' };

    const player = this.getPlayer(playerId);
    if (!player.canAfford('fundingCard')) {
      return { error: 'Not enough resources.' };
    }

    if (this.fundingDeck.isEmpty()) {
      return { error: 'Funding deck is empty.' };
    }

    player.deductResources(BUILD_COSTS.fundingCard);
    const card = this.fundingDeck.draw();
    player.addFundingCard(card);

    this._checkSpecialCards();
    const winner = this._checkWin();
    return { card, winner: winner ? winner.id : null };
  }

  // ---------------------------------------------------------------------------
  // Funding Card Play Actions
  // ---------------------------------------------------------------------------

  playEngineer(playerId, hexId, targetPlayerId) {
    if (this.phase !== PHASES.MAIN && this.phase !== PHASES.ROLL) {
      return { error: 'Cannot play funding cards now.' };
    }
    if (playerId !== this.currentPlayerId) return { error: 'Not your turn.' };
    if (this.hasPlayedFundingCard) return { error: 'Already played a funding card this turn.' };

    const player = this.getPlayer(playerId);
    if (!player.hasFundingCard('engineer')) {
      return { error: 'No engineer card to play.' };
    }

    const hex = this.board.getHex(hexId);
    if (!hex) return { error: 'Invalid hex.' };

    const currentDevHex = this.board.getDevIncidentHex();
    if (currentDevHex && hex.id === currentDevHex.id) {
      return { error: 'Dev Incident is already on that hex.' };
    }

    player.removeFundingCard('engineer');
    player.playedEngineers++;
    this.hasPlayedFundingCard = true;

    this.board.setDevIncident(hexId);

    let stolenResource = null;
    if (targetPlayerId) {
      const target = this.getPlayer(targetPlayerId);
      if (!target) return { error: 'Target player not found.' };

      // Validate target is actually on the hex
      const playersOnHex = this.board.getPlayersOnHex(hexId, this);
      if (!playersOnHex.includes(targetPlayerId)) {
        return { error: 'Target player has no buildings on that hex.' };
      }

      stolenResource = this._stealRandomResource(target, player);
    }

    this._checkSpecialCards();
    const winner = this._checkWin();
    return { stolenResource, winner: winner ? winner.id : null };
  }

  playNetworkExpansion(playerId, edgeId1, edgeId2) {
    if (this.phase !== PHASES.MAIN) {
      return { error: 'Network Expansion must be played after rolling.' };
    }
    if (playerId !== this.currentPlayerId) return { error: 'Not your turn.' };
    if (this.hasPlayedFundingCard) return { error: 'Already played a funding card this turn.' };

    const player = this.getPlayer(playerId);
    if (!player.hasFundingCard('networkExpansion')) {
      return { error: 'No network expansion card to play.' };
    }

    player.removeFundingCard('networkExpansion');
    this.hasPlayedFundingCard = true;

    // Place first road (free)
    const r1 = this._placeRoad(playerId, edgeId1);
    if (r1.error) {
      // Rollback card removal — add it back
      player.fundingCards.push({ type: 'networkExpansion' });
      this.hasPlayedFundingCard = false;
      return r1;
    }

    // Place second road (free) — can be null/undefined to skip second road
    if (edgeId2 && edgeId2 !== edgeId1) {
      const r2 = this._placeRoad(playerId, edgeId2);
      if (r2.error) {
        // First road was placed, don't rollback. Just report error for second.
        return { warning: r2.error };
      }
    }

    this._checkSpecialCards();
    const winner = this._checkWin();
    return { winner: winner ? winner.id : null };
  }

  playRecruitmentDrive(playerId, resource1, resource2) {
    if (this.phase !== PHASES.MAIN) {
      return { error: 'Recruitment Drive must be played after rolling.' };
    }
    if (playerId !== this.currentPlayerId) return { error: 'Not your turn.' };
    if (this.hasPlayedFundingCard) return { error: 'Already played a funding card this turn.' };

    if (!RESOURCE_TYPES.includes(resource1) || !RESOURCE_TYPES.includes(resource2)) {
      return { error: 'Invalid resource type.' };
    }

    const player = this.getPlayer(playerId);
    if (!player.hasFundingCard('recruitmentDrive')) {
      return { error: 'No recruitment drive card to play.' };
    }

    player.removeFundingCard('recruitmentDrive');
    this.hasPlayedFundingCard = true;

    player.resources[resource1] = (player.resources[resource1] || 0) + 1;
    player.resources[resource2] = (player.resources[resource2] || 0) + 1;

    return {};
  }

  playExclusivePayerContract(playerId, resource) {
    if (this.phase !== PHASES.MAIN) {
      return { error: 'Exclusive Payer Contract must be played after rolling.' };
    }
    if (playerId !== this.currentPlayerId) return { error: 'Not your turn.' };
    if (this.hasPlayedFundingCard) return { error: 'Already played a funding card this turn.' };

    if (!RESOURCE_TYPES.includes(resource)) {
      return { error: 'Invalid resource type.' };
    }

    const player = this.getPlayer(playerId);
    if (!player.hasFundingCard('exclusivePayerContract')) {
      return { error: 'No exclusive payer contract card to play.' };
    }

    player.removeFundingCard('exclusivePayerContract');
    this.hasPlayedFundingCard = true;

    let totalGained = 0;
    for (const other of this.players.values()) {
      if (other.id === playerId) continue;
      const amt = other.resources[resource] || 0;
      if (amt > 0) {
        other.resources[resource] = 0;
        player.resources[resource] = (player.resources[resource] || 0) + amt;
        totalGained += amt;
      }
    }

    return { totalGained };
  }

  // ---------------------------------------------------------------------------
  // Trade
  // ---------------------------------------------------------------------------

  proposeTrade(fromPlayerId, offering, requesting) {
    if (this.phase !== PHASES.MAIN) return { error: 'Not in main phase.' };
    if (fromPlayerId !== this.currentPlayerId) return { error: 'Not your turn.' };

    const player = this.getPlayer(fromPlayerId);
    // Validate player has what they're offering
    for (const [res, amt] of Object.entries(offering)) {
      if ((player.resources[res] || 0) < amt) {
        return { error: `Not enough ${res} to offer.` };
      }
    }

    return this.tradeManager.createTrade(fromPlayerId, offering, requesting);
  }

  acceptTrade(tradeId, toPlayerId) {
    if (this.phase !== PHASES.MAIN) return { error: 'Not in main phase.' };
    return this.tradeManager.acceptTrade(tradeId, toPlayerId, this);
  }

  declineTrade(tradeId, playerId) {
    return this.tradeManager.declineTrade(tradeId, playerId);
  }

  bankTrade(playerId, giving, givingCount, receiving) {
    if (this.phase !== PHASES.MAIN) return { error: 'Not in main phase.' };
    if (playerId !== this.currentPlayerId) return { error: 'Not your turn.' };
    return this.tradeManager.bankTrade(playerId, giving, givingCount, receiving, this);
  }

  // ---------------------------------------------------------------------------
  // End Turn
  // ---------------------------------------------------------------------------

  endTurn(playerId) {
    if (this.phase !== PHASES.MAIN) return { error: 'Can only end turn during main phase.' };
    if (playerId !== this.currentPlayerId) return { error: 'Not your turn.' };

    // Clear per-turn state
    this.hasRolled = false;
    this.hasPlayedFundingCard = false;
    this.lastRoll = null;

    // Clear new funding cards (they're now playable next turn)
    const player = this.getPlayer(playerId);
    player.clearNewFundingCards();

    this._nextPlayer();
    this.phase = PHASES.ROLL;

    return {};
  }

  // ---------------------------------------------------------------------------
  // Special Cards
  // ---------------------------------------------------------------------------

  _checkSpecialCards() {
    this._checkLargestNetwork();
    this._checkLargestEngineeringTeam();
  }

  _checkLargestNetwork() {
    for (const player of this.players.values()) {
      const length = this.board.getLongestRoad(player.id, this);
      if (
        length >= MIN_LONGEST_ROAD &&
        length > this.largestNetworkLength
      ) {
        // Transfer the card
        if (this.largestNetworkHolder && this.largestNetworkHolder !== player.id) {
          const prev = this.getPlayer(this.largestNetworkHolder);
          if (prev) prev.hasLargestNetwork = false;
        }
        this.largestNetworkHolder = player.id;
        this.largestNetworkLength = length;
        player.hasLargestNetwork = true;
      }
    }
  }

  _checkLargestEngineeringTeam() {
    for (const player of this.players.values()) {
      if (
        player.playedEngineers >= MIN_ENGINEERS &&
        player.playedEngineers > this.largestEngineeringTeamCount
      ) {
        if (this.largestEngineeringTeamHolder && this.largestEngineeringTeamHolder !== player.id) {
          const prev = this.getPlayer(this.largestEngineeringTeamHolder);
          if (prev) prev.hasLargestEngineeringTeam = false;
        }
        this.largestEngineeringTeamHolder = player.id;
        this.largestEngineeringTeamCount = player.playedEngineers;
        player.hasLargestEngineeringTeam = true;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Serialisation
  // ---------------------------------------------------------------------------

  /**
   * Returns a state object safe to send to all clients.
   * Each player's own resources are only included if viewing self.
   * This returns an object; the server layer adds isSelf per socket.
   */
  toPublicState(perspectivePlayerId) {
    const playersArray = this.playerOrder.map(id => {
      const player = this.players.get(id);
      return player.toPublicJSON(id === perspectivePlayerId);
    });

    return {
      phase: this.phase,
      currentPlayerId: this.currentPlayerId,
      playerOrder: [...this.playerOrder],
      players: playersArray,
      board: this.board.toJSON(),
      fundingDeck: this.fundingDeck.toJSON(),
      lastRoll: this.lastRoll,
      hasRolled: this.hasRolled,
      hasPlayedFundingCard: this.hasPlayedFundingCard,
      largestNetworkHolder: this.largestNetworkHolder,
      largestNetworkLength: this.largestNetworkLength,
      largestEngineeringTeamHolder: this.largestEngineeringTeamHolder,
      largestEngineeringTeamCount: this.largestEngineeringTeamCount,
      pendingDiscards: this.phase === PHASES.DEV_INCIDENT_DISCARD
        ? Object.fromEntries(this.pendingDiscards)
        : undefined,
      devIncidentStealTargets: this.devIncidentStealTargets,
      winnerId: this.winnerId || null,
    };
  }
}

GameState.PHASES = PHASES;

module.exports = GameState;
