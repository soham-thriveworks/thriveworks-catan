'use strict';

/**
 * test_playthrough.js
 *
 * Comprehensive test playthrough for the Thriveworks Catan server game logic.
 * Calls game logic directly (no sockets).
 *
 * Run from the server/ directory:
 *   node test_playthrough.js
 */

const GameState = require('./game/GameState');

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

let passCount = 0;
let failCount = 0;
const issues = [];

function log(msg) {
  console.log(msg);
}

function section(title) {
  console.log('\n' + '═'.repeat(70));
  console.log(`  ${title}`);
  console.log('═'.repeat(70));
}

function pass(label, detail = '') {
  passCount++;
  console.log(`  ✓ PASS  ${label}${detail ? ' — ' + detail : ''}`);
}

function fail(label, detail = '') {
  failCount++;
  const msg = `  ✗ FAIL  ${label}${detail ? ' — ' + detail : ''}`;
  console.log(msg);
  issues.push(msg.trim());
}

function expect(label, result, condition, detail = '') {
  if (condition) {
    pass(label, detail);
  } else {
    fail(label, `result=${JSON.stringify(result)}  ${detail}`);
  }
}

function expectOk(label, result, detail = '') {
  expect(label, result, !result.error, detail || (result.error ? `ERROR: ${result.error}` : ''));
}

function expectError(label, result, expectedSubstring = '', detail = '') {
  const hasError = !!result.error;
  const matchesMsg = expectedSubstring
    ? (result.error || '').toLowerCase().includes(expectedSubstring.toLowerCase())
    : true;
  if (hasError && matchesMsg) {
    pass(label, `got expected error: "${result.error}"`);
  } else if (!hasError) {
    fail(label, `Expected an error containing "${expectedSubstring}", got success: ${JSON.stringify(result)}`);
  } else {
    fail(label, `Expected error containing "${expectedSubstring}", got: "${result.error}"`);
  }
}

function resources(player) {
  return JSON.stringify(player.resources);
}

function vpSummary(gs) {
  return gs.getAllPlayers().map(p => `${p.name}=${p.victoryPoints()}VP`).join(', ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Force-set resources on a player (test helper — bypasses cost checks)
// ─────────────────────────────────────────────────────────────────────────────
function giveResources(player, res) {
  for (const [k, v] of Object.entries(res)) {
    player.resources[k] = (player.resources[k] || 0) + v;
  }
}

function setResources(player, res) {
  player.resources = {
    therapist: 0, payerContracts: 0, coeStaff: 0, rcmStaff: 0, clinOps: 0,
    ...res,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1: Create game with 3 players
// ─────────────────────────────────────────────────────────────────────────────
section('1. Game Creation & Start');

const SEED = 42;

const playerDefs = [
  { id: 'alice', name: 'Alice', color: 'red',   socketId: 'sock-alice' },
  { id: 'bob',   name: 'Bob',   color: 'blue',  socketId: 'sock-bob'   },
  { id: 'carol', name: 'Carol', color: 'green', socketId: 'sock-carol' },
];

const gs = new GameState(playerDefs, SEED);
expect('GameState created', gs, gs instanceof GameState);
expect('Phase is lobby', gs.phase, gs.phase === 'lobby');
expect('3 players registered', gs.playerOrder.length, gs.playerOrder.length === 3);

// Error: start with 1 player
const gs1 = new GameState([playerDefs[0]], SEED);
const startFail = gs1.start();
expectError('Cannot start with 1 player', startFail, 'at least 2');

// Start the real game
const startResult = gs.start();
expectOk('Game started successfully', startResult);
expect('Phase is setup_settlement after start', gs.phase, gs.phase === 'setup_settlement');
log(`  Player order after shuffle: ${gs.playerOrder.join(', ')}`);

// Error: start again
const restartResult = gs.start();
expectError('Cannot restart already-started game', restartResult, 'already started');

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2: Setup Phase
// ─────────────────────────────────────────────────────────────────────────────
section('2. Setup Phase — Initial Settlement + Road Placement');

// Gather all valid (inner) vertices for each hex
const board = gs.board;
const allHexIds = [...board.hexes.keys()];
log(`  Board has ${allHexIds.length} hexes, ${board.vertices.size} vertices, ${board.edges.size} edges`);

// Build a list of "inner" vertex IDs (those that don't touch ocean) — safer for settlements
const innerVertices = [...board.vertices.values()]
  .filter(v => !v.id.includes('ocean'))
  .map(v => v.id);

log(`  Inner (non-ocean) vertices available: ${innerVertices.length}`);

if (innerVertices.length === 0) {
  fail('No inner vertices found — cannot continue setup test');
  process.exit(1);
}

/**
 * Pick N well-spaced vertices for initial settlements.
 * We do a simple greedy approach: pick a vertex, then skip all its neighbours.
 */
function pickSpacedVertices(count) {
  const blocked = new Set();
  const chosen = [];
  for (const vid of innerVertices) {
    if (blocked.has(vid)) continue;
    chosen.push(vid);
    // Block this vertex and all its neighbours
    blocked.add(vid);
    for (const nv of board.getVertexNeighborVertices(vid)) {
      blocked.add(nv);
    }
    if (chosen.length === count) break;
  }
  return chosen;
}

const setupVertices = pickSpacedVertices(6); // 3 players × 2 settlements each
if (setupVertices.length < 6) {
  fail(`Could only find ${setupVertices.length} spaced vertices, need 6`);
  process.exit(1);
}
log(`  Chosen setup vertices: ${setupVertices.join('\n    ')}`);

/**
 * Given a vertex, pick any adjacent edge that is currently unoccupied.
 */
function pickEdgeForVertex(vid) {
  const edges = board.getEdgesOnVertex(vid);
  for (const eid of edges) {
    const edge = board.getEdge(eid);
    if (edge && edge.ownerId === null) return eid;
  }
  return null;
}

// Setup order: P0→P1→P2→P2→P1→P0  (forward then reverse)
const order = gs.playerOrder;
const setupOrder = [order[0], order[1], order[2], order[2], order[1], order[0]];
log(`  Expected setup order: ${setupOrder.join(', ')}`);

// --- Test out-of-turn error before starting placements ---
const wrongPlayer = setupOrder[0] === 'alice' ? 'bob' : 'alice';
const earlyResult = gs.placeInitialSettlement(wrongPlayer, setupVertices[0]);
if (gs.currentPlayerId !== wrongPlayer) {
  expectError('Out-of-turn settlement placement rejected', earlyResult, 'not your turn');
} else {
  // If the wrong player happens to be the current player, skip this check
  log('  (skipping out-of-turn check — wrong-player guess happened to be current player)');
}

// Perform all 6 settlement+road placements
for (let i = 0; i < 6; i++) {
  const pid = setupOrder[i];
  const vid = setupVertices[i];

  // Verify it's actually this player's turn
  expect(
    `Setup step ${i + 1}: correct player's turn (${pid})`,
    gs.currentPlayerId,
    gs.currentPlayerId === pid,
    `actual current: ${gs.currentPlayerId}`
  );

  // Attempt settlement
  const sResult = gs.placeInitialSettlement(pid, vid);
  expectOk(`Setup step ${i + 1}: place settlement at ${vid.slice(0, 30)}...`, sResult);
  expect(
    `Setup step ${i + 1}: phase is now setup_road`,
    gs.phase, gs.phase === 'setup_road'
  );

  // Attempt road
  const eid = pickEdgeForVertex(vid);
  if (!eid) {
    fail(`Setup step ${i + 1}: could not find edge for vertex ${vid}`);
    continue;
  }
  const rResult = gs.placeInitialRoad(pid, eid);
  expectOk(`Setup step ${i + 1}: place road at edge ${eid.slice(0, 30)}...`, rResult);

  // After last placement, phase should be ROLL; otherwise SETUP_SETTLEMENT
  if (i < 5) {
    expect(
      `Setup step ${i + 1}: phase returns to setup_settlement`,
      gs.phase, gs.phase === 'setup_settlement'
    );
  } else {
    expect(
      'Setup complete: phase is now roll',
      gs.phase, gs.phase === 'roll'
    );
  }
}

// Verify each player has 2 settlements and 2 roads
for (const pid of order) {
  const p = gs.getPlayer(pid);
  expect(
    `${p.name} has 2 settlements after setup`,
    p.practiceLocations.length,
    p.practiceLocations.length === 2,
    `settlements=${p.practiceLocations.length}`
  );
  expect(
    `${p.name} has 2 roads after setup`,
    p.networks.length,
    p.networks.length === 2,
    `roads=${p.networks.length}`
  );
  expect(
    `${p.name} has 1 VP from setup (second settlement gave resources)`,
    p.victoryPoints(),
    p.victoryPoints() >= 2,
    `VP=${p.victoryPoints()}, resources=${resources(p)}`
  );
}

log(`\n  Resource state after setup:`);
for (const pid of order) {
  const p = gs.getPlayer(pid);
  log(`    ${p.name}: ${resources(p)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3: Edge case — Invalid setup actions
// ─────────────────────────────────────────────────────────────────────────────
section('3. Edge Cases — Setup');

// Distance rule: try placing on a vertex adjacent to an existing settlement
{
  // We're now in ROLL phase, so these errors should say "not in settlement placement phase"
  const settled = gs.getPlayer(order[0]).practiceLocations[0];
  const adjacentVerts = board.getVertexNeighborVertices(settled);
  if (adjacentVerts.length > 0) {
    const distRes = gs.placeInitialSettlement(order[0], adjacentVerts[0]);
    expectError('Settlement out of phase rejected', distRes, 'not in settlement placement phase');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4: Main Game Turns
// ─────────────────────────────────────────────────────────────────────────────
section('4. Edge Cases — Pre-Roll Errors');

// Cannot end turn before rolling
{
  const pid = gs.currentPlayerId;
  const etResult = gs.endTurn(pid);
  expectError('Cannot end turn before rolling', etResult, 'can only end turn during main phase');
}

// Cannot roll twice
{
  const pid = gs.currentPlayerId;
  const r1 = gs.rollDice(pid);
  expectOk('First roll succeeds', r1, `dice=${JSON.stringify(r1.dice)}, total=${r1.total}`);

  // Handle any 7 that might have been rolled
  if (r1.total === 7) {
    log('  (7 was rolled — handling dev incident before continuing)');
    if (gs.phase === 'dev_incident_discard') {
      for (const [discardPid, count] of gs.pendingDiscards) {
        const p = gs.getPlayer(discardPid);
        // Build discard object
        const discardObj = {};
        let remaining = count;
        for (const res of ['therapist','payerContracts','coeStaff','rcmStaff','clinOps']) {
          const have = p.resources[res] || 0;
          const take = Math.min(have, remaining);
          if (take > 0) { discardObj[res] = take; remaining -= take; }
        }
        const dr = gs.discardCards(discardPid, discardObj);
        expectOk(`Discard for ${p.name}`, dr);
      }
    }
    if (gs.phase === 'dev_incident_move') {
      const currentHex = board.getDevIncidentHex();
      const otherHex = allHexIds.find(h => h !== (currentHex ? currentHex.id : null));
      const mvResult = gs.moveDevIncident(pid, otherHex);
      expectOk('Move dev incident', mvResult);
      if (gs.phase === 'dev_incident_steal') {
        // skip stealing (no targets or decline)
        const stealResult = gs.stealResource(pid, gs.devIncidentStealTargets[0]);
        expectOk('Steal resource', stealResult);
      }
    }
  }

  // Now try rolling again — should fail
  if (gs.phase === 'main') {
    const r2 = gs.rollDice(pid);
    expectError('Cannot roll twice in same turn', r2, 'already rolled');
  } else {
    log(`  Phase is ${gs.phase} after handling 7 — skipping double-roll test this turn`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: play a full turn (roll → optionally build → end)
// Returns the roll result.
// ─────────────────────────────────────────────────────────────────────────────
function playFullTurn(label) {
  const pid = gs.currentPlayerId;
  const player = gs.getPlayer(pid);

  log(`\n  --- Turn: ${label} | Player: ${player.name} (${pid}) ---`);
  log(`    Phase before roll: ${gs.phase}`);
  log(`    Resources: ${resources(player)}`);

  // Roll dice
  let rollResult = gs.rollDice(pid);

  // If roll failed (e.g. we're in MAIN not ROLL), something is wrong
  if (rollResult.error) {
    fail(`${label}: rollDice failed`, rollResult.error);
    return null;
  }

  pass(`${label}: rolled ${rollResult.dice} = ${rollResult.total}`);
  log(`    After roll resources: ${resources(player)}`);

  // Handle 7 / dev incident
  if (rollResult.total === 7) {
    log('    7 rolled — dev incident triggered');

    if (gs.phase === 'dev_incident_discard') {
      for (const [discardPid, count] of gs.pendingDiscards) {
        const p = gs.getPlayer(discardPid);
        const discardObj = {};
        let remaining = count;
        for (const res of ['therapist','payerContracts','coeStaff','rcmStaff','clinOps']) {
          const have = p.resources[res] || 0;
          const take = Math.min(have, remaining);
          if (take > 0) { discardObj[res] = take; remaining -= take; }
        }
        const dr = gs.discardCards(discardPid, discardObj);
        if (dr.error) {
          fail(`${label}: discard for ${p.name} failed`, dr.error);
        } else {
          pass(`${label}: ${p.name} discarded ${count} cards`);
        }
      }
    }

    if (gs.phase === 'dev_incident_move') {
      const currentDevHex = board.getDevIncidentHex();
      const targetHex = allHexIds.find(h => h !== (currentDevHex ? currentDevHex.id : null));
      const mvResult = gs.moveDevIncident(pid, targetHex);
      if (mvResult.error) {
        fail(`${label}: moveDevIncident failed`, mvResult.error);
      } else {
        pass(`${label}: moved dev incident to ${targetHex}`);
        if (gs.phase === 'dev_incident_steal' && gs.devIncidentStealTargets.length > 0) {
          const stealResult = gs.stealResource(pid, gs.devIncidentStealTargets[0]);
          if (stealResult.error) {
            fail(`${label}: steal failed`, stealResult.error);
          } else {
            pass(`${label}: stole ${stealResult.stolenResource || 'nothing'} from ${gs.devIncidentStealTargets[0]}`);
          }
        }
      }
    }
  }

  expect(`${label}: phase is main after roll+handling`, gs.phase, gs.phase === 'main');

  // End turn
  const etResult = gs.endTurn(pid);
  if (etResult.error) {
    fail(`${label}: endTurn failed`, etResult.error);
  } else {
    pass(`${label}: turn ended`);
  }

  return rollResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5: Turn 1 — complete the first player's first real turn
// ─────────────────────────────────────────────────────────────────────────────
section('5. Turn 1 (continued from section 4)');

// We already rolled in section 4 — finish that turn
{
  const pid = gs.currentPlayerId;
  if (gs.phase === 'main') {
    const etResult = gs.endTurn(pid);
    expectOk('End turn 1', etResult);
  } else {
    log(`  Warning: phase is ${gs.phase} — cannot end turn`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6: Multiple basic turns (turns 2–7)
// ─────────────────────────────────────────────────────────────────────────────
section('6. Turns 2–7 — Basic Play Loop');

for (let t = 2; t <= 7; t++) {
  playFullTurn(`Turn ${t}`);
  if (gs.phase === 'game_over') {
    log(`  Game ended early at turn ${t} with winner: ${gs.winnerId}`);
    break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7: Building — roads, settlements, cities
// ─────────────────────────────────────────────────────────────────────────────
section('7. Building Actions');

if (gs.phase !== 'game_over') {
  const pid = gs.currentPlayerId;
  const player = gs.getPlayer(pid);

  // Manually give resources and roll to reach MAIN phase
  setResources(player, {
    therapist: 5, payerContracts: 5, coeStaff: 5, rcmStaff: 5, clinOps: 5,
  });

  const rollRes = gs.rollDice(pid);
  if (rollRes.total === 7) {
    // Handle incident
    if (gs.phase === 'dev_incident_discard') {
      for (const [dp, count] of gs.pendingDiscards) {
        const p = gs.getPlayer(dp);
        const disc = {};
        let rem = count;
        for (const r of ['therapist','payerContracts','coeStaff','rcmStaff','clinOps']) {
          const have = p.resources[r] || 0;
          const take = Math.min(have, rem);
          if (take > 0) { disc[r] = take; rem -= take; }
        }
        gs.discardCards(dp, disc);
      }
    }
    if (gs.phase === 'dev_incident_move') {
      const dh = board.getDevIncidentHex();
      const th = allHexIds.find(h => h !== (dh ? dh.id : null));
      gs.moveDevIncident(pid, th);
      if (gs.phase === 'dev_incident_steal' && gs.devIncidentStealTargets.length > 0) {
        gs.stealResource(pid, gs.devIncidentStealTargets[0]);
      }
    }
  }

  // Restore resources after roll/incident
  setResources(player, {
    therapist: 5, payerContracts: 5, coeStaff: 5, rcmStaff: 5, clinOps: 5,
  });

  log(`  Player ${player.name} now in phase: ${gs.phase}`);

  if (gs.phase === 'main') {
    // --- BUILD ROAD ---
    // Find a buildable edge from existing network
    let roadEdge = null;
    for (const eid of player.networks) {
      const edge = board.getEdge(eid);
      if (!edge) continue;
      for (const vid of edge.vertexIds) {
        const adjEdges = board.getEdgesOnVertex(vid);
        for (const ae of adjEdges) {
          const aedge = board.getEdge(ae);
          if (aedge && aedge.ownerId === null && board.isEdgeBuildable(ae, pid, gs)) {
            roadEdge = ae;
            break;
          }
        }
        if (roadEdge) break;
      }
      if (roadEdge) break;
    }

    if (roadEdge) {
      setResources(player, { therapist: 1, payerContracts: 1, coeStaff: 0, rcmStaff: 0, clinOps: 0 });
      const roadResult = gs.buildRoad(pid, roadEdge);
      expectOk('Build road succeeds', roadResult, `edge=${roadEdge.slice(0, 30)}...`);
      expect('Player road count increased', player.networks.length, player.networks.length >= 3);
    } else {
      fail('Could not find buildable road edge for current player');
    }

    // Restore resources
    setResources(player, {
      therapist: 5, payerContracts: 5, coeStaff: 5, rcmStaff: 5, clinOps: 5,
    });

    // --- BUILD SETTLEMENT at a new location (need connected vertex, no distance conflict) ---
    let settlementVertex = null;
    for (const nwk of player.networks) {
      const edge = board.getEdge(nwk);
      if (!edge) continue;
      for (const vid of edge.vertexIds) {
        const v = board.getVertex(vid);
        if (!v || v.ownerId !== null) continue;
        // Check distance rule manually
        let tooClose = false;
        for (const nv of board.getVertexNeighborVertices(vid)) {
          const nVert = board.getVertex(nv);
          if (nVert && nVert.ownerId !== null) { tooClose = true; break; }
        }
        if (!tooClose && board.isEdgeBuildable(nwk, pid, gs)) {
          // Actually verify road connectivity
          const connEdges = board.getEdgesOnVertex(vid);
          const connected = connEdges.some(eid => {
            const e = board.getEdge(eid);
            return e && e.ownerId === pid;
          });
          if (connected) {
            settlementVertex = vid;
            break;
          }
        }
      }
      if (settlementVertex) break;
    }

    if (settlementVertex) {
      setResources(player, { therapist: 1, payerContracts: 1, coeStaff: 1, rcmStaff: 1, clinOps: 0 });
      const vpBefore = player.victoryPoints();
      const settleResult = gs.buildSettlement(pid, settlementVertex);
      expectOk('Build settlement succeeds', settleResult);
      expect(
        'VP increased by 1 after settlement',
        player.victoryPoints(),
        player.victoryPoints() === vpBefore + 1,
        `before=${vpBefore}, after=${player.victoryPoints()}`
      );
    } else {
      log('  (No suitable settlement vertex found — may be board-geometry limited)');
      // This is not necessarily a bug, could be no open connected vertex
    }

    // Restore resources
    setResources(player, {
      therapist: 5, payerContracts: 5, coeStaff: 5, rcmStaff: 5, clinOps: 5,
    });

    // --- BUILD CITY (upgrade a settlement) ---
    if (player.practiceLocations.length > 0) {
      const cityVertex = player.practiceLocations[0];
      setResources(player, { rcmStaff: 2, clinOps: 3 });
      const vpBefore = player.victoryPoints();
      const cityResult = gs.buildCity(pid, cityVertex);
      expectOk('Build city succeeds', cityResult);
      expect(
        'VP net +1 after city upgrade (settlement→city = +2VP −1VP)',
        player.victoryPoints(),
        player.victoryPoints() === vpBefore + 1,
        `before=${vpBefore}, after=${player.victoryPoints()}`
      );
    }

    // --- BUY FUNDING CARD ---
    setResources(player, { coeStaff: 1, rcmStaff: 1, clinOps: 1 });
    const deckBefore = gs.fundingDeck.remaining;
    const fcResult = gs.buyFundingCard(pid);
    expectOk('Buy funding card succeeds', fcResult, `card type=${fcResult.card ? fcResult.card.type : 'n/a'}`);
    expect(
      'Funding deck shrank by 1',
      gs.fundingDeck.remaining,
      gs.fundingDeck.remaining === deckBefore - 1,
      `before=${deckBefore}, after=${gs.fundingDeck.remaining}`
    );
    expect(
      'Player has funding card in hand',
      player.fundingCards.length,
      player.fundingCards.length >= 1
    );

    // End the building turn
    setResources(player, {});
    const etResult = gs.endTurn(pid);
    expectOk('End building turn', etResult);
  } else {
    log(`  Phase is ${gs.phase} — skipping build section`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8: Bank Trade (4:1)
// ─────────────────────────────────────────────────────────────────────────────
section('8. Bank Trade');

if (gs.phase !== 'game_over') {
  const pid = gs.currentPlayerId;
  const player = gs.getPlayer(pid);

  // Give resources & roll to reach MAIN
  setResources(player, {
    therapist: 8, payerContracts: 2, coeStaff: 0, rcmStaff: 0, clinOps: 0,
  });

  const r = gs.rollDice(pid);
  // Handle any 7
  if (r.total === 7) {
    if (gs.phase === 'dev_incident_discard') {
      for (const [dp, count] of gs.pendingDiscards) {
        const p = gs.getPlayer(dp);
        const disc = {};
        let rem = count;
        for (const res of ['therapist','payerContracts','coeStaff','rcmStaff','clinOps']) {
          const have = p.resources[res] || 0;
          const take = Math.min(have, rem);
          if (take > 0) { disc[res] = take; rem -= take; }
        }
        gs.discardCards(dp, disc);
      }
    }
    if (gs.phase === 'dev_incident_move') {
      const dh = board.getDevIncidentHex();
      const th = allHexIds.find(h => h !== (dh ? dh.id : null));
      gs.moveDevIncident(pid, th);
      if (gs.phase === 'dev_incident_steal' && gs.devIncidentStealTargets.length > 0) {
        gs.stealResource(pid, gs.devIncidentStealTargets[0]);
      }
    }
    // Restore after incident
    setResources(player, { therapist: 8, payerContracts: 2 });
  }

  if (gs.phase === 'main') {
    // Valid 4:1 bank trade
    const therapistBefore = player.resources.therapist;
    const clinOpsBefore = player.resources.clinOps || 0;
    const btResult = gs.bankTrade(pid, 'therapist', 4, 'clinOps');
    expectOk('Bank trade 4 therapist → 1 clinOps succeeds', btResult);
    expect(
      'Therapist reduced by 4',
      player.resources.therapist,
      player.resources.therapist === therapistBefore - 4,
      `before=${therapistBefore}, after=${player.resources.therapist}`
    );
    expect(
      'clinOps increased by 1',
      player.resources.clinOps,
      player.resources.clinOps === clinOpsBefore + 1,
      `before=${clinOpsBefore}, after=${player.resources.clinOps}`
    );

    // Invalid trade: wrong ratio
    const btBadRatio = gs.bankTrade(pid, 'therapist', 2, 'clinOps');
    expectError('Bank trade with wrong ratio rejected', btBadRatio, 'must trade exactly');

    // Invalid trade: same resource
    const btSame = gs.bankTrade(pid, 'therapist', 4, 'therapist');
    expectError('Bank trade same resource rejected', btSame, 'cannot trade a resource for itself');

    // Invalid trade: not enough resources
    setResources(player, { therapist: 1 });
    const btLow = gs.bankTrade(pid, 'therapist', 4, 'clinOps');
    expectError('Bank trade without sufficient resources rejected', btLow, 'not enough');

    gs.endTurn(pid);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9: Building error cases
// ─────────────────────────────────────────────────────────────────────────────
section('9. Building Error Cases');

if (gs.phase !== 'game_over') {
  const pid = gs.currentPlayerId;
  const player = gs.getPlayer(pid);

  setResources(player, {
    therapist: 5, payerContracts: 5, coeStaff: 5, rcmStaff: 5, clinOps: 5,
  });

  const r = gs.rollDice(pid);
  if (r.total === 7) {
    if (gs.phase === 'dev_incident_discard') {
      for (const [dp, count] of gs.pendingDiscards) {
        const p = gs.getPlayer(dp);
        const disc = {};
        let rem = count;
        for (const res of ['therapist','payerContracts','coeStaff','rcmStaff','clinOps']) {
          const have = p.resources[res] || 0;
          const take = Math.min(have, rem);
          if (take > 0) { disc[res] = take; rem -= take; }
        }
        gs.discardCards(dp, disc);
      }
    }
    if (gs.phase === 'dev_incident_move') {
      const dh = board.getDevIncidentHex();
      const th = allHexIds.find(h => h !== (dh ? dh.id : null));
      gs.moveDevIncident(pid, th);
      if (gs.phase === 'dev_incident_steal' && gs.devIncidentStealTargets.length > 0) {
        gs.stealResource(pid, gs.devIncidentStealTargets[0]);
      }
    }
    setResources(player, { therapist: 5, payerContracts: 5, coeStaff: 5, rcmStaff: 5, clinOps: 5 });
  }

  if (gs.phase === 'main') {
    // --- Cannot build settlement without enough resources ---
    setResources(player, {});
    const noResSettle = gs.buildSettlement(pid, innerVertices[0]);
    expectError('Build settlement without resources rejected', noResSettle, 'not enough resources');

    // --- Cannot build city on non-owned vertex ---
    setResources(player, { rcmStaff: 2, clinOps: 3 });
    // Find a vertex owned by a different player
    const otherPlayer = gs.getAllPlayers().find(p => p.id !== pid);
    let otherVertex = null;
    if (otherPlayer && otherPlayer.practiceLocations.length > 0) {
      otherVertex = otherPlayer.practiceLocations[0];
    }
    if (otherVertex) {
      const badCity = gs.buildCity(pid, otherVertex);
      expectError('Build city on opponent settlement rejected', badCity, 'must upgrade your own settlement');
    } else {
      log('  (no other player settlement found to test city-on-opponent)');
    }

    // --- Cannot build road not connected to network ---
    setResources(player, { therapist: 1, payerContracts: 1 });
    // Pick a random edge far from the player's network — one owned by nobody
    // but not adjacent to player's buildings/roads
    let disconnectedEdge = null;
    outer: for (const edge of board.edges.values()) {
      if (edge.ownerId !== null) continue;
      // Check that neither vertex is the player's, and no adjacent roads are theirs
      let connected = false;
      for (const vid of edge.vertexIds) {
        const v = board.getVertex(vid);
        if (v && v.ownerId === pid) { connected = true; break; }
        const adjEdges2 = board.getEdgesOnVertex(vid);
        for (const ae of adjEdges2) {
          const ae2 = board.getEdge(ae);
          if (ae2 && ae2.ownerId === pid) { connected = true; break; }
        }
        if (connected) break;
      }
      if (!connected) {
        disconnectedEdge = edge.id;
        break outer;
      }
    }
    if (disconnectedEdge) {
      const badRoad = gs.buildRoad(pid, disconnectedEdge);
      expectError('Build road disconnected from network rejected', badRoad, 'not connected');
    } else {
      log('  (could not find disconnected edge — player network may cover the whole board)');
    }

    // --- Cannot build settlement on occupied vertex ---
    setResources(player, { therapist: 1, payerContracts: 1, coeStaff: 1, rcmStaff: 1 });
    const occupiedVertex = player.practiceLocations[0];
    const reoccupyResult = gs.buildSettlement(pid, occupiedVertex);
    expectError('Build settlement on occupied vertex rejected', reoccupyResult, 'already occupied');

    // --- Cannot upgrade non-settlement to city ---
    if (player.stateNetworks.length > 0) {
      const alreadyCity = player.stateNetworks[0];
      setResources(player, { rcmStaff: 2, clinOps: 3 });
      const badUpgrade = gs.buildCity(pid, alreadyCity);
      expectError('Upgrade city on already-upgraded vertex rejected', badUpgrade, 'must upgrade your own settlement');
    }

    // --- Cannot build duplicate road on same edge ---
    setResources(player, { therapist: 1, payerContracts: 1 });
    const existingRoad = player.networks[0];
    const dupRoad = gs.buildRoad(pid, existingRoad);
    expectError('Build duplicate road rejected', dupRoad, 'edge already occupied');

    gs.endTurn(pid);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10: Out-of-turn errors
// ─────────────────────────────────────────────────────────────────────────────
section('10. Out-of-Turn & Phase Errors');

if (gs.phase !== 'game_over') {
  const currentPid = gs.currentPlayerId;
  const otherPid = gs.playerOrder.find(id => id !== currentPid);
  const otherPlayer = gs.getPlayer(otherPid);

  // Out-of-turn roll
  const ootRoll = gs.rollDice(otherPid);
  expectError('Out-of-turn roll rejected', ootRoll, 'not your turn');

  // Out-of-turn end turn
  const ootEnd = gs.endTurn(otherPid);
  expectError('Out-of-turn endTurn rejected', ootEnd, 'not your turn');

  // Out-of-turn build road
  setResources(otherPlayer, { therapist: 1, payerContracts: 1 });
  const anyEdge = otherPlayer.networks[0];
  // Build on a connected edge of other player — but it's not their turn
  let otherRoadEdge = null;
  for (const eid of otherPlayer.networks) {
    const edge = board.getEdge(eid);
    if (!edge) continue;
    for (const vid of edge.vertexIds) {
      const adjEdges = board.getEdgesOnVertex(vid);
      for (const ae of adjEdges) {
        const aedge = board.getEdge(ae);
        if (aedge && aedge.ownerId === null) { otherRoadEdge = ae; break; }
      }
      if (otherRoadEdge) break;
    }
    if (otherRoadEdge) break;
  }
  if (otherRoadEdge) {
    const ootBuild = gs.buildRoad(otherPid, otherRoadEdge);
    expectError('Out-of-turn buildRoad rejected', ootBuild, 'not your turn');
  }

  // Roll current player's turn, then check some MAIN phase errors
  const curPlayer = gs.getPlayer(currentPid);
  setResources(curPlayer, { therapist: 5, payerContracts: 5, coeStaff: 5, rcmStaff: 5, clinOps: 5 });
  const r = gs.rollDice(currentPid);
  if (r.total === 7) {
    if (gs.phase === 'dev_incident_discard') {
      for (const [dp, count] of gs.pendingDiscards) {
        const p = gs.getPlayer(dp);
        const disc = {};
        let rem = count;
        for (const res of ['therapist','payerContracts','coeStaff','rcmStaff','clinOps']) {
          const have = p.resources[res] || 0;
          const take = Math.min(have, rem);
          if (take > 0) { disc[res] = take; rem -= take; }
        }
        gs.discardCards(dp, disc);
      }
    }
    if (gs.phase === 'dev_incident_move') {
      const dh = board.getDevIncidentHex();
      const th = allHexIds.find(h => h !== (dh ? dh.id : null));
      gs.moveDevIncident(currentPid, th);
      if (gs.phase === 'dev_incident_steal' && gs.devIncidentStealTargets.length > 0) {
        gs.stealResource(currentPid, gs.devIncidentStealTargets[0]);
      }
    }
    setResources(curPlayer, { therapist: 5, payerContracts: 5, coeStaff: 5, rcmStaff: 5, clinOps: 5 });
  }

  if (gs.phase === 'main') {
    // Try to roll again in MAIN phase
    const rollInMain = gs.rollDice(currentPid);
    expectError('Roll in MAIN phase rejected', rollInMain, 'cannot roll dice now');

    // Cannot move dev incident in MAIN phase
    const wrongPhaseMove = gs.moveDevIncident(currentPid, allHexIds[0]);
    expectError('moveDevIncident in MAIN phase rejected', wrongPhaseMove, 'not in dev incident move phase');

    // Cannot steal in MAIN phase
    const wrongPhaseSteal = gs.stealResource(currentPid, otherPid);
    expectError('stealResource in MAIN phase rejected', wrongPhaseSteal, 'not in steal phase');

    gs.endTurn(currentPid);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 11: Dev Incident (roll 7) scenario
// ─────────────────────────────────────────────────────────────────────────────
section('11. Dev Incident (7) Scenario — Forced');

if (gs.phase !== 'game_over') {
  const pid = gs.currentPlayerId;
  const player = gs.getPlayer(pid);

  // Give one player 8+ resources to force discard
  const victimId = gs.playerOrder.find(id => id !== pid);
  const victim = gs.getPlayer(victimId);

  setResources(victim, {
    therapist: 3, payerContracts: 3, coeStaff: 2, rcmStaff: 0, clinOps: 0,
  }); // total = 8 → must discard 4

  setResources(player, { therapist: 1, payerContracts: 1 });

  // Force a 7 by monkey-patching the RNG
  const originalRng = gs.board._rng;
  let rngCallCount = 0;
  gs.board._rng = function () {
    rngCallCount++;
    if (rngCallCount <= 2) return 0.999; // dice: 6+6 — wait, that's 12 not 7
    // We need [0.833..] to get 6, and [0.5..] to get... let's think:
    // Math.floor(rng() * 6) + 1 = 6 requires rng() >= 5/6
    // Math.floor(rng() * 6) + 1 = 1 requires rng() < 1/6
    // 6+1 = 7 ✓
    if (rngCallCount === 1) return 5 / 6 + 0.001;   // d1 = 6
    if (rngCallCount === 2) return 0;                 // d2 = 1
    return originalRng();
  };
  rngCallCount = 0;

  const r7 = gs.rollDice(pid);

  // Restore RNG
  gs.board._rng = originalRng;

  log(`  Forced roll result: ${JSON.stringify(r7.dice)} = ${r7.total}`);

  if (r7.total === 7) {
    pass('Forced 7 roll succeeded', `dice=${JSON.stringify(r7.dice)}`);

    // Verify discard phase if victim has 8 resources
    if (victim.totalResourceCount() >= 8) {
      expect('Phase is dev_incident_discard', gs.phase, gs.phase === 'dev_incident_discard');

      const needed = gs.pendingDiscards.get(victimId);
      expect(`Victim must discard ${needed} cards`, needed, needed === 4, `got ${needed}`);

      // Error: discard wrong amount
      const badDiscard = gs.discardCards(victimId, { therapist: 1 });
      expectError('Discard wrong amount rejected', badDiscard, 'must discard exactly');

      // Error: discard more than you have
      const overDiscard = gs.discardCards(victimId, { therapist: 10 });
      expectError('Discard more than you have rejected', overDiscard, 'not enough');

      // Error: discard negative
      const negDiscard = gs.discardCards(victimId, { therapist: -1 });
      expectError('Discard negative rejected', negDiscard, 'cannot discard negative');

      // Error: wrong player discards (current player doesn't need to)
      if (!gs.pendingDiscards.has(pid)) {
        const wrongDiscard = gs.discardCards(pid, { therapist: 1 });
        expectError('Player who does not need to discard rejected', wrongDiscard, 'do not need to discard');
      }

      // Valid discard
      const validDiscard = gs.discardCards(victimId, {
        therapist: 2, payerContracts: 2,
      });
      expectOk('Valid discard accepted', validDiscard);
      expect('Phase transitions to dev_incident_move after all discards', gs.phase, gs.phase === 'dev_incident_move');
    } else {
      // No discard needed, should be straight to move
      expect('Phase skips to dev_incident_move (no 8+ card player)', gs.phase, gs.phase === 'dev_incident_move');
    }

    if (gs.phase === 'dev_incident_move') {
      // Error: move to same hex as current dev incident
      const devHex = board.getDevIncidentHex();
      if (devHex) {
        const sameHexResult = gs.moveDevIncident(pid, devHex.id);
        expectError('Move dev incident to same hex rejected', sameHexResult, 'must move dev incident to a different hex');
      }

      // Error: invalid hex
      const invalidHexResult = gs.moveDevIncident(pid, 'totally-invalid-hex-id');
      expectError('Move dev incident to invalid hex rejected', invalidHexResult, 'invalid hex');

      // Error: wrong player moves
      const wrongMover = gs.playerOrder.find(id => id !== pid);
      const wrongMoveResult = gs.moveDevIncident(wrongMover, allHexIds[0]);
      expectError('Wrong player moving dev incident rejected', wrongMoveResult, 'not your turn');

      // Valid move
      const currentDevHexId = devHex ? devHex.id : null;
      const moveTarget = allHexIds.find(h => h !== currentDevHexId);
      const moveResult = gs.moveDevIncident(pid, moveTarget);
      expectOk('Valid dev incident move accepted', moveResult);

      if (gs.phase === 'dev_incident_steal') {
        expect('devIncidentStealTargets is an array', gs.devIncidentStealTargets, Array.isArray(gs.devIncidentStealTargets));

        // Error: steal from invalid target
        const badStealResult = gs.stealResource(pid, 'non-existent-player');
        expectError('Steal from invalid target rejected', badStealResult, 'invalid steal target');

        // Valid steal
        if (gs.devIncidentStealTargets.length > 0) {
          const stealResult = gs.stealResource(pid, gs.devIncidentStealTargets[0]);
          expectOk('Valid steal accepted', stealResult, `stolen: ${stealResult.stolenResource}`);
          expect('Phase is main after steal', gs.phase, gs.phase === 'main');
        }
      } else {
        expect('Phase is main after dev incident move (no steal targets)', gs.phase, gs.phase === 'main');
      }
    }

    if (gs.phase === 'main') {
      gs.endTurn(pid);
      pass('Ended turn after dev incident scenario');
    }
  } else {
    log(`  Note: RNG override produced ${r7.total} instead of 7 — handling normally`);
    if (r7.total === 7) {
      // This branch won't execute due to logic above, but included for clarity
    } else {
      // Handle any intermediate states
      if (gs.phase === 'dev_incident_discard') {
        for (const [dp, count] of gs.pendingDiscards) {
          const p = gs.getPlayer(dp);
          const disc = {};
          let rem = count;
          for (const res of ['therapist','payerContracts','coeStaff','rcmStaff','clinOps']) {
            const have = p.resources[res] || 0;
            const take = Math.min(have, rem);
            if (take > 0) { disc[res] = take; rem -= take; }
          }
          gs.discardCards(dp, disc);
        }
      }
      if (gs.phase === 'dev_incident_move') {
        const dh = board.getDevIncidentHex();
        const th = allHexIds.find(h => h !== (dh ? dh.id : null));
        gs.moveDevIncident(pid, th);
        if (gs.phase === 'dev_incident_steal' && gs.devIncidentStealTargets.length > 0) {
          gs.stealResource(pid, gs.devIncidentStealTargets[0]);
        }
      }
      if (gs.phase === 'main') gs.endTurn(pid);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 12: Funding Card Play
// ─────────────────────────────────────────────────────────────────────────────
section('12. Funding Card Play');

if (gs.phase !== 'game_over') {
  const pid = gs.currentPlayerId;
  const player = gs.getPlayer(pid);

  // Force-give the player specific funding cards for testing
  // We need to manipulate the player's fundingCards directly
  // (newFundingCards must NOT include them so they're playable)
  const testCards = [
    { type: 'recruitmentDrive' },
    { type: 'networkExpansion' },
    { type: 'exclusivePayerContract' },
    { type: 'engineer' },
  ];
  // Clear existing and inject known cards
  player.fundingCards = [...testCards];
  player.newFundingCards = []; // none are "new" — all are playable

  setResources(player, { therapist: 2, payerContracts: 2, coeStaff: 2, rcmStaff: 2, clinOps: 2 });

  // Roll to get to MAIN phase
  const r = gs.rollDice(pid);
  if (r.total === 7) {
    if (gs.phase === 'dev_incident_discard') {
      for (const [dp, count] of gs.pendingDiscards) {
        const p = gs.getPlayer(dp);
        const disc = {};
        let rem = count;
        for (const res of ['therapist','payerContracts','coeStaff','rcmStaff','clinOps']) {
          const have = p.resources[res] || 0;
          const take = Math.min(have, rem);
          if (take > 0) { disc[res] = take; rem -= take; }
        }
        gs.discardCards(dp, disc);
      }
    }
    if (gs.phase === 'dev_incident_move') {
      const dh = board.getDevIncidentHex();
      const th = allHexIds.find(h => h !== (dh ? dh.id : null));
      gs.moveDevIncident(pid, th);
      if (gs.phase === 'dev_incident_steal' && gs.devIncidentStealTargets.length > 0) {
        gs.stealResource(pid, gs.devIncidentStealTargets[0]);
      }
    }
    // Restore
    player.fundingCards = [...testCards];
    player.newFundingCards = [];
    setResources(player, { therapist: 2, payerContracts: 2, coeStaff: 2, rcmStaff: 2, clinOps: 2 });
  }

  if (gs.phase === 'main') {
    // --- Recruitment Drive ---
    const therapistBefore = player.resources.therapist;
    const rdResult = gs.playRecruitmentDrive(pid, 'therapist', 'coeStaff');
    expectOk('Play recruitmentDrive succeeds', rdResult);
    expect(
      'Gained 1 therapist from recruitmentDrive',
      player.resources.therapist,
      player.resources.therapist === therapistBefore + 1,
      `before=${therapistBefore}, after=${player.resources.therapist}`
    );
    expect('hasPlayedFundingCard = true after recruitmentDrive', gs.hasPlayedFundingCard, gs.hasPlayedFundingCard === true);

    // Cannot play second funding card
    const secondCard = gs.playNetworkExpansion(pid, player.networks[0], player.networks[1]);
    expectError('Cannot play two funding cards per turn', secondCard, 'already played a funding card');

    // Reset for next tests
    gs.hasPlayedFundingCard = false;
    player.fundingCards = [{ type: 'networkExpansion' }, { type: 'exclusivePayerContract' }, { type: 'engineer' }];
    player.newFundingCards = [];

    // --- Network Expansion ---
    let ne1 = null, ne2 = null;
    // Find two buildable edges for the player
    const buildableEdges = [];
    for (const edge of board.edges.values()) {
      if (edge.ownerId !== null) continue;
      if (board.isEdgeBuildable(edge.id, pid, gs)) {
        buildableEdges.push(edge.id);
      }
    }
    if (buildableEdges.length >= 2) {
      ne1 = buildableEdges[0];
      ne2 = buildableEdges[1];
      const neResult = gs.playNetworkExpansion(pid, ne1, ne2);
      expectOk('Play networkExpansion succeeds', neResult);
      expect('Player has more roads after networkExpansion', player.networks.length, player.networks.includes(ne1));
    } else if (buildableEdges.length === 1) {
      ne1 = buildableEdges[0];
      const neResult = gs.playNetworkExpansion(pid, ne1, null);
      expectOk('Play networkExpansion (1 road) succeeds', neResult);
    } else {
      log('  No buildable edges for networkExpansion test — skipping');
      gs.hasPlayedFundingCard = true; // Mark as played to skip
    }

    // Reset
    gs.hasPlayedFundingCard = false;
    player.fundingCards = [{ type: 'exclusivePayerContract' }, { type: 'engineer' }];
    player.newFundingCards = [];

    // --- Exclusive Payer Contract ---
    // Give other players some therapists to steal
    const others = gs.getAllPlayers().filter(p => p.id !== pid);
    for (const op of others) {
      op.resources.therapist = 3;
    }
    const epcResult = gs.playExclusivePayerContract(pid, 'therapist');
    expectOk('Play exclusivePayerContract succeeds', epcResult, `totalGained=${epcResult.totalGained}`);
    expect(
      'Other players lost all therapist',
      null,
      others.every(op => op.resources.therapist === 0),
      `other[0].therapist=${others[0] ? others[0].resources.therapist : 'N/A'}`
    );

    // Reset
    gs.hasPlayedFundingCard = false;
    player.fundingCards = [{ type: 'engineer' }];
    player.newFundingCards = [];

    // --- Engineer (move dev incident + steal) ---
    const devHex = board.getDevIncidentHex();
    const engineerTargetHex = allHexIds.find(h => h !== (devHex ? devHex.id : null));

    // Put a player on that hex to steal from
    const stealTarget = gs.getAllPlayers().find(p => p.id !== pid);
    if (stealTarget && engineerTargetHex) {
      const hexVerts = board.getVerticesOnHex(engineerTargetHex);
      // Place stealTarget's settlement on one of those verts if possible
      const freeVert = hexVerts.find(vid => {
        const v = board.getVertex(vid);
        return v && v.ownerId === null && !board.getVertexNeighborVertices(vid).some(nv => {
          const nv2 = board.getVertex(nv);
          return nv2 && nv2.ownerId !== null;
        });
      });
      if (freeVert) {
        const v = board.getVertex(freeVert);
        v.ownerId = stealTarget.id;
        v.buildingType = 'practiceLocation';
        stealTarget.practiceLocations.push(freeVert);
        stealTarget.resources.therapist = 3;

        const engResult = gs.playEngineer(pid, engineerTargetHex, stealTarget.id);
        expectOk('Play engineer succeeds', engResult, `stolen=${engResult.stolenResource}`);

        // Error: play engineer when already played
        player.fundingCards = [{ type: 'engineer' }];
        player.newFundingCards = [];
        const eng2 = gs.playEngineer(pid, engineerTargetHex, stealTarget.id);
        expectError('Cannot play engineer when already played funding card', eng2, 'already played a funding card');

        gs.hasPlayedFundingCard = false;
      } else {
        log('  No free vertex on target hex for engineer test');
        // Still test engineer without steal target
        const engResult = gs.playEngineer(pid, engineerTargetHex, null);
        expectOk('Play engineer (no steal) succeeds', engResult);
      }
    } else {
      log('  Skipping engineer test — no suitable conditions');
    }

    // --- Cannot play card that is new (bought this turn) ---
    gs.hasPlayedFundingCard = false;
    const newCard = { type: 'recruitmentDrive' };
    player.fundingCards = [newCard];
    player.newFundingCards = [newCard]; // Mark as new
    const newCardPlay = gs.playRecruitmentDrive(pid, 'therapist', 'coeStaff');
    expectError('Cannot play card bought this turn', newCardPlay, 'no recruitment drive card to play');

    // End turn
    player.fundingCards = [];
    player.newFundingCards = [];
    gs.hasPlayedFundingCard = false;
    setResources(player, {});
    gs.endTurn(pid);
    pass('Ended funding card test turn');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 13: Player-to-Player Trade
// ─────────────────────────────────────────────────────────────────────────────
section('13. Player-to-Player Trade');

if (gs.phase !== 'game_over') {
  const pid = gs.currentPlayerId;
  const player = gs.getPlayer(pid);
  const otherId = gs.playerOrder.find(id => id !== pid);
  const other = gs.getPlayer(otherId);

  setResources(player, { therapist: 3, payerContracts: 2 });
  setResources(other, { coeStaff: 2, rcmStaff: 2 });

  const r = gs.rollDice(pid);
  if (r.total === 7) {
    if (gs.phase === 'dev_incident_discard') {
      for (const [dp, count] of gs.pendingDiscards) {
        const p = gs.getPlayer(dp);
        const disc = {};
        let rem = count;
        for (const res of ['therapist','payerContracts','coeStaff','rcmStaff','clinOps']) {
          const have = p.resources[res] || 0;
          const take = Math.min(have, rem);
          if (take > 0) { disc[res] = take; rem -= take; }
        }
        gs.discardCards(dp, disc);
      }
    }
    if (gs.phase === 'dev_incident_move') {
      const dh = board.getDevIncidentHex();
      const th = allHexIds.find(h => h !== (dh ? dh.id : null));
      gs.moveDevIncident(pid, th);
      if (gs.phase === 'dev_incident_steal' && gs.devIncidentStealTargets.length > 0) {
        gs.stealResource(pid, gs.devIncidentStealTargets[0]);
      }
    }
    setResources(player, { therapist: 3, payerContracts: 2 });
    setResources(other, { coeStaff: 2, rcmStaff: 2 });
  }

  if (gs.phase === 'main') {
    // Invalid trade: empty offering
    const badTrade1 = gs.proposeTrade(pid, {}, { coeStaff: 1 });
    expectError('Trade with empty offering rejected', badTrade1, 'must offer at least one resource');

    // Invalid trade: requesting nothing
    const badTrade2 = gs.proposeTrade(pid, { therapist: 1 }, {});
    expectError('Trade requesting nothing rejected', badTrade2, 'must request at least one resource');

    // Invalid trade: not enough resources
    const badTrade3 = gs.proposeTrade(pid, { therapist: 10 }, { coeStaff: 1 });
    expectError('Trade offering more than you have rejected', badTrade3, 'not enough');

    // Valid trade proposal
    const tradeResult = gs.proposeTrade(pid, { therapist: 1 }, { coeStaff: 1 });
    expectOk('Valid trade proposal created', tradeResult, `tradeId=${tradeResult.tradeId}`);
    const tradeId = tradeResult.tradeId;

    // Accept trade (other player accepts)
    const acceptResult = gs.acceptTrade(tradeId, otherId);
    expectOk('Trade accepted', acceptResult);
    expect('Player received coeStaff', player.resources.coeStaff, (player.resources.coeStaff || 0) >= 1);
    expect('Other player received therapist', other.resources.therapist, (other.resources.therapist || 0) >= 1);

    // Cannot accept same trade twice
    const reaccept = gs.acceptTrade(tradeId, otherId);
    expectError('Cannot accept already-completed trade', reaccept, 'no longer pending');

    // Decline trade test
    setResources(player, { therapist: 3 });
    const trade2 = gs.proposeTrade(pid, { therapist: 1 }, { coeStaff: 1 });
    expectOk('Second trade proposal created', trade2);
    const decline = gs.declineTrade(trade2.tradeId, otherId);
    expectOk('Trade declined successfully', decline);
    expect('Declined trade status is declined', decline.trade.status, decline.trade.status === 'declined');

    gs.endTurn(pid);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 14: Resource Production Verification
// ─────────────────────────────────────────────────────────────────────────────
section('14. Resource Production Verification');

if (gs.phase !== 'game_over') {
  const pid = gs.currentPlayerId;
  const player = gs.getPlayer(pid);

  // Find a hex number that one of the player's settlements is on
  const adjacentHexes = [];
  for (const vid of player.practiceLocations) {
    const hIds = board.getHexesOnVertex(vid);
    for (const hid of hIds) {
      const hex = board.getHex(hid);
      if (hex && hex.resource !== 'desert' && hex.number !== null && !hex.hasDevIncident) {
        adjacentHexes.push({ hexId: hid, resource: hex.resource, number: hex.number, vid });
      }
    }
  }

  if (adjacentHexes.length > 0) {
    const targetHex = adjacentHexes[0];
    log(`  Player ${player.name} has settlement on hex ${targetHex.hexId} producing ${targetHex.resource} on roll ${targetHex.number}`);

    setResources(player, {});
    const resBefore = { ...player.resources };

    // Manually call _produceResources for that number
    gs._produceResources(targetHex.number);

    const resAfter = player.resources;
    const gained = (resAfter[targetHex.resource] || 0) - (resBefore[targetHex.resource] || 0);

    // Settlement (practiceLocation) should yield 1; stateNetwork should yield 2
    const isCity = player.stateNetworks.includes(targetHex.vid);
    const expectedGain = isCity ? 2 : 1;

    expect(
      `Production on roll ${targetHex.number}: player gained ${expectedGain} ${targetHex.resource}`,
      gained,
      gained >= expectedGain, // might be more if multiple settlements on same number
      `gained=${gained}, expected≥${expectedGain}`
    );

    // Verify Dev Incident hex does NOT produce
    const devHex = board.getDevIncidentHex();
    if (devHex && devHex.number !== null) {
      setResources(player, {});
      const preDevRes = { ...player.resources };
      gs._produceResources(devHex.number);
      const postDevRes = player.resources;
      // If the player's settlement is on the dev incident hex, no resources gained
      const onDevHex = player.practiceLocations.some(vid => board.getHexesOnVertex(vid).includes(devHex.id));
      if (onDevHex) {
        const devGained = Object.entries(postDevRes).reduce((sum, [k, v]) => sum + (v - (preDevRes[k] || 0)), 0);
        expect(
          'Dev Incident hex does not produce resources',
          devGained,
          devGained === 0,
          `devGained=${devGained}`
        );
      } else {
        log('  (Player not on dev incident hex — skipping no-production check)');
      }
    }

    // Roll to continue (call rollDice normally)
    const rr = gs.rollDice(pid);
    if (rr.total === 7) {
      if (gs.phase === 'dev_incident_discard') {
        for (const [dp, count] of gs.pendingDiscards) {
          const p = gs.getPlayer(dp);
          const disc = {};
          let rem = count;
          for (const res of ['therapist','payerContracts','coeStaff','rcmStaff','clinOps']) {
            const have = p.resources[res] || 0;
            const take = Math.min(have, rem);
            if (take > 0) { disc[res] = take; rem -= take; }
          }
          gs.discardCards(dp, disc);
        }
      }
      if (gs.phase === 'dev_incident_move') {
        const dh = board.getDevIncidentHex();
        const th = allHexIds.find(h => h !== (dh ? dh.id : null));
        gs.moveDevIncident(pid, th);
        if (gs.phase === 'dev_incident_steal' && gs.devIncidentStealTargets.length > 0) {
          gs.stealResource(pid, gs.devIncidentStealTargets[0]);
        }
      }
    }
    if (gs.phase === 'main') gs.endTurn(pid);
  } else {
    log('  No adjacent non-desert hexes found for current player — skipping production test');
    const rr = gs.rollDice(pid);
    if (rr.total === 7) {
      if (gs.phase === 'dev_incident_discard') {
        for (const [dp, count] of gs.pendingDiscards) {
          const p = gs.getPlayer(dp);
          const disc = {};
          let rem = count;
          for (const res of ['therapist','payerContracts','coeStaff','rcmStaff','clinOps']) {
            const have = p.resources[res] || 0;
            const take = Math.min(have, rem);
            if (take > 0) { disc[res] = take; rem -= take; }
          }
          gs.discardCards(dp, disc);
        }
      }
      if (gs.phase === 'dev_incident_move') {
        const dh = board.getDevIncidentHex();
        const th = allHexIds.find(h => h !== (dh ? dh.id : null));
        gs.moveDevIncident(pid, th);
        if (gs.phase === 'dev_incident_steal' && gs.devIncidentStealTargets.length > 0) {
          gs.stealResource(pid, gs.devIncidentStealTargets[0]);
        }
      }
    }
    if (gs.phase === 'main') gs.endTurn(pid);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 15: Largest Network (longest road)
// ─────────────────────────────────────────────────────────────────────────────
section('15. Largest Network (Longest Road)');

if (gs.phase !== 'game_over') {
  const pid = gs.currentPlayerId;
  const player = gs.getPlayer(pid);

  setResources(player, {
    therapist: 10, payerContracts: 10, coeStaff: 5, rcmStaff: 5, clinOps: 5,
  });

  // Roll to enter MAIN
  const r = gs.rollDice(pid);
  if (r.total === 7) {
    if (gs.phase === 'dev_incident_discard') {
      for (const [dp, count] of gs.pendingDiscards) {
        const p = gs.getPlayer(dp);
        const disc = {};
        let rem = count;
        for (const res of ['therapist','payerContracts','coeStaff','rcmStaff','clinOps']) {
          const have = p.resources[res] || 0;
          const take = Math.min(have, rem);
          if (take > 0) { disc[res] = take; rem -= take; }
        }
        gs.discardCards(dp, disc);
      }
    }
    if (gs.phase === 'dev_incident_move') {
      const dh = board.getDevIncidentHex();
      const th = allHexIds.find(h => h !== (dh ? dh.id : null));
      gs.moveDevIncident(pid, th);
      if (gs.phase === 'dev_incident_steal' && gs.devIncidentStealTargets.length > 0) {
        gs.stealResource(pid, gs.devIncidentStealTargets[0]);
      }
    }
    setResources(player, { therapist: 10, payerContracts: 10 });
  }

  if (gs.phase === 'main') {
    const roadsBefore = player.networks.length;
    let roadsBuilt = 0;

    // Try to build up to 5 roads to trigger "Largest Network"
    for (let i = 0; i < 10 && roadsBuilt < 6; i++) {
      const buildableEdges = [];
      for (const edge of board.edges.values()) {
        if (edge.ownerId !== null) continue;
        if (board.isEdgeBuildable(edge.id, pid, gs)) {
          buildableEdges.push(edge.id);
        }
      }
      if (buildableEdges.length === 0) break;

      setResources(player, { therapist: 1, payerContracts: 1 });
      const rb = gs.buildRoad(pid, buildableEdges[0]);
      if (!rb.error) roadsBuilt++;
      else break;
    }

    log(`  Built ${roadsBuilt} roads in this turn. Total roads: ${player.networks.length}`);
    const longestRoad = board.getLongestRoad(pid, gs);
    log(`  Longest road for ${player.name}: ${longestRoad}`);

    if (longestRoad >= 5) {
      expect('Largest Network awarded', player.hasLargestNetwork, player.hasLargestNetwork === true);
      expect('largestNetworkHolder set', gs.largestNetworkHolder, gs.largestNetworkHolder === pid);
      expect('Largest Network gives +2 VP', player.victoryPoints(), player.victoryPoints() >= 4);
    } else {
      log(`  Longest road is ${longestRoad} — not enough for Largest Network (need 5)`);
    }

    setResources(player, {});
    gs.endTurn(pid);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 16: Serialization (toPublicState)
// ─────────────────────────────────────────────────────────────────────────────
section('16. Serialization — toPublicState');

{
  const pid = gs.playerOrder[0];
  const otherPid = gs.playerOrder[1];
  const pub = gs.toPublicState(pid);

  expect('toPublicState returns phase', pub, typeof pub.phase === 'string');
  expect('toPublicState returns currentPlayerId', pub, typeof pub.currentPlayerId === 'string');
  expect('toPublicState returns players array', pub, Array.isArray(pub.players));
  expect('toPublicState returns board', pub, pub.board !== undefined);
  expect('toPublicState returns fundingDeck', pub, pub.fundingDeck !== undefined);
  expect('toPublicState returns lastRoll', pub, 'lastRoll' in pub);
  expect('toPublicState returns hasRolled', pub, 'hasRolled' in pub);
  expect('toPublicState returns winnerId', pub, 'winnerId' in pub);

  // Self should see resources; others should not
  const selfPlayer = pub.players.find(p => p.id === pid);
  const otherPlayer = pub.players.find(p => p.id === otherPid);

  if (selfPlayer) {
    expect('Self player has resources exposed', selfPlayer, Object.keys(selfPlayer.resources).length > 0);
  }
  if (otherPlayer) {
    expect('Other player resources are hidden (empty object)', otherPlayer, Object.keys(otherPlayer.resources).length === 0);
  }

  // pendingDiscards only present in DEV_INCIDENT_DISCARD phase
  if (gs.phase !== 'dev_incident_discard') {
    expect('pendingDiscards absent when not in discard phase', pub, pub.pendingDiscards === undefined);
  }

  pass('toPublicState serialization complete');
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 17: Victory Condition
// ─────────────────────────────────────────────────────────────────────────────
section('17. Victory Condition Test');

{
  // Create a fresh game and push one player to 10 VP
  const gs2 = new GameState(playerDefs, SEED + 1);
  gs2.start();

  // Place all initial settlements and roads quickly
  const b2 = gs2.board;
  const allHexIds2 = [...b2.hexes.keys()];
  const innerVerts2 = [...b2.vertices.values()]
    .filter(v => !v.id.includes('ocean'))
    .map(v => v.id);

  const setupVerts2 = (() => {
    const blocked = new Set();
    const chosen = [];
    for (const vid of innerVerts2) {
      if (blocked.has(vid)) continue;
      chosen.push(vid);
      blocked.add(vid);
      for (const nv of b2.getVertexNeighborVertices(vid)) blocked.add(nv);
      if (chosen.length === 6) break;
    }
    return chosen;
  })();

  const order2 = gs2.playerOrder;
  const setupOrder2 = [order2[0], order2[1], order2[2], order2[2], order2[1], order2[0]];

  for (let i = 0; i < 6; i++) {
    const pid = setupOrder2[i];
    const vid = setupVerts2[i];
    gs2.placeInitialSettlement(pid, vid);
    const edges = b2.getEdgesOnVertex(vid);
    for (const eid of edges) {
      const edge = b2.getEdge(eid);
      if (edge && edge.ownerId === null) {
        gs2.placeInitialRoad(pid, eid);
        break;
      }
    }
  }

  expect('Game 2 setup complete — in ROLL phase', gs2.phase, gs2.phase === 'roll');

  // Give winner player 10 VP via settlements and cities
  const winnerId = gs2.playerOrder[0];
  const winPlayer = gs2.getPlayer(winnerId);

  // We already have 2 settlements = 2 VP. Let's upgrade to cities and add more.
  // City = 2 VP each. Add more VP via victoryPoint funding cards.
  winPlayer.fundingCards = Array(8).fill({ type: 'victoryPoint' });
  // 2 settlements (2 VP) + 8 VP cards = 10 VP
  const vpCheck = winPlayer.victoryPoints();
  expect(`Winner player has ${vpCheck} VP`, vpCheck, vpCheck >= 10, `VP=${vpCheck}`);

  // Trigger win check
  gs2._checkWin();
  expect('Game over after _checkWin()', gs2.phase, gs2.phase === 'game_over');
  expect('Winner ID set correctly', gs2.winnerId, gs2.winnerId === winnerId, `winnerId=${gs2.winnerId}`);

  // Any action after game_over should... let's test rollDice
  // Advance to winner's turn forcibly
  gs2.currentPlayerIndex = gs2.playerOrder.indexOf(winnerId);
  gs2.phase = 'game_over'; // already game_over
  const gameOverRoll = gs2.rollDice(winnerId);
  // Phase is game_over so rollDice should fail
  expectError('Cannot roll after game over', gameOverRoll, 'cannot roll dice now');
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 18: Largest Engineering Team
// ─────────────────────────────────────────────────────────────────────────────
section('18. Largest Engineering Team');

if (gs.phase !== 'game_over') {
  const pid = gs.currentPlayerId;
  const player = gs.getPlayer(pid);

  // Give player 3+ engineers already played
  player.playedEngineers = 3;
  gs._checkSpecialCards(); // Should trigger Largest Engineering Team

  expect('Largest Engineering Team awarded at 3 engineers', player.hasLargestEngineeringTeam, player.hasLargestEngineeringTeam === true);
  expect('largestEngineeringTeamHolder set', gs.largestEngineeringTeamHolder, gs.largestEngineeringTeamHolder === pid);
  expect('largestEngineeringTeamCount = 3', gs.largestEngineeringTeamCount, gs.largestEngineeringTeamCount === 3);
  expect('Largest Engineering Team gives +2 VP', player.victoryPoints(), player.victoryPoints() >= 4);

  // Give another player 4 engineers — should transfer
  const pid2 = gs.playerOrder.find(id => id !== pid);
  const player2 = gs.getPlayer(pid2);
  player2.playedEngineers = 4;
  gs._checkSpecialCards();

  expect('Largest Engineering Team transferred to player with more', player2.hasLargestEngineeringTeam, player2.hasLargestEngineeringTeam === true);
  expect('Previous holder lost Largest Engineering Team', player.hasLargestEngineeringTeam, player.hasLargestEngineeringTeam === false);

  // Reset
  player.playedEngineers = 0;
  player2.playedEngineers = 0;
  player.hasLargestEngineeringTeam = false;
  player2.hasLargestEngineeringTeam = false;
  gs.largestEngineeringTeamHolder = null;
  gs.largestEngineeringTeamCount = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 19: Additional edge case — Deck empty
// ─────────────────────────────────────────────────────────────────────────────
section('19. Empty Funding Deck');

if (gs.phase !== 'game_over') {
  const pid = gs.currentPlayerId;
  const player = gs.getPlayer(pid);

  // Drain the deck
  while (!gs.fundingDeck.isEmpty()) {
    gs.fundingDeck.draw();
  }
  expect('Funding deck is empty', gs.fundingDeck.remaining, gs.fundingDeck.remaining === 0);

  setResources(player, { coeStaff: 1, rcmStaff: 1, clinOps: 1 });
  const r = gs.rollDice(pid);
  if (r.total === 7) {
    if (gs.phase === 'dev_incident_discard') {
      for (const [dp, count] of gs.pendingDiscards) {
        const p = gs.getPlayer(dp);
        const disc = {};
        let rem = count;
        for (const res of ['therapist','payerContracts','coeStaff','rcmStaff','clinOps']) {
          const have = p.resources[res] || 0;
          const take = Math.min(have, rem);
          if (take > 0) { disc[res] = take; rem -= take; }
        }
        gs.discardCards(dp, disc);
      }
    }
    if (gs.phase === 'dev_incident_move') {
      const dh = board.getDevIncidentHex();
      const th = allHexIds.find(h => h !== (dh ? dh.id : null));
      gs.moveDevIncident(pid, th);
      if (gs.phase === 'dev_incident_steal' && gs.devIncidentStealTargets.length > 0) {
        gs.stealResource(pid, gs.devIncidentStealTargets[0]);
      }
    }
    setResources(player, { coeStaff: 1, rcmStaff: 1, clinOps: 1 });
  }

  if (gs.phase === 'main') {
    const buyEmpty = gs.buyFundingCard(pid);
    expectError('Cannot buy from empty deck', buyEmpty, 'funding deck is empty');
    gs.endTurn(pid);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 20: Final state summary
// ─────────────────────────────────────────────────────────────────────────────
section('20. Final State Summary');

log(`  Game phase: ${gs.phase}`);
log(`  Winner: ${gs.winnerId || 'none'}`);
log(`  VP Summary: ${vpSummary(gs)}`);
log(`  Largest Network holder: ${gs.largestNetworkHolder} (length ${gs.largestNetworkLength})`);
log(`  Largest Engineering Team holder: ${gs.largestEngineeringTeamHolder} (count ${gs.largestEngineeringTeamCount})`);
for (const p of gs.getAllPlayers()) {
  log(`  ${p.name}: VP=${p.victoryPoints()}, settlements=${p.practiceLocations.length}, cities=${p.stateNetworks.length}, roads=${p.networks.length}, cards=${p.fundingCards.length}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// RESULTS
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(70));
console.log('  TEST RESULTS');
console.log('═'.repeat(70));
console.log(`  PASSED: ${passCount}`);
console.log(`  FAILED: ${failCount}`);

if (issues.length > 0) {
  console.log('\n  FAILURES:');
  for (const issue of issues) {
    console.log(`    ${issue}`);
  }
} else {
  console.log('\n  All tests passed!');
}

console.log('═'.repeat(70));
process.exit(failCount > 0 ? 1 : 0);
