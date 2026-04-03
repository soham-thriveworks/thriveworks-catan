'use strict';

const BUILD_COSTS = {
  network: { therapist: 1, payerContracts: 1 },
  practiceLocation: { therapist: 1, payerContracts: 1, coeStaff: 1, rcmStaff: 1 },
  stateNetwork: { rcmStaff: 2, clinOps: 3 },
  fundingCard: { coeStaff: 1, rcmStaff: 1, clinOps: 1 },
};

const RESOURCE_TYPES = ['therapist', 'payerContracts', 'coeStaff', 'rcmStaff', 'clinOps'];

class Player {
  constructor({ id, name, color, socketId }) {
    this.id = id;
    this.name = name;
    this.color = color;
    this.socketId = socketId;

    this.resources = {
      therapist: 0,
      payerContracts: 0,
      coeStaff: 0,
      rcmStaff: 0,
      clinOps: 0,
    };

    /** Array of { type: string } objects. Type is one of the dev card types. */
    this.fundingCards = [];

    /** Funding cards drawn this turn (cannot be played same turn they are drawn) */
    this.newFundingCards = [];

    this.playedEngineers = 0;

    /** Edge IDs */
    this.networks = [];

    /** Vertex IDs with practiceLocation */
    this.practiceLocations = [];

    /** Vertex IDs upgraded to stateNetwork */
    this.stateNetworks = [];

    /** Whether this player holds the Largest Network special card */
    this.hasLargestNetwork = false;

    /** Whether this player holds the Largest Engineering Team special card */
    this.hasLargestEngineeringTeam = false;

    /** Whether it is currently this player's turn */
    this.isConnected = true;
  }

  // ---------------------------------------------------------------------------
  // Victory Points
  // ---------------------------------------------------------------------------

  /**
   * Public VP count (shown to all players).
   * Does NOT include hidden VP funding cards.
   */
  publicVictoryPoints() {
    let vp = 0;
    vp += this.practiceLocations.length;       // 1 VP each
    vp += this.stateNetworks.length * 2;        // 2 VP each (replaces settlement)
    if (this.hasLargestNetwork) vp += 2;
    if (this.hasLargestEngineeringTeam) vp += 2;
    return vp;
  }

  /**
   * Total VP including hidden VP funding cards.
   * Used only for win-condition checking.
   */
  victoryPoints() {
    let vp = this.publicVictoryPoints();
    for (const card of this.fundingCards) {
      if (Player.VP_CARD_TYPES.has(card.type)) vp += 1;
    }
    return vp;
  }

  // ---------------------------------------------------------------------------
  // Resource helpers
  // ---------------------------------------------------------------------------

  totalResourceCount() {
    return RESOURCE_TYPES.reduce((sum, r) => sum + (this.resources[r] || 0), 0);
  }

  canAfford(item) {
    const cost = BUILD_COSTS[item];
    if (!cost) return false;
    for (const [res, amt] of Object.entries(cost)) {
      if ((this.resources[res] || 0) < amt) return false;
    }
    return true;
  }

  deductResources(cost) {
    for (const [res, amt] of Object.entries(cost)) {
      this.resources[res] = (this.resources[res] || 0) - amt;
    }
  }

  addResources(resources) {
    for (const [res, amt] of Object.entries(resources)) {
      if (RESOURCE_TYPES.includes(res)) {
        this.resources[res] = (this.resources[res] || 0) + amt;
      }
    }
  }

  /**
   * Check whether the player can afford a custom cost object.
   */
  canAffordCost(cost) {
    for (const [res, amt] of Object.entries(cost)) {
      if ((this.resources[res] || 0) < amt) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Funding card helpers
  // ---------------------------------------------------------------------------

  addFundingCard(card) {
    this.fundingCards.push(card);
    this.newFundingCards.push(card);
  }

  clearNewFundingCards() {
    this.newFundingCards = [];
  }

  /** Returns true if the player has at least one playable (non-new) card of this type */
  hasFundingCard(type) {
    return this.fundingCards.some(c => c.type === type && !this.newFundingCards.includes(c));
  }

  removeFundingCard(type) {
    const idx = this.fundingCards.findIndex(
      c => c.type === type && !this.newFundingCards.includes(c)
    );
    if (idx === -1) return false;
    this.fundingCards.splice(idx, 1);
    return true;
  }

  fundingCardCount() {
    return this.fundingCards.length;
  }

  // ---------------------------------------------------------------------------
  // Serialisation
  // ---------------------------------------------------------------------------

  /**
   * Safe public representation — hides the contents of funding cards from others.
   */
  toPublicJSON(isSelf = false) {
    return {
      id: this.id,
      name: this.name,
      color: this.color,
      resources: isSelf ? { ...this.resources } : {},
      resourceCount: this.totalResourceCount(),
      fundingCardCount: this.fundingCards.length,
      fundingCards: isSelf ? this.fundingCards.map(c => ({ type: c.type, isNew: this.newFundingCards.includes(c) })) : undefined,
      playedEngineers: this.playedEngineers,
      networks: [...this.networks],
      practiceLocations: [...this.practiceLocations],
      stateNetworks: [...this.stateNetworks],
      hasLargestNetwork: this.hasLargestNetwork,
      hasLargestEngineeringTeam: this.hasLargestEngineeringTeam,
      victoryPoints: this.publicVictoryPoints(),
      isConnected: this.isConnected,
    };
  }
}

Player.BUILD_COSTS = BUILD_COSTS;
Player.RESOURCE_TYPES = RESOURCE_TYPES;
Player.VP_CARD_TYPES = new Set([
  'victoryPoint',
  'landedHealthSystemPartnership',
  'launchedNewFeatureThriveCare',
  'bookingV2GoLive',
  'thriveConnectGoLive',
  'medicaidLaunchedNewState',
]);

module.exports = Player;
