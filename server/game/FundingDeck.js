'use strict';

/**
 * FundingDeck.js
 *
 * Represents the Development Card deck, themed as "Funding Cards".
 *
 * Distribution (25 total):
 *   engineer             14  (Knight equivalent)
 *   networkExpansion      2  (Road Building equivalent)
 *   recruitmentDrive      2  (Year of Plenty equivalent)
 *   exclusivePayerContract 2 (Monopoly equivalent)
 *   victoryPoint          5  (Victory Point equivalent)
 */

const CARD_DISTRIBUTION = [
  ...Array(14).fill('engineer'),
  ...Array(2).fill('networkExpansion'),
  ...Array(2).fill('recruitmentDrive'),
  ...Array(2).fill('exclusivePayerContract'),
  'landedHealthSystemPartnership',
  'launchedNewFeatureThriveCare',
  'bookingV2GoLive',
  'thriveConnectGoLive',
  'medicaidLaunchedNewState',
];

/** Card effect descriptions (informational) */
const CARD_EFFECTS = {
  engineer: 'Move the Dev Incident to any hex and steal 1 resource from a player there.',
  networkExpansion: 'Place 2 free networks (roads) anywhere you could legally build.',
  recruitmentDrive: 'Take any 2 resources of your choice from the bank.',
  exclusivePayerContract: 'Name a resource. All other players give you ALL of that resource.',
  victoryPoint: 'Worth 1 Victory Point. Revealed only at game end or when you win.',
};

function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class FundingDeck {
  /**
   * @param {Function} rng - A random-number function returning [0,1)
   */
  constructor(rng) {
    this._rng = rng || Math.random;
    this._deck = shuffle(
      CARD_DISTRIBUTION.map(type => ({ type })),
      this._rng
    );
    this._discardPile = [];
  }

  /** How many cards remain in the draw pile */
  get remaining() {
    return this._deck.length;
  }

  /**
   * Draw the top card.
   * Returns { type } or null if the deck is empty.
   */
  draw() {
    if (this._deck.length === 0) return null;
    return this._deck.pop();
  }

  /**
   * Discard a card (return it to the discard pile).
   * @param {{ type: string }} card
   */
  discard(card) {
    this._discardPile.push(card);
  }

  isEmpty() {
    return this._deck.length === 0;
  }

  toJSON() {
    return {
      remaining: this._deck.length,
      discarded: this._discardPile.length,
    };
  }
}

FundingDeck.CARD_EFFECTS = CARD_EFFECTS;
FundingDeck.CARD_DISTRIBUTION = CARD_DISTRIBUTION;

module.exports = FundingDeck;
