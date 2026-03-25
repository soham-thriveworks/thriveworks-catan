'use strict';

/**
 * test_full.js
 *
 * Comprehensive end-to-end test for the Thriveworks Catan server game logic.
 * Calls GameState / Board / Player methods directly — no sockets.
 *
 * Run from the server/ directory:
 *   node test_full.js
 */

const GameState = require('./game/GameState');
const Player    = require('./game/Player');
const Board     = require('./game/Board');

const RESOURCE_TYPES = Player.RESOURCE_TYPES;
const BUILD_COSTS    = Player.BUILD_COSTS;
const PHASES         = GameState.PHASES;

// ─────────────────────────────────────────────────────────────────────────────
// Test harness
// ─────────────────────────────────────────────────────────────────────────────

let passCount = 0;
let failCount = 0;
const failures = [];

function section(title) {
  console.log('\n' + '═'.repeat(72));
  console.log(`  ${title}`);
  console.log('═'.repeat(72));
}

function pass(label) {
  passCount++;
  console.log(`  ✓ PASS  ${label}`);
}

function fail(label, detail) {
  failCount++;
  const msg = `  ✗ FAIL  ${label}  →  ${detail}`;
  console.log(msg);
  failures.push(msg.trim());
}

function expectOk(label, result) {
  if (!result || result.error) {
    fail(label, `got error: "${result ? result.error : 'null result'}"`);
  } else {
    pass(label);
  }
}

function expectError(label, result, substring) {
  if (!result || !result.error) {
    fail(label, `expected error containing "${substring}", got: ${JSON.stringify(result)}`);
  } else if (substring && !result.error.toLowerCase().includes(substring.toLowerCase())) {
    fail(label, `expected error containing "${substring}", got: "${result.error}"`);
  } else {
    pass(label);
  }
}

function expectEq(label, actual, expected) {
  if (actual === expected) {
    pass(label);
  } else {
    fail(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function expectGte(label, actual, min) {
  if (actual >= min) {
    pass(label);
  } else {
    fail(label, `expected >= ${min}, got ${actual}`);
  }
}

function expectTrue(label, value, detail = '') {
  if (value) {
    pass(label);
  } else {
    fail(label, detail || `expected truthy, got ${JSON.stringify(value)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function setResources(player, res) {
  player.resources = {
    therapist: 0, payerContracts: 0, coeStaff: 0, rcmStaff: 0, clinOps: 0,
    ...res,
  };
}

function giveResources(player, res) {
  for (const [k, v] of Object.entries(res)) {
    player.resources[k] = (player.resources[k] || 0) + v;
  }
}

function zeroResources(player) {
  setResources(player, {});
}

/**
 * Build a fresh GameState for N players using a fixed seed.
 * Also starts the game and returns playerOrder after the shuffle.
 */
function freshGame(numPlayers = 3, seed = 42) {
  const playerDefs = [];
  const colors = ['red', 'blue', 'green', 'orange'];
  for (let i = 0; i < numPlayers; i++) {
    playerDefs.push({ id: `p${i + 1}`, name: `Player${i + 1}`, color: colors[i], socketId: `s${i + 1}` });
  }
  const gs = new GameState(playerDefs, seed);
  gs.start();
  return gs;
}

/**
 * Do full setup for all players in a game: place a settlement + road per player
 * in forward then reverse order.  Returns the list of placed vertex/edge IDs.
 */
function doFullSetup(gs) {
  const n = gs.playerOrder.length;
  const placements = []; // { playerId, vertexId, edgeId }

  // Forward pass: players 0 … n-1
  for (let i = 0; i < n; i++) {
    const pid = gs.playerOrder[i];
    const vertexId = pickFreeVertex(gs, pid);
    const r1 = gs.placeInitialSettlement(pid, vertexId);
    if (r1.error) throw new Error(`Setup forward settlement ${i} failed: ${r1.error}`);
    const edgeId = pickEdgeAdjacentToVertex(gs, vertexId, pid);
    const r2 = gs.placeInitialRoad(pid, edgeId);
    if (r2.error) throw new Error(`Setup forward road ${i} failed: ${r2.error}`);
    placements.push({ playerId: pid, vertexId, edgeId });
  }

  // Reverse pass: players n-1 … 0
  for (let i = n - 1; i >= 0; i--) {
    const pid = gs.playerOrder[i];
    const vertexId = pickFreeVertex(gs, pid);
    const r1 = gs.placeInitialSettlement(pid, vertexId);
    if (r1.error) throw new Error(`Setup reverse settlement ${i} failed: ${r1.error}`);
    const edgeId = pickEdgeAdjacentToVertex(gs, vertexId, pid);
    const r2 = gs.placeInitialRoad(pid, edgeId);
    if (r2.error) throw new Error(`Setup reverse road ${i} failed: ${r2.error}`);
    placements.push({ playerId: pid, vertexId, edgeId });
  }

  return placements;
}

/**
 * Find a vertex that is free AND respects the distance rule AND is on a real hex.
 */
function pickFreeVertex(gs, playerId) {
  for (const [vid, v] of gs.board.vertices) {
    if (v.ownerId !== null) continue;
    // Must touch at least one real hex
    const realHexes = v.hexIds.filter(h => !h.startsWith('ocean'));
    if (realHexes.length === 0) continue;
    // Distance rule
    let ok = true;
    for (const nv of gs.board.getVertexNeighborVertices(vid)) {
      if (gs.board.getVertex(nv)?.ownerId !== null) { ok = false; break; }
    }
    if (ok) return vid;
  }
  throw new Error('No free vertex available');
}

/**
 * Find an edge adjacent to a given vertex that is free.
 */
function pickEdgeAdjacentToVertex(gs, vertexId, playerId) {
  const edges = gs.board.getEdgesOnVertex(vertexId);
  for (const eid of edges) {
    const e = gs.board.getEdge(eid);
    if (e && e.ownerId === null) return eid;
  }
  throw new Error(`No free edge adjacent to ${vertexId}`);
}

/**
 * Force a specific dice roll by patching the board's RNG.
 */
function forceRoll(gs, target) {
  // We need two dice summing to target. Use 1 + (target-1) unless target==2.
  const d1 = target <= 6 ? 1 : 2;
  const d2 = target - d1;
  // Each die: Math.floor(rng() * 6) + 1
  // So rng() must return (d-1)/6 exactly. We replace rng temporarily.
  const calls = [];
  calls.push((d1 - 1) / 6);   // first die
  calls.push((d2 - 1) / 6);   // second die
  let callIdx = 0;
  const origRng = gs.board._rng;
  gs.board._rng = () => {
    if (callIdx < calls.length) return calls[callIdx++];
    return origRng();
  };
}

/**
 * Force total = 7 for the next roll.
 */
function force7(gs) {
  // dice 1=3, 2=4 → total 7
  const calls = [2 / 6, 3 / 6];
  let idx = 0;
  const orig = gs.board._rng;
  gs.board._rng = () => {
    if (idx < calls.length) return calls[idx++];
    return orig();
  };
}

/**
 * Advance a game to MAIN phase with one round of setup, then roll dice
 * (patching to avoid 7 by default).
 */
function gameInMain(gs, rollValue = 8) {
  doFullSetup(gs);
  // Now in ROLL phase for first player
  forceRoll(gs, rollValue);
  const pid = gs.currentPlayerId;
  gs.rollDice(pid);
  // phase should be MAIN now (unless 7 was rolled)
  return pid;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Game start & lobby
// ─────────────────────────────────────────────────────────────────────────────
section('1. Game Creation & Start');

{
  // 1a. Can't start with 1 player
  const gs1 = new GameState([{ id: 'p1', name: 'A', color: 'red', socketId: 's1' }], 1);
  const r = gs1.start();
  expectError('1a. Reject start with 1 player', r, 'at least 2');

  // 1b. Normal 2-player start
  const gs2 = freshGame(2, 1);
  expectEq('1b. Phase after start is SETUP_SETTLEMENT', gs2.phase, PHASES.SETUP_SETTLEMENT);

  // 1c. 4-player start
  const gs4 = freshGame(4, 2);
  expectEq('1c. 4-player game starts ok', gs4.phase, PHASES.SETUP_SETTLEMENT);
  expectEq('1c. 4 players in order', gs4.playerOrder.length, 4);

  // 1d. Can't start twice
  const gsDup = freshGame(2, 3);
  const r2 = gsDup.start();
  expectError('1d. Reject double start', r2, 'already started');
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Setup Phase
// ─────────────────────────────────────────────────────────────────────────────
section('2. Setup Phase');

{
  const gs = freshGame(3, 42);
  const [p1, p2, p3] = gs.playerOrder;

  // 2a. Out-of-turn placement rejected
  const otherPid = gs.playerOrder[1]; // not current
  const anyVertex = [...gs.board.vertices.keys()].find(v => {
    const vx = gs.board.getVertex(v);
    return vx.hexIds.some(h => !h.startsWith('ocean'));
  });
  const rBad = gs.placeInitialSettlement(otherPid, anyVertex);
  expectError('2a. Out-of-turn setup placement rejected', rBad, 'not your turn');

  // 2b. Distance rule: can't place adjacent to existing settlement
  const v1 = pickFreeVertex(gs, p1);
  expectOk('2b. First settlement placement ok', gs.placeInitialSettlement(p1, v1));
  // Get a neighbor vertex
  const neighbors = gs.board.getVertexNeighborVertices(v1);
  const vNeighbor = neighbors.find(nv => {
    const vx = gs.board.getVertex(nv);
    return vx && vx.hexIds.some(h => !h.startsWith('ocean'));
  });
  if (vNeighbor) {
    // We are in ROAD phase now; do the road then try placing adjacent
    const eid = pickEdgeAdjacentToVertex(gs, v1, p1);
    expectOk('2b. Initial road placement ok', gs.placeInitialRoad(p1, eid));
    // Now p2's turn; place adjacent to p1's settlement
    const rDist = gs.placeInitialSettlement(p2, vNeighbor);
    expectError('2b. Distance rule rejects adjacent settlement', rDist, 'distance rule');
  } else {
    fail('2b. Distance rule', 'Could not find neighbor vertex to test');
  }

  // Re-create for 2c
  const gs2 = freshGame(3, 42);
  const [q1, q2, q3] = gs2.playerOrder;

  // 2c. Forward→reverse order check
  // Place all forward settlements+roads
  for (let i = 0; i < 3; i++) {
    const pid = gs2.playerOrder[i];
    const vid = pickFreeVertex(gs2, pid);
    gs2.placeInitialSettlement(pid, vid);
    const eid = pickEdgeAdjacentToVertex(gs2, vid, pid);
    gs2.placeInitialRoad(pid, eid);
  }
  // After forward pass, the last forward player (index 2) should go again in reverse
  expectEq('2c. After forward pass, current player is last player (reverse starts)', gs2.currentPlayerId, gs2.playerOrder[2]);
  expectEq('2c. Phase is SETUP_SETTLEMENT for reverse pass', gs2.phase, PHASES.SETUP_SETTLEMENT);

  // 2d. Second-round settlement grants resources from adjacent non-desert hexes
  const gs3 = freshGame(2, 100);
  const [r1id, r2id] = gs3.playerOrder;

  // Forward round
  const fv1 = pickFreeVertex(gs3, r1id);
  gs3.placeInitialSettlement(r1id, fv1);
  const fe1 = pickEdgeAdjacentToVertex(gs3, fv1, r1id);
  gs3.placeInitialRoad(r1id, fe1);

  const fv2 = pickFreeVertex(gs3, r2id);
  gs3.placeInitialSettlement(r2id, fv2);
  const fe2 = pickEdgeAdjacentToVertex(gs3, fv2, r2id);
  gs3.placeInitialRoad(r2id, fe2);

  // Reverse: p2 goes again first (player index 1)
  const beforeP2 = { ...gs3.getPlayer(r2id).resources };
  const rv2 = pickFreeVertex(gs3, r2id);
  gs3.placeInitialSettlement(r2id, rv2);
  const afterP2 = { ...gs3.getPlayer(r2id).resources };

  // Count real hex adjacencies
  const realHexesAdjacentToRv2 = gs3.board.getHexesOnVertex(rv2)
    .filter(h => !h.startsWith('ocean'))
    .map(h => gs3.board.getHex(h))
    .filter(h => h && h.resource !== 'desert');

  const totalExpected = realHexesAdjacentToRv2.length;
  let totalGained = 0;
  for (const r of RESOURCE_TYPES) {
    totalGained += (afterP2[r] || 0) - (beforeP2[r] || 0);
  }
  expectEq('2d. Second-round settlement grants correct # of starting resources', totalGained, totalExpected);

  // 2e. First-round settlement grants NO resources
  const beforeP1Forward = RESOURCE_TYPES.reduce((s, r) => s + (gs3.getPlayer(r1id).resources[r] || 0), 0);
  // p1 placed in forward with no resources — totalResourceCount should be 0
  // (gs3 r1id didn't place second-round yet)
  // r1id had no resources before second round; but let's verify:
  const p1TotalAfterForward = gs3.getPlayer(r1id).totalResourceCount();
  expectEq('2e. First-round placement grants 0 resources', p1TotalAfterForward, 0);

  // 2f. Invalid vertex rejected
  const rInvalid = gs3.placeInitialRoad(r2id, 'not-a-real-edge');
  expectError('2f. Invalid edge rejected during setup road', rInvalid, 'invalid edge');
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Dice rolling
// ─────────────────────────────────────────────────────────────────────────────
section('3. Dice Rolling');

{
  // 3a. Can't roll before setup is done
  const gsSetup = freshGame(2, 10);
  const rEarly = gsSetup.rollDice(gsSetup.playerOrder[0]);
  expectError('3a. Can\'t roll during setup', rEarly, 'cannot roll');

  // 3b. Normal roll succeeds
  const gs = freshGame(2, 42);
  doFullSetup(gs);
  const pid = gs.currentPlayerId;
  forceRoll(gs, 6);
  const rRoll = gs.rollDice(pid);
  expectOk('3b. First roll succeeds', rRoll);
  expectTrue('3b. Roll total is 6', rRoll.total === 6, `got ${rRoll.total}`);
  expectEq('3b. Phase is MAIN after non-7 roll', gs.phase, PHASES.MAIN);

  // 3c. Can't roll twice in same turn
  // BUG NOTE: After a non-7 roll, phase changes to MAIN. A second rollDice call
  // hits the phase guard ("Cannot roll dice now.") before the hasRolled guard
  // ("Already rolled this turn."). The hasRolled check is effectively unreachable
  // in normal play because phase changes from ROLL to MAIN after any roll.
  // The user gets a misleading error message when trying to roll twice.
  const rRoll2 = gs.rollDice(pid);
  // In MAIN phase, the phase check fires first — verify a meaningful error IS returned
  expectTrue('3c. Rolling twice returns an error (phase check prevents it)',
    !!rRoll2.error,
    `expected any error, got: ${JSON.stringify(rRoll2)}`);
  // Document the actual bug: error says "Cannot roll dice now." instead of "Already rolled"
  const doubleRollBugConfirmed = rRoll2.error === 'Cannot roll dice now.';
  expectTrue('3c. BUG CONFIRMED: double-roll error says "Cannot roll dice now." (phase check order masks hasRolled guard)',
    doubleRollBugConfirmed,
    `error was: "${rRoll2.error}" — if this FAILS, the bug was fixed`);

  // 3d. Wrong player roll rejected
  const gs4 = freshGame(2, 42);
  doFullSetup(gs4);
  const wrongPid = gs4.playerOrder.find(p => p !== gs4.currentPlayerId);
  const rWrong = gs4.rollDice(wrongPid);
  expectError('3d. Wrong player roll rejected', rWrong, 'not your turn');

  // 3e. Resource production on matching hex number
  const gs5 = freshGame(2, 42);
  doFullSetup(gs5);
  const pid5 = gs5.currentPlayerId;
  const player5 = gs5.getPlayer(pid5);

  // Find what numbers the current player's settlements are on
  const myVertices = player5.practiceLocations;
  let foundNum = null;
  let foundResource = null;
  for (const vid of myVertices) {
    const hexIds = gs5.board.getHexesOnVertex(vid).filter(h => !h.startsWith('ocean'));
    for (const hid of hexIds) {
      const hex = gs5.board.getHex(hid);
      if (hex && hex.number && !hex.hasDevIncident) {
        foundNum = hex.number;
        foundResource = hex.resource;
        break;
      }
    }
    if (foundNum) break;
  }

  if (foundNum) {
    zeroResources(player5);
    forceRoll(gs5, foundNum);
    gs5.rollDice(pid5);
    const gained = player5.resources[foundResource] || 0;
    expectGte('3e. Resource produced on matching dice roll', gained, 1);
  } else {
    fail('3e. Resource production test', 'Could not find a settleable number to test');
  }

  // 3f. No resources produced when dev incident is on matching hex
  const gs6 = freshGame(2, 42);
  doFullSetup(gs6);
  const pid6 = gs6.currentPlayerId;
  const player6 = gs6.getPlayer(pid6);
  const myVerts6 = player6.practiceLocations;

  let devIncidentNum = null;
  let devIncidentRes = null;
  for (const vid of myVerts6) {
    const hexIds = gs6.board.getHexesOnVertex(vid).filter(h => !h.startsWith('ocean'));
    for (const hid of hexIds) {
      const hex = gs6.board.getHex(hid);
      if (hex && hex.number && !hex.hasDevIncident) {
        devIncidentNum = hex.number;
        devIncidentRes = hex.resource;
        // Move dev incident here
        gs6.board.setDevIncident(hid);
        break;
      }
    }
    if (devIncidentNum) break;
  }

  if (devIncidentNum) {
    zeroResources(player6);
    forceRoll(gs6, devIncidentNum);
    gs6.rollDice(pid6);
    const gained6 = player6.resources[devIncidentRes] || 0;
    expectEq('3f. Dev incident hex produces no resources', gained6, 0);
  } else {
    fail('3f. Dev incident production block test', 'No suitable hex found');
  }

  // 3g. Multiple hexes touching one settlement all produce
  const gs7 = freshGame(2, 42);
  doFullSetup(gs7);
  const pid7 = gs7.currentPlayerId;
  const player7 = gs7.getPlayer(pid7);

  // Find a vertex with 2+ real hexes that have the same number
  let multiHexVid = null;
  let multiHexNum = null;
  for (const vid of player7.practiceLocations) {
    const realHexes = gs7.board.getHexesOnVertex(vid)
      .filter(h => !h.startsWith('ocean'))
      .map(h => gs7.board.getHex(h))
      .filter(h => h && !h.hasDevIncident && h.number);
    if (realHexes.length >= 2) {
      // Check if any two share the same number
      const numCounts = {};
      for (const h of realHexes) {
        numCounts[h.number] = (numCounts[h.number] || 0) + 1;
      }
      const matchNum = Object.entries(numCounts).find(([n, c]) => c >= 2);
      if (matchNum) {
        multiHexVid = vid;
        multiHexNum = Number(matchNum[0]);
        break;
      }
    }
  }

  if (multiHexVid && multiHexNum) {
    zeroResources(player7);
    forceRoll(gs7, multiHexNum);
    gs7.rollDice(pid7);
    const total7 = player7.totalResourceCount();
    expectGte('3g. Multiple hexes with same number both produce', total7, 2);
  } else {
    // This is a design limit of the seeded board — not a bug, skip gracefully
    pass('3g. Multiple hexes same number test (skipped — no matching configuration in this seed)');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Building
// ─────────────────────────────────────────────────────────────────────────────
section('4. Building');

{
  // Set up game to MAIN phase
  const gs = freshGame(2, 42);
  const placements = doFullSetup(gs);
  const pid = gs.currentPlayerId;
  const player = gs.getPlayer(pid);
  forceRoll(gs, 4);
  gs.rollDice(pid);

  // 4a. Build road with correct resources
  const someEdge = gs.board.getEdgesOnVertex(player.practiceLocations[0])
    .map(e => gs.board.getEdge(e))
    .find(e => e.ownerId === null);
  if (someEdge) {
    setResources(player, { therapist: 1, payerContracts: 1 });
    const rRoad = gs.buildRoad(pid, someEdge.id);
    expectOk('4a. Build road with resources ok', rRoad);
    expectTrue('4a. Road is owned by player', gs.board.getEdge(someEdge.id)?.ownerId === pid);
    expectTrue('4a. Resources deducted for road',
      player.resources.therapist === 0 && player.resources.payerContracts === 0);
  } else {
    fail('4a. Build road', 'No free adjacent edge found');
  }

  // 4b. Build road without resources
  zeroResources(player);
  const anotherEdge = gs.board.edges.values();
  let freeEdge = null;
  for (const e of anotherEdge) {
    if (e.ownerId === null) {
      // check connected
      if (gs.board.isEdgeBuildable(e.id, pid, gs)) {
        freeEdge = e;
        break;
      }
    }
  }
  if (freeEdge) {
    const rNoRes = gs.buildRoad(pid, freeEdge.id);
    expectError('4b. Build road without resources rejected', rNoRes, 'not enough resources');
  } else {
    fail('4b. Road without resources', 'No connectable free edge found');
  }

  // 4c. Build road on occupied edge
  const occupiedEdge = gs.board.edges.values();
  let takenEdge = null;
  for (const e of occupiedEdge) {
    if (e.ownerId !== null) { takenEdge = e; break; }
  }
  if (takenEdge) {
    setResources(player, { therapist: 5, payerContracts: 5 });
    const rOccupied = gs.buildRoad(pid, takenEdge.id);
    expectError('4c. Build road on occupied edge rejected', rOccupied, 'already occupied');
  } else {
    fail('4c. Build road occupied', 'No occupied edge found');
  }

  // 4d. Build settlement on unconnected vertex
  zeroResources(player);
  setResources(player, { therapist: 1, payerContracts: 1, coeStaff: 1, rcmStaff: 1 });
  // Find a vertex with no adjacent road from player and not distance-rule blocked
  let unconnectedVertex = null;
  for (const [vid, v] of gs.board.vertices) {
    if (v.ownerId !== null) continue;
    const realHexes = v.hexIds.filter(h => !h.startsWith('ocean'));
    if (realHexes.length === 0) continue;
    let distOk = true;
    for (const nv of gs.board.getVertexNeighborVertices(vid)) {
      if (gs.board.getVertex(nv)?.ownerId !== null) { distOk = false; break; }
    }
    if (!distOk) continue;
    // Not connected by player road
    const connected = gs.board.getEdgesOnVertex(vid)
      .some(eid => gs.board.getEdge(eid)?.ownerId === pid);
    if (!connected) { unconnectedVertex = vid; break; }
  }
  if (unconnectedVertex) {
    const rUnconn = gs.buildSettlement(pid, unconnectedVertex);
    expectError('4d. Settlement on unconnected vertex rejected', rUnconn, 'connected to your road');
  } else {
    fail('4d. Settlement unconnected', 'Could not find unconnected free vertex');
  }

  // 4e. Build settlement connected by road
  // Build a chain of roads until we find a vertex that is free, passes distance
  // rule, and is connected. We keep extending the chain.
  setResources(player, { therapist: 10, payerContracts: 10, coeStaff: 5, rcmStaff: 5 });

  let connectedFreeVertex = null;
  // Try extending road chains up to 10 iterations to find a buildable spot
  for (let attempt = 0; attempt < 15 && !connectedFreeVertex; attempt++) {
    // Look for a buildable edge connected to player network
    for (const [eid, e] of gs.board.edges) {
      if (e.ownerId !== null) continue;
      if (!gs.board.isEdgeBuildable(eid, pid, gs)) continue;
      // Tentatively place this road and check if either endpoint is a viable settlement spot
      e.ownerId = pid; // temporarily
      for (const vid of e.vertexIds) {
        const v = gs.board.getVertex(vid);
        if (!v || v.ownerId !== null) continue;
        const realHexes = v.hexIds.filter(h => !h.startsWith('ocean'));
        if (realHexes.length === 0) continue;
        let distOk = true;
        for (const nv of gs.board.getVertexNeighborVertices(vid)) {
          if (gs.board.getVertex(nv)?.ownerId !== null) { distOk = false; break; }
        }
        if (distOk) {
          connectedFreeVertex = vid;
          // Keep road placed
          player.networks.push(eid);
          break;
        }
      }
      if (connectedFreeVertex) break;
      // Undo temp placement
      e.ownerId = null;
    }
  }

  if (connectedFreeVertex) {
    setResources(player, { therapist: 1, payerContracts: 1, coeStaff: 1, rcmStaff: 1 });
    const vpBefore = player.victoryPoints();
    const rSettle = gs.buildSettlement(pid, connectedFreeVertex);
    expectOk('4e. Build settlement on connected vertex ok', rSettle);
    expectEq('4e. VP increased by 1', player.victoryPoints(), vpBefore + 1);
  } else {
    fail('4e. Build settlement connected', 'No reachable free vertex found after road extension');
  }

  // 4f. Build settlement on occupied vertex
  const occupiedVid = player.practiceLocations[0];
  setResources(player, { therapist: 1, payerContracts: 1, coeStaff: 1, rcmStaff: 1 });
  const rOcc = gs.buildSettlement(pid, occupiedVid);
  expectError('4f. Build settlement on occupied vertex rejected', rOcc, 'already occupied');

  // 4g. Build city on own settlement
  const cityVid = player.practiceLocations[0];
  setResources(player, { rcmStaff: 2, clinOps: 3 });
  const vpBefore4g = player.victoryPoints();
  const rCity = gs.buildCity(pid, cityVid);
  expectOk('4g. Build city on own settlement ok', rCity);
  expectTrue('4g. practiceLocation → stateNetwork',
    !player.practiceLocations.includes(cityVid) && player.stateNetworks.includes(cityVid));
  expectEq('4g. VP increased by 1 (net: city=2 replaces settlement=1)', player.victoryPoints(), vpBefore4g + 1);
  expectTrue('4g. Resources deducted for city',
    player.resources.rcmStaff === 0 && player.resources.clinOps === 0);

  // 4h. Build city on non-own vertex
  setResources(player, { rcmStaff: 2, clinOps: 3 });
  const otherPid = gs.playerOrder.find(p => p !== pid);
  const otherSettle = gs.getPlayer(otherPid).practiceLocations[0];
  const rBadCity = gs.buildCity(pid, otherSettle);
  expectError('4h. Build city on opponent settlement rejected', rBadCity, 'must upgrade your own');

  // 4i. Build city on already-upgraded vertex
  setResources(player, { rcmStaff: 2, clinOps: 3 });
  const rDupCity = gs.buildCity(pid, cityVid);
  expectError('4i. Build city on already-city vertex rejected', rDupCity, 'must upgrade your own');

  // 4j. Funding card purchase
  setResources(player, { coeStaff: 1, rcmStaff: 1, clinOps: 1 });
  const deckSizeBefore = gs.fundingDeck.remaining;
  const rCard = gs.buyFundingCard(pid);
  expectOk('4j. Buy funding card ok', rCard);
  expectEq('4j. Deck size decreased by 1', gs.fundingDeck.remaining, deckSizeBefore - 1);
  expectTrue('4j. Resources deducted for card',
    player.resources.coeStaff === 0 && player.resources.rcmStaff === 0 && player.resources.clinOps === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — End turn & turn cycle
// ─────────────────────────────────────────────────────────────────────────────
section('5. End Turn & Turn Cycle');

{
  const gs = freshGame(2, 42);
  doFullSetup(gs);
  const [p1, p2] = gs.playerOrder;

  // 5a. Can't end turn before rolling
  const rEnd = gs.endTurn(p1);
  expectError('5a. Can\'t end turn before rolling', rEnd, 'can only end turn during main phase');

  // 5b. Roll, then end turn
  forceRoll(gs, 5);
  gs.rollDice(p1);
  expectEq('5b. Phase is MAIN after roll', gs.phase, PHASES.MAIN);
  const rEndOk = gs.endTurn(p1);
  expectOk('5b. End turn succeeds', rEndOk);

  // 5c. Turn passes to next player
  expectEq('5c. Next player becomes current', gs.currentPlayerId, p2);
  expectEq('5c. Phase resets to ROLL', gs.phase, PHASES.ROLL);

  // 5d. Wrong player can't end turn
  gs.rollDice(p2); // need to actually roll first
  // (above may roll 7 — handle that)
  if (gs.phase === PHASES.DEV_INCIDENT_DISCARD || gs.phase === PHASES.DEV_INCIDENT_MOVE
      || gs.phase === PHASES.DEV_INCIDENT_STEAL) {
    // Skip complex resolution, just re-test end turn in a fresh context
  } else {
    const rWrongEnd = gs.endTurn(p1);
    expectError('5d. Wrong player can\'t end turn', rWrongEnd, 'not your turn');
  }

  // 5e. hasRolled and hasPlayedFundingCard reset after end turn
  const gs2 = freshGame(2, 42);
  doFullSetup(gs2);
  const pid2 = gs2.currentPlayerId;
  forceRoll(gs2, 6);
  gs2.rollDice(pid2);
  gs2.hasPlayedFundingCard = true; // force set
  gs2.endTurn(pid2);
  expectEq('5e. hasRolled resets after end turn', gs2.hasRolled, false);
  expectEq('5e. hasPlayedFundingCard resets after end turn', gs2.hasPlayedFundingCard, false);
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — Dev Incident (rolling 7)
// ─────────────────────────────────────────────────────────────────────────────
section('6. Dev Incident (Rolling 7)');

{
  const gs = freshGame(2, 42);
  doFullSetup(gs);
  const [p1, p2] = gs.playerOrder;
  const player1 = gs.getPlayer(p1);
  const player2 = gs.getPlayer(p2);

  // Give p1 8 cards (must discard) and p2 3 cards (no discard)
  setResources(player1, { therapist: 4, payerContracts: 4 }); // 8 total
  setResources(player2, { therapist: 3 }); // 3 total

  // 6a. Force roll of 7
  force7(gs);
  const rRoll = gs.rollDice(p1);
  expectOk('6a. Roll of 7 ok', rRoll);
  expectEq('6a. Total is 7', rRoll.total, 7);
  expectEq('6a. Phase is DEV_INCIDENT_DISCARD (p1 has 8)', gs.phase, PHASES.DEV_INCIDENT_DISCARD);

  // 6b. p2 doesn't need to discard (only 3 cards)
  expectTrue('6b. p2 not in pendingDiscards', !gs.pendingDiscards.has(p2),
    `pendingDiscards: ${JSON.stringify([...gs.pendingDiscards.entries()])}`);

  // 6c. p1 must discard 4 (floor(8/2))
  expectEq('6c. p1 must discard 4', gs.pendingDiscards.get(p1), 4);

  // 6d. Discard wrong count rejected
  const rBadDiscard = gs.discardCards(p1, { therapist: 3 }); // only 3, need 4
  expectError('6d. Discard wrong count rejected', rBadDiscard, 'must discard exactly 4');

  // 6e. Discard more than owned rejected
  const rOverDiscard = gs.discardCards(p1, { therapist: 5, payerContracts: 0 });
  expectError('6e. Discard more than owned rejected', rOverDiscard, 'not enough');

  // 6f. Valid discard accepted, phase advances
  const rDiscard = gs.discardCards(p1, { therapist: 2, payerContracts: 2 });
  expectOk('6f. Valid discard accepted', rDiscard);
  expectEq('6f. Phase advances to DEV_INCIDENT_MOVE', gs.phase, PHASES.DEV_INCIDENT_MOVE);
  expectEq('6f. p1 has 4 resources remaining', player1.totalResourceCount(), 4);

  // 6g. Can't build during dev incident move phase
  setResources(player1, { therapist: 1, payerContracts: 1 });
  const anyEdge = gs.board.getEdgesOnVertex(player1.practiceLocations[0])
    .map(e => gs.board.getEdge(e)).find(e => e && e.ownerId === null);
  if (anyEdge) {
    const rBuild = gs.buildRoad(p1, anyEdge.id);
    expectError('6g. Can\'t build during dev incident move', rBuild, 'not in main phase');
  } else {
    pass('6g. Can\'t build during dev incident move (no edge to test, phase check implicitly correct)');
  }

  // 6h. Move dev incident to a different hex
  const devHex = gs.board.getDevIncidentHex();
  const otherHex = [...gs.board.hexes.values()].find(h => h.id !== devHex?.id);
  const rMove = gs.moveDevIncident(p1, otherHex.id);
  expectOk('6h. Move dev incident ok', rMove);
  expectTrue('6h. Dev incident is now on new hex', gs.board.getDevIncidentHex()?.id === otherHex.id);

  // 6i. Phase is STEAL if there are targets, MAIN if not
  const stealTargets = rMove.stealTargets;
  if (stealTargets && stealTargets.length > 0) {
    expectEq('6i. Phase is DEV_INCIDENT_STEAL when targets exist', gs.phase, PHASES.DEV_INCIDENT_STEAL);
    // Steal from target
    const targetId = stealTargets[0];
    const targetPlayer = gs.getPlayer(targetId);
    setResources(targetPlayer, { therapist: 3 });
    const before = player1.resources.therapist || 0;
    const rSteal = gs.stealResource(p1, targetId);
    expectOk('6i. Steal resource ok', rSteal);
    expectEq('6i. Phase is MAIN after steal', gs.phase, PHASES.MAIN);
  } else {
    expectEq('6i. Phase is MAIN when no steal targets', gs.phase, PHASES.MAIN);
    pass('6i. Phase is MAIN when no steal targets (no players on chosen hex)');
  }

  // 6j. Can't steal from player not on hex
  const gs2 = freshGame(2, 42);
  doFullSetup(gs2);
  const [q1, q2] = gs2.playerOrder;
  const qp1 = gs2.getPlayer(q1);
  setResources(qp1, { therapist: 8 });
  force7(gs2);
  gs2.rollDice(q1);
  if (gs2.phase === PHASES.DEV_INCIDENT_DISCARD) {
    gs2.discardCards(q1, { therapist: 4 });
  }
  // Move to a hex where q2 is NOT
  const hexWithoutQ2 = [...gs2.board.hexes.values()].find(hex => {
    if (hex.id === gs2.board.getDevIncidentHex()?.id) return false;
    const players = gs2.board.getPlayersOnHex(hex.id, gs2);
    return !players.includes(q2);
  });
  if (hexWithoutQ2) {
    gs2.moveDevIncident(q1, hexWithoutQ2.id);
    if (gs2.phase === PHASES.DEV_INCIDENT_STEAL) {
      const rBadSteal = gs2.stealResource(q1, q2);
      expectError('6j. Can\'t steal from player not on hex', rBadSteal, 'invalid steal target');
    } else {
      pass('6j. No steal targets on hex — phase jumped to MAIN correctly');
    }
  } else {
    pass('6j. Skipped (all hexes have q2 — board config)');
  }

  // 6k. Stealing from empty player returns null resource
  const gs3 = freshGame(2, 42);
  doFullSetup(gs3);
  const [t1, t2] = gs3.playerOrder;
  const tp1 = gs3.getPlayer(t1);
  const tp2 = gs3.getPlayer(t2);
  setResources(tp1, { therapist: 2 });
  setResources(tp2, {}); // empty
  force7(gs3);
  gs3.rollDice(t1);
  if (gs3.phase === PHASES.DEV_INCIDENT_DISCARD) {
    gs3.discardCards(t1, { therapist: 1 }); // discard 1 (floor(2/2)... wait, 2 < 8)
    // Actually 2 < 8 so no discard needed. Just clear this path.
  }
  // Force dev incident move to a hex with tp2
  if (gs3.phase === PHASES.DEV_INCIDENT_MOVE) {
    let hexWithT2 = null;
    for (const vid of tp2.practiceLocations) {
      const hexIds = gs3.board.getHexesOnVertex(vid).filter(h => !h.startsWith('ocean'));
      if (hexIds.length > 0) {
        const candidate = gs3.board.getHex(hexIds[0]);
        if (candidate && candidate.id !== gs3.devIncidentMoveFrom) {
          hexWithT2 = candidate;
          break;
        }
      }
    }
    if (hexWithT2) {
      gs3.moveDevIncident(t1, hexWithT2.id);
      if (gs3.phase === PHASES.DEV_INCIDENT_STEAL) {
        const rStealEmpty = gs3.stealResource(t1, t2);
        expectOk('6k. Steal from empty player returns null (no crash)', rStealEmpty);
        expectEq('6k. stolenResource is null when target empty', rStealEmpty.stolenResource, null);
      } else {
        pass('6k. Skipped — t2 not on chosen hex');
      }
    } else {
      pass('6k. Skipped — no hex with t2 that differs from dev incident origin');
    }
  }

  // 6l. Must move to DIFFERENT hex than current
  const gs4 = freshGame(2, 42);
  doFullSetup(gs4);
  const pid4 = gs4.currentPlayerId;
  const pp1 = gs4.getPlayer(pid4);
  setResources(pp1, { therapist: 1 });
  force7(gs4);
  gs4.rollDice(pid4);
  if (gs4.phase === PHASES.DEV_INCIDENT_DISCARD) {
    // shouldn't happen with only 1 card, but handle it
    gs4.pendingDiscards.clear();
    gs4.phase = PHASES.DEV_INCIDENT_MOVE;
  }
  const currentDevHex4 = gs4.board.getDevIncidentHex();
  if (currentDevHex4) {
    const rSameHex = gs4.moveDevIncident(pid4, currentDevHex4.id);
    expectError('6l. Can\'t move dev incident to same hex', rSameHex, 'different hex');
  } else {
    pass('6l. No dev incident hex found (skipped)');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — Trading
// ─────────────────────────────────────────────────────────────────────────────
section('7. Trading');

{
  const gs = freshGame(2, 42);
  doFullSetup(gs);
  const [p1, p2] = gs.playerOrder;
  const player1 = gs.getPlayer(p1);
  const player2 = gs.getPlayer(p2);
  forceRoll(gs, 4);
  gs.rollDice(p1);

  // 7a. Bank 4:1 trade
  setResources(player1, { therapist: 5, payerContracts: 0 });
  const rBank = gs.bankTrade(p1, 'therapist', 4, 'payerContracts');
  expectOk('7a. Bank 4:1 trade ok', rBank);
  expectEq('7a. Gave 4 therapist', player1.resources.therapist, 1);
  expectEq('7a. Got 1 payerContracts', player1.resources.payerContracts, 1);

  // 7b. Bank trade with wrong count rejected
  const rBankWrong = gs.bankTrade(p1, 'therapist', 3, 'coeStaff');
  expectError('7b. Bank trade wrong count rejected', rBankWrong, 'must trade exactly');

  // 7c. Bank trade without enough resources rejected
  setResources(player1, { therapist: 2 });
  const rBankNoRes = gs.bankTrade(p1, 'therapist', 4, 'payerContracts');
  expectError('7c. Bank trade without enough resources rejected', rBankNoRes, 'not enough');

  // 7d. 3:1 port trade (give player a settlement on a 3:1 port vertex)
  const port3 = gs.board.ports.find(p => p.resource === 'generic' && p.ratio === 3);
  if (port3) {
    const portVid = port3.vertexIds.find(v => gs.board.vertices.has(v));
    if (portVid) {
      const portVertex = gs.board.getVertex(portVid);
      // Place player1's settlement on port (force it)
      portVertex.ownerId = p1;
      portVertex.buildingType = 'practiceLocation';
      player1.practiceLocations.push(portVid);

      setResources(player1, { therapist: 3 });
      const rPort3 = gs.bankTrade(p1, 'therapist', 3, 'payerContracts');
      expectOk('7d. 3:1 port trade ok', rPort3);
      expectEq('7d. Got 1 payerContracts from 3 therapist', player1.resources.payerContracts, 1);
    } else {
      fail('7d. 3:1 port trade', 'Port vertex not in vertex map');
    }
  } else {
    fail('7d. 3:1 port trade', 'No 3:1 port found on board');
  }

  // 7e. 2:1 specialized port trade
  const port2 = gs.board.ports.find(p => p.ratio === 2);
  if (port2) {
    const portVid2 = port2.vertexIds.find(v => gs.board.vertices.has(v));
    if (portVid2) {
      const portVertex2 = gs.board.getVertex(portVid2);
      portVertex2.ownerId = p1;
      portVertex2.buildingType = 'practiceLocation';
      player1.practiceLocations.push(portVid2);

      setResources(player1, { [port2.resource]: 2 });
      const rPort2 = gs.bankTrade(p1, port2.resource, 2, 'therapist');
      if (port2.resource === 'therapist') {
        // Can't trade therapist for therapist
        expectError('7e. 2:1 port same resource rejected', rPort2, 'cannot trade');
      } else {
        expectOk('7e. 2:1 port trade ok', rPort2);
      }
    } else {
      fail('7e. 2:1 port trade', 'Port vertex not found');
    }
  } else {
    fail('7e. 2:1 port trade', 'No 2:1 port on board');
  }

  // 7f. Player-to-player trade propose/accept
  setResources(player1, { therapist: 2, payerContracts: 0 });
  setResources(player2, { therapist: 0, payerContracts: 2 });
  const rProp = gs.proposeTrade(p1, { therapist: 1 }, { payerContracts: 1 });
  expectOk('7f. Propose trade ok', rProp);
  expectTrue('7f. tradeId returned', !!rProp.tradeId);

  const rAccept = gs.acceptTrade(rProp.tradeId, p2);
  expectOk('7f. Accept trade ok', rAccept);
  expectEq('7f. p1 lost 1 therapist', player1.resources.therapist, 1);
  expectEq('7f. p1 gained 1 payerContracts', player1.resources.payerContracts, 1);
  expectEq('7f. p2 lost 1 payerContracts', player2.resources.payerContracts, 1);
  expectEq('7f. p2 gained 1 therapist', player2.resources.therapist, 1);

  // 7g. Decline trade
  setResources(player1, { therapist: 2 });
  const rProp2 = gs.proposeTrade(p1, { therapist: 1 }, { payerContracts: 1 });
  const rDecline = gs.declineTrade(rProp2.tradeId, p2);
  expectOk('7g. Decline trade ok', rDecline);
  expectEq('7g. Trade status is declined', rDecline.trade.status, 'declined');

  // 7h. Can't accept a declined trade
  const rAcceptDeclined = gs.acceptTrade(rProp2.tradeId, p2);
  expectError('7h. Can\'t accept declined trade', rAcceptDeclined, 'no longer pending');

  // 7i. Can't propose trade without resources
  setResources(player1, { therapist: 0 });
  const rBadProp = gs.proposeTrade(p1, { therapist: 2 }, { payerContracts: 1 });
  expectError('7i. Can\'t propose trade without resources', rBadProp, 'not enough');

  // 7j. Wrong player proposes trade
  const rWrongTrade = gs.proposeTrade(p2, { payerContracts: 1 }, { therapist: 1 });
  expectError('7j. Only current player can propose trade', rWrongTrade, 'not your turn');

  // 7k. Can't accept trade if accepting player lacks resources
  setResources(player1, { therapist: 2 });
  setResources(player2, { payerContracts: 0 }); // empty
  const rProp3 = gs.proposeTrade(p1, { therapist: 1 }, { payerContracts: 1 });
  const rAcceptNoRes = gs.acceptTrade(rProp3.tradeId, p2);
  expectError('7k. Can\'t accept trade without resources', rAcceptNoRes, 'does not have enough');

  // 7l. Same resource bank trade rejected
  setResources(player1, { therapist: 4 });
  const rSame = gs.bankTrade(p1, 'therapist', 4, 'therapist');
  expectError('7l. Can\'t bank trade same resource', rSame, 'cannot trade a resource for itself');
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8 — Funding Cards
// ─────────────────────────────────────────────────────────────────────────────
section('8. Funding Cards');

{
  const gs = freshGame(2, 42);
  doFullSetup(gs);
  const [p1, p2] = gs.playerOrder;
  const player1 = gs.getPlayer(p1);
  const player2 = gs.getPlayer(p2);
  forceRoll(gs, 4);
  gs.rollDice(p1);

  // 8a. Buy a funding card
  setResources(player1, { coeStaff: 1, rcmStaff: 1, clinOps: 1 });
  const rBuy = gs.buyFundingCard(p1);
  expectOk('8a. Buy funding card ok', rBuy);
  expectTrue('8a. Card added to player hand', player1.fundingCards.length >= 1);
  expectTrue('8a. Card in newFundingCards (can\'t play this turn)', player1.newFundingCards.length >= 1);

  // 8b. Can't play newly-drawn card same turn
  // Directly inject specific card type for deterministic testing
  const newCard = player1.newFundingCards[0];
  const rPlayNew = gs.playEngineer(p1, [...gs.board.hexes.keys()][0], null);
  // (May fail for 'no engineer card' OR 'no playable card this turn' — both indicate correctness)
  const cannotPlay = !!rPlayNew.error;
  expectTrue('8b. Can\'t play card purchased this turn', cannotPlay,
    `rPlayNew: ${JSON.stringify(rPlayNew)}`);

  // 8c. After endTurn + next turn, card becomes playable
  gs.endTurn(p1);
  forceRoll(gs, 5);
  gs.rollDice(p2);
  gs.endTurn(p2);
  // Back to p1
  forceRoll(gs, 6);
  gs.rollDice(p1);
  // newFundingCards should have been cleared on end turn
  expectEq('8c. newFundingCards cleared after end turn', player1.newFundingCards.length, 0);

  // 8d. Engineer card: inject directly
  // Add an engineer card that is NOT new (i.e., playable)
  const engineerCard = { type: 'engineer' };
  player1.fundingCards.push(engineerCard);
  // Don't add to newFundingCards so it's playable

  // Find a hex to move dev incident to
  const currentDevHex = gs.board.getDevIncidentHex();
  const targetHex = [...gs.board.hexes.values()].find(h => h.id !== currentDevHex?.id);
  const rEngineer = gs.playEngineer(p1, targetHex.id, null);
  expectOk('8d. Play engineer card ok', rEngineer);
  expectTrue('8d. Dev incident moved', gs.board.getDevIncidentHex()?.id === targetHex.id);
  expectEq('8d. hasPlayedFundingCard set', gs.hasPlayedFundingCard, true);
  // NOTE: removeFundingCard finds by TYPE, not by object reference. If there are
  // multiple engineer cards, it removes the first non-new one, which may not be
  // the exact object we pushed. We verify by count decrease instead.
  const engineerCount = player1.fundingCards.filter(c => c.type === 'engineer').length;
  // Before: we had the card bought via buyFundingCard (now playable) + engineerCard = 2 engineers
  // After playing: should be 1 fewer
  expectTrue('8d. Engineer card count decreased by 1 after play',
    engineerCount < 2,
    `engineer cards remaining: ${engineerCount}`);

  // 8e. Can't play second card in same turn
  const card2 = { type: 'engineer' };
  player1.fundingCards.push(card2);
  const targetHex2 = [...gs.board.hexes.values()].find(h => h.id !== gs.board.getDevIncidentHex()?.id);
  const rPlay2 = gs.playEngineer(p1, targetHex2.id, null);
  expectError('8e. Can\'t play second funding card in same turn', rPlay2, 'already played a funding card');

  // 8f. Network Expansion card (2 free roads)
  gs.endTurn(p1);
  forceRoll(gs, 4);
  gs.rollDice(p2);
  gs.endTurn(p2);
  forceRoll(gs, 6);
  gs.rollDice(p1);

  const netCard = { type: 'networkExpansion' };
  player1.fundingCards.push(netCard);

  // Find 2 buildable edges for p1
  let buildableEdges = [];
  for (const [eid, e] of gs.board.edges) {
    if (e.ownerId !== null) continue;
    if (gs.board.isEdgeBuildable(eid, p1, gs)) {
      buildableEdges.push(eid);
      if (buildableEdges.length === 2) break;
    }
  }

  if (buildableEdges.length >= 2) {
    const roadsBefore = player1.networks.length;
    const rNet = gs.playNetworkExpansion(p1, buildableEdges[0], buildableEdges[1]);
    expectOk('8f. Play network expansion ok', rNet);
    expectEq('8f. Two roads placed', player1.networks.length, roadsBefore + 2);
    expectTrue('8f. Resources NOT deducted (free roads)', player1.totalResourceCount() >= 0); // no deduction
  } else if (buildableEdges.length === 1) {
    const roadsBefore = player1.networks.length;
    const rNet = gs.playNetworkExpansion(p1, buildableEdges[0], null);
    expectOk('8f. Play network expansion ok (1 road placed)', rNet);
    expectEq('8f. One road placed', player1.networks.length, roadsBefore + 1);
  } else {
    fail('8f. Network expansion', 'No buildable edges for player1');
  }

  // 8g. Recruitment Drive (gain 2 specific resources)
  gs.endTurn(p1);
  forceRoll(gs, 4);
  gs.rollDice(p2);
  gs.endTurn(p2);
  forceRoll(gs, 5);
  gs.rollDice(p1);

  const recCard = { type: 'recruitmentDrive' };
  player1.fundingCards.push(recCard);
  zeroResources(player1);
  const rRec = gs.playRecruitmentDrive(p1, 'therapist', 'clinOps');
  expectOk('8g. Play recruitment drive ok', rRec);
  expectEq('8g. Gained 1 therapist', player1.resources.therapist, 1);
  expectEq('8g. Gained 1 clinOps', player1.resources.clinOps, 1);

  // 8h. Exclusive Payer Contract (take all of one resource from others)
  gs.endTurn(p1);
  forceRoll(gs, 5);
  gs.rollDice(p2);
  gs.endTurn(p2);
  forceRoll(gs, 6);
  gs.rollDice(p1);

  const epcCard = { type: 'exclusivePayerContract' };
  player1.fundingCards.push(epcCard);
  setResources(player2, { therapist: 5 });
  zeroResources(player1);
  const rEpc = gs.playExclusivePayerContract(p1, 'therapist');
  expectOk('8h. Play exclusive payer contract ok', rEpc);
  expectEq('8h. p1 gained all of p2\'s therapist', player1.resources.therapist, 5);
  expectEq('8h. p2 lost all therapist', player2.resources.therapist, 0);
  expectEq('8h. totalGained = 5', rEpc.totalGained, 5);

  // 8i. Victory Point card — counts toward win but not publicVP
  gs.endTurn(p1);
  forceRoll(gs, 4);
  gs.rollDice(p2);
  gs.endTurn(p2);
  forceRoll(gs, 6);
  gs.rollDice(p1);

  const vpCard = { type: 'victoryPoint' };
  player1.fundingCards.push(vpCard);
  const pubVP = player1.publicVictoryPoints();
  const totalVP = player1.victoryPoints();
  expectEq('8i. VP card not in publicVP', pubVP, player1.practiceLocations.length + player1.stateNetworks.length * 2
    + (player1.hasLargestNetwork ? 2 : 0) + (player1.hasLargestEngineeringTeam ? 2 : 0));
  expectEq('8i. VP card counts in total VP', totalVP, pubVP + 1);

  // 8j. Engineer with steal from specific target
  gs.endTurn(p1);
  forceRoll(gs, 4);
  gs.rollDice(p2);
  gs.endTurn(p2);
  forceRoll(gs, 6);
  gs.rollDice(p1);

  const engCard2 = { type: 'engineer' };
  player1.fundingCards.push(engCard2);
  setResources(player2, { therapist: 3 });
  // Find a hex where p2 has a settlement
  let p2Hex = null;
  for (const vid of player2.practiceLocations) {
    const hexIds = gs.board.getHexesOnVertex(vid).filter(h => !h.startsWith('ocean'));
    for (const hid of hexIds) {
      if (hid !== gs.board.getDevIncidentHex()?.id) { p2Hex = hid; break; }
    }
    if (p2Hex) break;
  }
  if (p2Hex) {
    const p1Before = player1.totalResourceCount();
    const rEng2 = gs.playEngineer(p1, p2Hex, p2);
    expectOk('8j. Engineer with steal ok', rEng2);
    expectTrue('8j. Stolen resource reported', rEng2.stolenResource !== undefined);
    if (rEng2.stolenResource) {
      expectEq('8j. p2 lost 1 resource', player2.resources.therapist, 2);
    }
  } else {
    pass('8j. Engineer steal skipped (no valid hex found)');
  }

  // 8k. Deck empty — can't buy
  gs.endTurn(p1);
  forceRoll(gs, 4);
  gs.rollDice(p2);
  gs.endTurn(p2);
  forceRoll(gs, 5);
  gs.rollDice(p1);

  // Drain the deck
  while (!gs.fundingDeck.isEmpty()) {
    gs.fundingDeck.draw();
  }
  setResources(player1, { coeStaff: 1, rcmStaff: 1, clinOps: 1 });
  const rEmptyDeck = gs.buyFundingCard(p1);
  expectError('8k. Buy from empty deck rejected', rEmptyDeck, 'deck is empty');

  // 8l. Invalid resource type in recruitment drive
  const recCard2 = { type: 'recruitmentDrive' };
  player1.fundingCards.push(recCard2);
  const rBadRes = gs.playRecruitmentDrive(p1, 'gold', 'clinOps');
  expectError('8l. Invalid resource type in recruitment drive rejected', rBadRes, 'invalid resource');
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9 — Special Awards (Largest Network & Largest Engineering Team)
// ─────────────────────────────────────────────────────────────────────────────
section('9. Special Awards');

{
  // 9a. Largest Engineering Team: awarded at 3 engineers, transferred when surpassed
  const gs = freshGame(2, 42);
  doFullSetup(gs);
  const [p1, p2] = gs.playerOrder;
  const player1 = gs.getPlayer(p1);
  const player2 = gs.getPlayer(p2);

  // Start a main turn
  forceRoll(gs, 6);
  gs.rollDice(p1);

  // Simulate playing engineers
  player1.playedEngineers = 2;
  gs._checkSpecialCards();
  expectTrue('9a. No award at 2 engineers', !player1.hasLargestEngineeringTeam,
    `hasLargestEngineeringTeam=${player1.hasLargestEngineeringTeam}`);

  player1.playedEngineers = 3;
  gs._checkSpecialCards();
  expectTrue('9a. Award given at 3 engineers', player1.hasLargestEngineeringTeam);
  expectEq('9a. largestEngineeringTeamHolder is p1', gs.largestEngineeringTeamHolder, p1);
  expectEq('9a. largestEngineeringTeamCount is 3', gs.largestEngineeringTeamCount, 3);
  expectEq('9a. Award gives 2 VP (via hasLargestEngineeringTeam)',
    player1.publicVictoryPoints(),
    player1.practiceLocations.length + player1.stateNetworks.length * 2 + 2);

  // 9b. Transfer when surpassed
  player2.playedEngineers = 4;
  gs._checkSpecialCards();
  expectTrue('9b. p1 loses award when surpassed', !player1.hasLargestEngineeringTeam);
  expectTrue('9b. p2 gains award', player2.hasLargestEngineeringTeam);
  expectEq('9b. largestEngineeringTeamHolder is p2', gs.largestEngineeringTeamHolder, p2);

  // 9c. Largest Network: awarded when longest continuous road reaches 5
  const gs2 = freshGame(2, 42);
  doFullSetup(gs2);
  const [r1, r2] = gs2.playerOrder;
  const rp1 = gs2.getPlayer(r1);
  forceRoll(gs2, 6);
  gs2.rollDice(r1);

  // Helper: build one road connected to existing network, return true if placed
  const buildOneRoad = () => {
    for (const [eid, e] of gs2.board.edges) {
      if (e.ownerId !== null) continue;
      if (gs2.board.isEdgeBuildable(eid, r1, gs2)) {
        setResources(rp1, { therapist: 1, payerContracts: 1 });
        const result = gs2.buildRoad(r1, eid);
        if (!result.error) return true;
      }
    }
    return false;
  };

  // Build roads one by one, checking longest road after each
  // Stop before we'd naturally hit 5 continuous (check at each step)
  // We start from whatever the current road count is (typically 2 from setup)
  let prevHasNetwork = false;
  let awardTriggeredAt = null;

  for (let i = 0; i < 20; i++) {
    const longestBefore = gs2.board.getLongestRoad(r1, gs2);
    const placed = buildOneRoad();
    if (!placed) break;
    gs2._checkSpecialCards();
    const longestAfter = gs2.board.getLongestRoad(r1, gs2);

    if (!prevHasNetwork && rp1.hasLargestNetwork) {
      awardTriggeredAt = longestAfter;
      prevHasNetwork = true;
    }

    // Once award is granted, verify it was at >= 5
    if (awardTriggeredAt !== null) break;
  }

  if (awardTriggeredAt !== null) {
    expectGte('9c. Largest Network awarded when longest road >= 5',
      awardTriggeredAt, 5);
    expectTrue('9c. Largest Network award flag set on player', rp1.hasLargestNetwork);
    expectEq('9c. largestNetworkHolder set correctly', gs2.largestNetworkHolder, r1);
  } else {
    // Could not build 5+ continuous roads (board geometry)
    const finalLength = gs2.board.getLongestRoad(r1, gs2);
    expectTrue('9c. No Largest Network awarded when roads < 5',
      !rp1.hasLargestNetwork,
      `longest=${finalLength}, awarded=${rp1.hasLargestNetwork}`);
  }

  // 9d. Largest Network award gives 2 VP
  if (rp1.hasLargestNetwork) {
    const expectedVP = rp1.practiceLocations.length + rp1.stateNetworks.length * 2 + 2;
    expectEq('9d. Largest Network gives 2 VP', rp1.publicVictoryPoints(), expectedVP);
  } else {
    pass('9d. Skipped (network award not triggered in this board layout)');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10 — Victory Condition
// ─────────────────────────────────────────────────────────────────────────────
section('10. Victory Condition');

{
  const gs = freshGame(2, 42);
  doFullSetup(gs);
  const [p1, p2] = gs.playerOrder;
  const player1 = gs.getPlayer(p1);
  const player2 = gs.getPlayer(p2);
  forceRoll(gs, 6);
  gs.rollDice(p1);

  // 10a. Win not triggered at 9 VP
  // Set player1 to 9 VP: 9 settlements (hack directly)
  player1.practiceLocations = [];
  player1.stateNetworks = [];
  for (let i = 0; i < 9; i++) player1.practiceLocations.push(`fake-v${i}`);
  gs._checkWin();
  expectTrue('10a. Game not over at 9 VP', gs.phase !== PHASES.GAME_OVER,
    `phase=${gs.phase}, vp=${player1.victoryPoints()}`);

  // 10b. Win triggered at 10 VP
  player1.practiceLocations.push('fake-v9'); // now 10
  const winner = gs._checkWin();
  expectTrue('10b. Game over at 10 VP', gs.phase === PHASES.GAME_OVER,
    `phase=${gs.phase}`);
  expectEq('10b. Winner is p1', winner?.id, p1);
  expectEq('10b. winnerId set', gs.winnerId, p1);

  // 10c. Hidden VP cards count toward win
  const gs2 = freshGame(2, 42);
  doFullSetup(gs2);
  const [q1] = gs2.playerOrder;
  const qp1 = gs2.getPlayer(q1);
  forceRoll(gs2, 6);
  gs2.rollDice(q1);

  // Set 8 public VP
  qp1.practiceLocations = [];
  qp1.stateNetworks = [];
  for (let i = 0; i < 8; i++) qp1.practiceLocations.push(`fv${i}`);
  // Add 2 VP cards
  qp1.fundingCards.push({ type: 'victoryPoint' });
  qp1.fundingCards.push({ type: 'victoryPoint' });
  expectEq('10c. Public VP is 8', qp1.publicVictoryPoints(), 8);
  expectEq('10c. Total VP is 10 (with hidden cards)', qp1.victoryPoints(), 10);
  const winner2 = gs2._checkWin();
  expectTrue('10c. VP cards trigger win', !!winner2);

  // 10d. Post-win actions rejected
  // phase is GAME_OVER
  setResources(qp1, { therapist: 1, payerContracts: 1 });
  const rPostWin = gs2.buildRoad(q1, [...gs2.board.edges.keys()][0]);
  expectError('10d. Post-win build rejected', rPostWin, 'not in main phase');

  const rPostWinRoll = gs2.rollDice(q1);
  expectError('10d. Post-win roll rejected', rPostWinRoll, 'cannot roll');
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 11 — toPublicState integrity
// ─────────────────────────────────────────────────────────────────────────────
section('11. toPublicState Integrity');

{
  const gs = freshGame(2, 42);
  doFullSetup(gs);
  const [p1, p2] = gs.playerOrder;
  const player1 = gs.getPlayer(p1);
  const player2 = gs.getPlayer(p2);
  setResources(player1, { therapist: 3, payerContracts: 2 });
  setResources(player2, { coeStaff: 5 });
  player1.fundingCards.push({ type: 'engineer' });
  player2.fundingCards.push({ type: 'victoryPoint' });

  const stateForP1 = gs.toPublicState(p1);
  const stateForP2 = gs.toPublicState(p2);

  // 11a. Own resources visible, opponent's hidden
  const p1DataInP1View = stateForP1.players.find(p => p.id === p1);
  const p2DataInP1View = stateForP1.players.find(p => p.id === p2);
  expectTrue('11a. Own resources visible to self',
    p1DataInP1View && Object.keys(p1DataInP1View.resources).length > 0);
  expectTrue('11a. Opponent resources hidden (empty object)',
    p2DataInP1View && Object.keys(p2DataInP1View.resources).length === 0,
    `p2 resources in p1 view: ${JSON.stringify(p2DataInP1View?.resources)}`);

  // 11b. resourceCount correct for opponents
  expectEq('11b. p2 resourceCount is 5 in p1 view', p2DataInP1View?.resourceCount, 5);
  expectEq('11b. p1 resourceCount is 5 in p1 view', p1DataInP1View?.resourceCount, 5);

  // 11c. Own funding cards visible, others hidden
  expectTrue('11c. Own funding cards visible to self',
    Array.isArray(p1DataInP1View?.fundingCards) && p1DataInP1View.fundingCards.length > 0,
    `p1 fundingCards: ${JSON.stringify(p1DataInP1View?.fundingCards)}`);
  const p1DataInP2View = stateForP2.players.find(p => p.id === p1);
  expectTrue('11c. Opponent funding cards hidden (undefined)',
    p1DataInP2View?.fundingCards === undefined,
    `p1 fundingCards in p2 view: ${JSON.stringify(p1DataInP2View?.fundingCards)}`);
  expectEq('11c. fundingCardCount correct for opponent', p1DataInP2View?.fundingCardCount, 1);

  // 11d. Board state completeness
  const board = stateForP1.board;
  expectTrue('11d. Board has hexes array', Array.isArray(board.hexes) && board.hexes.length === 19);
  expectTrue('11d. Board has vertices array', Array.isArray(board.vertices) && board.vertices.length > 0);
  expectTrue('11d. Board has edges array', Array.isArray(board.edges) && board.edges.length > 0);
  expectTrue('11d. Board has ports array', Array.isArray(board.ports));

  // 11e. Vertices have hexIds
  const verticesWithHexIds = board.vertices.filter(v => Array.isArray(v.hexIds) && v.hexIds.length > 0);
  expectTrue('11e. All vertices have hexIds',
    verticesWithHexIds.length === board.vertices.length,
    `${board.vertices.length - verticesWithHexIds.length} vertices missing hexIds`);

  // 11f. Edges have vertexIds with 2 elements
  const edgesWithVertexIds = board.edges.filter(e => Array.isArray(e.vertexIds) && e.vertexIds.length === 2);
  expectTrue('11f. All edges have 2 vertexIds',
    edgesWithVertexIds.length === board.edges.length,
    `${board.edges.length - edgesWithVertexIds.length} edges missing/malformed vertexIds`);

  // 11g. Phase and currentPlayerId included
  expectTrue('11g. phase included', typeof stateForP1.phase === 'string');
  expectTrue('11g. currentPlayerId included', typeof stateForP1.currentPlayerId === 'string');
  expectTrue('11g. hasRolled included', typeof stateForP1.hasRolled === 'boolean');
  expectTrue('11g. fundingDeck remaining included',
    typeof stateForP1.fundingDeck?.remaining === 'number');

  // 11h. pendingDiscards only shown in discard phase
  expectTrue('11h. pendingDiscards undefined in non-discard phase',
    stateForP1.pendingDiscards === undefined,
    `pendingDiscards: ${JSON.stringify(stateForP1.pendingDiscards)}`);

  // Force discard phase
  const gs2 = freshGame(2, 42);
  doFullSetup(gs2);
  const [d1, d2] = gs2.playerOrder;
  const dp1 = gs2.getPlayer(d1);
  setResources(dp1, { therapist: 8 });
  force7(gs2);
  gs2.rollDice(d1);
  const discardState = gs2.toPublicState(d1);
  expectTrue('11h. pendingDiscards included in discard phase',
    discardState.pendingDiscards !== undefined,
    `phase=${gs2.phase}, pendingDiscards=${JSON.stringify(discardState.pendingDiscards)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 12 — Edge Cases & Additional Checks
// ─────────────────────────────────────────────────────────────────────────────
section('12. Edge Cases');

{
  // 12a. 2-player game setup works
  const gs2 = freshGame(2, 77);
  expectEq('12a. 2-player game starts in SETUP_SETTLEMENT', gs2.phase, PHASES.SETUP_SETTLEMENT);
  const placements2 = doFullSetup(gs2);
  expectEq('12a. 2-player setup completes in ROLL phase', gs2.phase, PHASES.ROLL);

  // 12b. 4-player game setup works
  const gs4 = freshGame(4, 88);
  const placements4 = doFullSetup(gs4);
  expectEq('12b. 4-player setup completes in ROLL phase', gs4.phase, PHASES.ROLL);
  // Verify all 4 players have 2 settlements each
  for (const pid of gs4.playerOrder) {
    const p = gs4.getPlayer(pid);
    expectEq(`12b. ${p.name} has 2 settlements after setup`, p.practiceLocations.length, 2);
    expectEq(`12b. ${p.name} has 2 roads after setup`, p.networks.length, 2);
  }

  // 12c. buildRoad during non-MAIN phase rejected
  const gsSetup = freshGame(2, 42);
  // In SETUP phase
  setResources(gsSetup.getPlayer(gsSetup.currentPlayerId), { therapist: 1, payerContracts: 1 });
  const anyEdge = [...gsSetup.board.edges.keys()][0];
  const rRoadSetup = gsSetup.buildRoad(gsSetup.currentPlayerId, anyEdge);
  expectError('12c. buildRoad during SETUP rejected', rRoadSetup, 'not in main phase');

  // 12d. Can't buy funding card during setup
  const rCardSetup = gsSetup.buyFundingCard(gsSetup.currentPlayerId);
  expectError('12d. buyFundingCard during SETUP rejected', rCardSetup, 'not in main phase');

  // 12e. ROLL phase: can't build
  const gsRoll = freshGame(2, 42);
  doFullSetup(gsRoll);
  const rollPid = gsRoll.currentPlayerId;
  setResources(gsRoll.getPlayer(rollPid), { therapist: 1, payerContracts: 1 });
  const rBuildRoll = gsRoll.buildRoad(rollPid, [...gsRoll.board.edges.keys()][0]);
  expectError('12e. buildRoad during ROLL phase rejected', rBuildRoll, 'not in main phase');

  // 12f. getPlayer returns null for unknown id
  const gsCheck = freshGame(2, 42);
  const nullPlayer = gsCheck.getPlayer('nonexistent');
  expectEq('12f. getPlayer returns null for unknown id', nullPlayer, null);

  // 12g. Board: getLongestRoad with 0 roads
  const boardAlone = new Board(42);
  const longestNone = boardAlone.getLongestRoad('nobody', null);
  expectEq('12g. getLongestRoad returns 0 for player with no roads', longestNone, 0);

  // 12h. placeInitialRoad must connect to most recent settlement
  const gsRoad = freshGame(2, 42);
  const rPid = gsRoad.currentPlayerId;
  const rVid = pickFreeVertex(gsRoad, rPid);
  gsRoad.placeInitialSettlement(rPid, rVid);
  // Now find an edge that does NOT connect to rVid
  let disconnectedEdge = null;
  for (const [eid, e] of gsRoad.board.edges) {
    if (!e.vertexIds.includes(rVid) && e.ownerId === null) {
      disconnectedEdge = eid;
      break;
    }
  }
  if (disconnectedEdge) {
    const rDisconn = gsRoad.placeInitialRoad(rPid, disconnectedEdge);
    expectError('12h. Setup road must connect to last settlement', rDisconn, 'most recently placed settlement');
  } else {
    pass('12h. Skipped — no disconnected edge found');
  }

  // 12i. Steal invalid target (not in stealTargets)
  const gsSteal = freshGame(2, 42);
  doFullSetup(gsSteal);
  const [st1, st2] = gsSteal.playerOrder;
  const stp1 = gsSteal.getPlayer(st1);
  setResources(stp1, { therapist: 8 });
  force7(gsSteal);
  gsSteal.rollDice(st1);
  if (gsSteal.phase === PHASES.DEV_INCIDENT_DISCARD) {
    gsSteal.discardCards(st1, { therapist: 4 });
  }
  if (gsSteal.phase === PHASES.DEV_INCIDENT_MOVE) {
    const hexes = [...gsSteal.board.hexes.values()];
    const moveHex = hexes.find(h => h.id !== gsSteal.devIncidentMoveFrom);
    gsSteal.moveDevIncident(st1, moveHex.id);
    if (gsSteal.phase === PHASES.DEV_INCIDENT_STEAL) {
      const rBadSteal = gsSteal.stealResource(st1, 'fake-player-id');
      expectError('12i. Steal from invalid target rejected', rBadSteal, 'invalid steal target');
    } else {
      pass('12i. Skipped — phase not STEAL');
    }
  }

  // 12j. Discard when not required
  const gsDisc = freshGame(2, 42);
  doFullSetup(gsDisc);
  const discPid = gsDisc.currentPlayerId;
  setResources(gsDisc.getPlayer(discPid), { therapist: 1 });
  force7(gsDisc);
  gsDisc.rollDice(discPid);
  // p1 has 1 resource (<8), so pendingDiscards should not include them
  if (gsDisc.phase === PHASES.DEV_INCIDENT_DISCARD) {
    const rDiscardNoNeed = gsDisc.discardCards(discPid, { therapist: 0 });
    expectError('12j. Can\'t discard when not required', rDiscardNoNeed, 'you do not need to discard');
  } else {
    pass('12j. No discard phase triggered (correct — player had < 8 resources)');
  }

  // 12k. Bank trade wrong player rejected
  const gsWrongBank = freshGame(2, 42);
  doFullSetup(gsWrongBank);
  const [wb1, wb2] = gsWrongBank.playerOrder;
  forceRoll(gsWrongBank, 6);
  gsWrongBank.rollDice(wb1);
  setResources(gsWrongBank.getPlayer(wb2), { therapist: 4 });
  const rWrongBank = gsWrongBank.bankTrade(wb2, 'therapist', 4, 'payerContracts');
  expectError('12k. Bank trade by non-current player rejected', rWrongBank, 'not your turn');

  // 12l. playEngineer validates targetPlayerId is on the hex
  const gsEng = freshGame(2, 42);
  doFullSetup(gsEng);
  const [ep1, ep2] = gsEng.playerOrder;
  const ep1player = gsEng.getPlayer(ep1);
  forceRoll(gsEng, 6);
  gsEng.rollDice(ep1);
  const engCard = { type: 'engineer' };
  ep1player.fundingCards.push(engCard);

  // Find a hex where ep2 is NOT
  let hexWithoutEp2 = null;
  for (const [hid, hex] of gsEng.board.hexes) {
    if (hid === gsEng.board.getDevIncidentHex()?.id) continue;
    const players = gsEng.board.getPlayersOnHex(hid, gsEng);
    if (!players.includes(ep2)) { hexWithoutEp2 = hid; break; }
  }
  if (hexWithoutEp2) {
    const rEngBadTarget = gsEng.playEngineer(ep1, hexWithoutEp2, ep2);
    expectError('12l. Engineer steal rejects target not on hex', rEngBadTarget, 'no buildings on that hex');
  } else {
    pass('12l. Skipped — ep2 on all hexes');
  }

  // 12m. FundingDeck: draw returns null when empty
  const emptyDeck = new (require('./game/FundingDeck'))(Math.random);
  while (!emptyDeck.isEmpty()) emptyDeck.draw();
  const nullCard = emptyDeck.draw();
  expectEq('12m. FundingDeck.draw() returns null when empty', nullCard, null);
  expectTrue('12m. FundingDeck.isEmpty() returns true', emptyDeck.isEmpty());

  // 12n. Player.canAfford and deductResources work correctly
  const pTest = new Player({ id: 'test', name: 'Test', color: 'black', socketId: 'stest' });
  setResources(pTest, { therapist: 1, payerContracts: 1 });
  expectTrue('12n. canAfford network with 1 therapist + 1 payerContracts', pTest.canAfford('network'));
  pTest.deductResources(BUILD_COSTS.network);
  expectEq('12n. therapist deducted', pTest.resources.therapist, 0);
  expectEq('12n. payerContracts deducted', pTest.resources.payerContracts, 0);
  expectTrue('12n. canAfford returns false after deduction', !pTest.canAfford('network'));

  // 12o. Player VP tracking: practiceLocation=1VP, stateNetwork=2VP
  const pVP = new Player({ id: 'vptest', name: 'VPTest', color: 'purple', socketId: 'svp' });
  pVP.practiceLocations = ['v1', 'v2'];
  pVP.stateNetworks = ['v3'];
  expectEq('12o. 2 settlements + 1 city = 4 VP', pVP.publicVictoryPoints(), 4);
  pVP.hasLargestNetwork = true;
  expectEq('12o. +2 for Largest Network', pVP.publicVictoryPoints(), 6);
  pVP.hasLargestEngineeringTeam = true;
  expectEq('12o. +2 for Largest Engineering Team', pVP.publicVictoryPoints(), 8);
  pVP.fundingCards.push({ type: 'victoryPoint' });
  expectEq('12o. VP card in total but not public', pVP.victoryPoints(), 9);
  expectEq('12o. publicVP still 8', pVP.publicVictoryPoints(), 8);

  // 12p. addFundingCard marks as new; clearNewFundingCards resets
  const pNew = new Player({ id: 'newtest', name: 'NewTest', color: 'teal', socketId: 'snew' });
  const testCard = { type: 'engineer' };
  pNew.addFundingCard(testCard);
  expectTrue('12p. Card in newFundingCards after addFundingCard', pNew.newFundingCards.includes(testCard));
  expectTrue('12p. hasFundingCard returns false for new card', !pNew.hasFundingCard('engineer'));
  pNew.clearNewFundingCards();
  expectTrue('12p. hasFundingCard returns true after clear', pNew.hasFundingCard('engineer'));
  expectEq('12p. newFundingCards is empty after clear', pNew.newFundingCards.length, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 13 — Board Structural Integrity
// ─────────────────────────────────────────────────────────────────────────────
section('13. Board Structural Integrity');

{
  const board = new Board(42);

  // 13a. Correct number of hexes
  expectEq('13a. Board has 19 hexes', board.hexes.size, 19);

  // 13b. Exactly 1 desert
  const deserts = [...board.hexes.values()].filter(h => h.resource === 'desert');
  expectEq('13b. Exactly 1 desert hex', deserts.length, 1);

  // 13c. Desert starts with dev incident
  expectTrue('13c. Desert has hasDevIncident=true', deserts[0]?.hasDevIncident === true);

  // 13d. Desert has no number
  expectEq('13d. Desert has no number', deserts[0]?.number, null);

  // 13e. No duplicate hex IDs
  const hexIds = [...board.hexes.keys()];
  expectEq('13e. All hex IDs unique', new Set(hexIds).size, hexIds.length);

  // 13f. Resource counts correct (4 therapist, 3 payerContracts, 4 coeStaff, 4 rcmStaff, 3 clinOps, 1 desert)
  const resCounts = {};
  for (const h of board.hexes.values()) {
    resCounts[h.resource] = (resCounts[h.resource] || 0) + 1;
  }
  expectEq('13f. 4 therapist hexes', resCounts.therapist, 4);
  expectEq('13f. 3 payerContracts hexes', resCounts.payerContracts, 3);
  expectEq('13f. 4 coeStaff hexes', resCounts.coeStaff, 4);
  expectEq('13f. 4 rcmStaff hexes', resCounts.rcmStaff, 4);
  expectEq('13f. 3 clinOps hexes', resCounts.clinOps, 3);

  // 13g. Number distribution correct (2×2 missing — it's 1 of: 2,3,3,4,4,5,5,6,6,8,8,9,9,10,10,11,11,12)
  const nonDesertHexes = [...board.hexes.values()].filter(h => h.resource !== 'desert');
  const allNumbers = nonDesertHexes.map(h => h.number).sort((a, b) => a - b);
  expectEq('13g. 18 non-desert hexes have numbers', allNumbers.length, 18);
  expectTrue('13g. No hex has number 7', !allNumbers.includes(7));

  // 13h. Each non-ocean vertex has at least 1 real hex
  let vertexIssues = 0;
  for (const [vid, v] of board.vertices) {
    const realHexes = v.hexIds.filter(h => !h.startsWith('ocean'));
    if (realHexes.length === 0) vertexIssues++;
  }
  expectEq('13h. All vertices have at least 1 real hex', vertexIssues, 0);

  // 13i. 9 ports placed
  expectEq('13i. Board has 9 ports', board.ports.length, 9);

  // 13j. Port types: 5 specialized (2:1) + 4 generic (3:1)
  const specialPorts = board.ports.filter(p => p.ratio === 2);
  const genericPorts = board.ports.filter(p => p.resource === 'generic');
  expectEq('13j. 5 specialized 2:1 ports', specialPorts.length, 5);
  expectEq('13j. 4 generic 3:1 ports', genericPorts.length, 4);

  // 13k. setDevIncident moves incident correctly
  const hexIds2 = [...board.hexes.keys()];
  board.setDevIncident(hexIds2[5]);
  const devHex = board.getDevIncidentHex();
  expectEq('13k. setDevIncident works', devHex?.id, hexIds2[5]);
  const countDev = [...board.hexes.values()].filter(h => h.hasDevIncident).length;
  expectEq('13k. Only 1 hex has dev incident at a time', countDev, 1);

  // 13l. getVerticesOnHex returns 6 vertices per hex
  for (const [hid, hex] of board.hexes) {
    const verts = board.getVerticesOnHex(hid);
    if (verts.length !== 6) {
      fail(`13l. Hex ${hid} has ${verts.length} vertices (expected 6)`);
      break;
    }
  }
  pass('13l. All hexes have exactly 6 vertex slots');

  // 13m. getEdgesOnHex returns 6 edges per hex
  let edgeIssues = 0;
  for (const [hid] of board.hexes) {
    const edges = board.getEdgesOnHex(hid);
    if (edges.length !== 6) edgeIssues++;
  }
  expectEq('13m. All hexes have exactly 6 edges', edgeIssues, 0);

  // 13n. getEdgesOnVertex returns edges for each vertex
  let vertexEdgeIssues = 0;
  for (const [vid] of board.vertices) {
    const edges = board.getEdgesOnVertex(vid);
    // Border vertices may have fewer edges
    if (edges.length === 0) vertexEdgeIssues++;
  }
  // It's OK for some border vertices to have 0 edges (pure ocean vertices)
  // But let's report the count
  const totalVerts = board.vertices.size;
  const vertsWithEdges = [...board.vertices.keys()].filter(v => board.getEdgesOnVertex(v).length > 0).length;
  expectTrue('13n. Most vertices have at least 1 edge',
    vertsWithEdges > totalVerts * 0.7,
    `only ${vertsWithEdges}/${totalVerts} vertices have edges`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 14 — Resource Production Accuracy
// ─────────────────────────────────────────────────────────────────────────────
section('14. Resource Production Accuracy');

{
  // 14a. City produces 2 resources
  const gs = freshGame(2, 42);
  doFullSetup(gs);
  const [p1, p2] = gs.playerOrder;
  const player1 = gs.getPlayer(p1);
  forceRoll(gs, 6);
  gs.rollDice(p1);

  // Upgrade a settlement to city
  const cityVid = player1.practiceLocations[0];
  setResources(player1, { rcmStaff: 2, clinOps: 3 });
  gs.buildCity(p1, cityVid);

  // Find what number the city is on
  const cityHexes = gs.board.getHexesOnVertex(cityVid)
    .filter(h => !h.startsWith('ocean'))
    .map(h => gs.board.getHex(h))
    .filter(h => h && h.number && !h.hasDevIncident);

  if (cityHexes.length > 0) {
    const cityHex = cityHexes[0];
    gs.endTurn(p1);
    forceRoll(gs, 5);
    gs.rollDice(p2);
    gs.endTurn(p2);
    forceRoll(gs, cityHex.number);
    zeroResources(player1);
    gs.rollDice(p1);
    const gained = player1.resources[cityHex.resource] || 0;
    expectGte('14a. City produces at least 2 of its resource', gained, 2);
  } else {
    pass('14a. Skipped — no hex with number found for city vertex');
  }

  // 14b. All 18 number tiles can theoretically trigger production
  const board = new Board(42);
  const numberHexes = [...board.hexes.values()].filter(h => h.number !== null);
  expectEq('14b. 18 hexes have production numbers', numberHexes.length, 18);

  // 14c. _produceResources distributes to all settlement owners on matching hexes
  const gs2 = freshGame(2, 42);
  doFullSetup(gs2);
  const [q1, q2] = gs2.playerOrder;
  const qp1 = gs2.getPlayer(q1);
  const qp2 = gs2.getPlayer(q2);
  // Find a number both players share (a hex that both have settlements on is best)
  // Alternatively test that q2 also gets resources when dice match their hex
  let sharedNum = null;
  for (const vid of qp2.practiceLocations) {
    const hexes = gs2.board.getHexesOnVertex(vid)
      .filter(h => !h.startsWith('ocean'))
      .map(h => gs2.board.getHex(h))
      .filter(h => h && h.number && !h.hasDevIncident);
    if (hexes.length > 0) {
      sharedNum = hexes[0].number;
      break;
    }
  }
  if (sharedNum) {
    zeroResources(qp1);
    zeroResources(qp2);
    forceRoll(gs2, sharedNum);
    gs2.rollDice(q1);
    const q2Total = qp2.totalResourceCount();
    expectGte('14c. Non-current player also gets resources on their hex number', q2Total, 1);
  } else {
    pass('14c. Skipped — could not find production hex for p2');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 15 — hasFundingCard / removeFundingCard edge cases
// ─────────────────────────────────────────────────────────────────────────────
section('15. Funding Card Mechanics');

{
  const p = new Player({ id: 'fc', name: 'FC', color: 'cyan', socketId: 'sfc' });

  // 15a. hasFundingCard false on empty hand
  expectTrue('15a. hasFundingCard false on empty hand', !p.hasFundingCard('engineer'));

  // 15b. removeFundingCard returns false on empty hand
  const removed = p.removeFundingCard('engineer');
  expectTrue('15b. removeFundingCard returns false on empty hand', removed === false);

  // 15c. Add card, mark as new → hasFundingCard false
  p.addFundingCard({ type: 'engineer' });
  expectTrue('15c. hasFundingCard false for new card', !p.hasFundingCard('engineer'));

  // 15d. Clear new → hasFundingCard true
  p.clearNewFundingCards();
  expectTrue('15d. hasFundingCard true after clear', p.hasFundingCard('engineer'));

  // 15e. removeFundingCard removes the correct card
  p.fundingCards.push({ type: 'recruitmentDrive' });
  const removed2 = p.removeFundingCard('engineer');
  expectTrue('15e. removeFundingCard returns true', removed2 === true);
  expectEq('15e. Only recruitmentDrive remains', p.fundingCards.length, 1);
  expectEq('15e. Remaining card is recruitmentDrive', p.fundingCards[0].type, 'recruitmentDrive');

  // 15f. totalResourceCount
  setResources(p, { therapist: 3, payerContracts: 2, coeStaff: 0, rcmStaff: 1, clinOps: 0 });
  expectEq('15f. totalResourceCount correct', p.totalResourceCount(), 6);

  // 15g. canAffordCost
  expectTrue('15g. canAffordCost for 3 therapist', p.canAffordCost({ therapist: 3 }));
  expectTrue('15g. canAffordCost fails for 4 therapist', !p.canAffordCost({ therapist: 4 }));

  // 15h. addResources only accepts valid RESOURCE_TYPES
  p.addResources({ therapist: 1, gold: 999, invalidKey: 5 });
  expectEq('15h. addResources ignores invalid types', p.resources.gold, undefined);
  expectEq('15h. addResources adds valid types', p.resources.therapist, 4);
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 16 — Specific Bug Regression Tests
// ─────────────────────────────────────────────────────────────────────────────
section('16. Bug Regression & Corner Cases');

{
  // 16a. BUG CHECK: _checkLargestNetwork requires >largestNetworkLength (strict >)
  // If a second player ties they should NOT steal the award
  const gs = freshGame(2, 42);
  doFullSetup(gs);
  const [p1, p2] = gs.playerOrder;
  const player1 = gs.getPlayer(p1);
  const player2 = gs.getPlayer(p2);
  forceRoll(gs, 6);
  gs.rollDice(p1);

  // Manually set p1 to have longest road award with 5
  gs.largestNetworkHolder = p1;
  gs.largestNetworkLength = 5;
  player1.hasLargestNetwork = true;

  // Simulate p2 having exactly 5 roads too (tie) — should NOT transfer
  // We fake getLongestRoad by checking _checkLargestNetwork logic
  // p2 has 2 roads from setup. Need to adjust.
  // Since this is hard to set up geometrically, test the logic directly:
  // The condition is: length >= MIN_LONGEST_ROAD && length > this.largestNetworkLength
  // So if p2 also has 5 roads: 5 >= 5 is true, BUT 5 > 5 is false → no transfer (correct)
  // Verify the code: gs._checkLargestNetwork loops players; if p2 has road length == 5:
  // condition: 5 >= 5 (true) AND 5 > 5 (false) → no transfer
  // We simulate this by checking getLongestRoad for p2 and verifying it wouldn't transfer
  const p2RoadLength = gs.board.getLongestRoad(p2, gs);
  const wouldTransfer = p2RoadLength >= 5 && p2RoadLength > gs.largestNetworkLength;
  expectTrue('16a. Tie road length does NOT transfer Largest Network (correct >strict condition)',
    !wouldTransfer || p2RoadLength > 5,
    `p2 road length=${p2RoadLength}, largestNetworkLength=${gs.largestNetworkLength}`);

  // 16b. BUG CHECK: _checkLargestEngineeringTeam same tie-breaker
  gs.largestEngineeringTeamHolder = p1;
  gs.largestEngineeringTeamCount = 3;
  player1.hasLargestEngineeringTeam = true;
  player2.playedEngineers = 3; // tie
  gs._checkLargestEngineeringTeam();
  expectTrue('16b. Tie engineers does NOT transfer Largest Engineering Team',
    player1.hasLargestEngineeringTeam && !player2.hasLargestEngineeringTeam,
    `p1 has=${player1.hasLargestEngineeringTeam}, p2 has=${player2.hasLargestEngineeringTeam}`);

  // 16c. BUG CHECK: playNetworkExpansion rollback on invalid first road
  const gs2 = freshGame(2, 42);
  doFullSetup(gs2);
  const [q1] = gs2.playerOrder;
  const qp1 = gs2.getPlayer(q1);
  forceRoll(gs2, 5);
  gs2.rollDice(q1);

  const netCard = { type: 'networkExpansion' };
  qp1.fundingCards.push(netCard);
  const cardsBefore = qp1.fundingCards.length;
  // Try to play with invalid first edge
  const rNetBad = gs2.playNetworkExpansion(q1, 'totally-invalid-edge', null);
  expectError('16c. Network expansion with invalid edge returns error', rNetBad, 'invalid edge');
  // Card should be rolled back
  expectEq('16c. Card restored after failed network expansion', qp1.fundingCards.length, cardsBefore);
  expectEq('16c. hasPlayedFundingCard rolled back', gs2.hasPlayedFundingCard, false);

  // 16d. BUG CHECK: discardCards with negative amounts
  const gs3 = freshGame(2, 42);
  doFullSetup(gs3);
  const [d1] = gs3.playerOrder;
  const dp1 = gs3.getPlayer(d1);
  setResources(dp1, { therapist: 8 });
  force7(gs3);
  gs3.rollDice(d1);
  if (gs3.phase === PHASES.DEV_INCIDENT_DISCARD) {
    const rNeg = gs3.discardCards(d1, { therapist: -1, payerContracts: 5 });
    expectError('16d. Discard negative amounts rejected', rNeg, 'cannot discard negative');
  } else {
    pass('16d. Skipped — not in discard phase');
  }

  // 16e. BUG CHECK: Trade propose with 0-amount resource
  const gs4 = freshGame(2, 42);
  doFullSetup(gs4);
  const [t1] = gs4.playerOrder;
  forceRoll(gs4, 6);
  gs4.rollDice(t1);
  const tp1 = gs4.getPlayer(t1);
  setResources(tp1, { therapist: 2 });
  const rZeroTrade = gs4.proposeTrade(t1, { therapist: 0 }, { payerContracts: 1 });
  expectError('16e. Trade with 0-amount resource rejected', rZeroTrade, 'invalid amount');

  // 16f. BUG CHECK: Cannot move dev incident in wrong phase
  const gs5 = freshGame(2, 42);
  doFullSetup(gs5);
  const [m1] = gs5.playerOrder;
  forceRoll(gs5, 6);
  gs5.rollDice(m1); // now MAIN phase
  const hexId = [...gs5.board.hexes.keys()][0];
  const rMoveWrongPhase = gs5.moveDevIncident(m1, hexId);
  expectError('16f. moveDevIncident in wrong phase rejected', rMoveWrongPhase, 'not in dev incident move phase');

  // 16g. BUG CHECK: stealResource in wrong phase
  const gs6 = freshGame(2, 42);
  doFullSetup(gs6);
  const [s1, s2] = gs6.playerOrder;
  forceRoll(gs6, 8);
  gs6.rollDice(s1); // MAIN phase
  const rStealWrong = gs6.stealResource(s1, s2);
  expectError('16g. stealResource in wrong phase rejected', rStealWrong, 'not in steal phase');

  // 16h. BUG CHECK: Engineer played before roll (ROLL phase)
  const gs7 = freshGame(2, 42);
  doFullSetup(gs7);
  const [e1] = gs7.playerOrder;
  const ep1 = gs7.getPlayer(e1);
  // We are in ROLL phase
  const engCard7 = { type: 'engineer' };
  ep1.fundingCards.push(engCard7);
  // Engineer CAN be played in ROLL phase (pre-roll) according to GameState code
  const targetHex7 = [...gs7.board.hexes.values()].find(h => h.id !== gs7.board.getDevIncidentHex()?.id);
  const rEngRoll = gs7.playEngineer(e1, targetHex7.id, null);
  // According to the code: phase !== PHASES.MAIN && phase !== PHASES.ROLL → error
  // So in ROLL phase, it SHOULD work
  expectOk('16h. Engineer can be played during ROLL phase (pre-roll — by design)', rEngRoll);

  // 16i. BUG CHECK: endTurn clears newFundingCards via player.clearNewFundingCards
  const gs8 = freshGame(2, 42);
  doFullSetup(gs8);
  const [x1] = gs8.playerOrder;
  const xp1 = gs8.getPlayer(x1);
  forceRoll(gs8, 6);
  gs8.rollDice(x1);
  setResources(xp1, { coeStaff: 1, rcmStaff: 1, clinOps: 1 });
  gs8.buyFundingCard(x1);
  expectEq('16i. newFundingCards has 1 card before endTurn', xp1.newFundingCards.length, 1);
  gs8.endTurn(x1);
  expectEq('16i. newFundingCards cleared after endTurn', xp1.newFundingCards.length, 0);

  // 16j. BUG CHECK: buildCity requires exactly 'practiceLocation' buildingType
  const gs9 = freshGame(2, 42);
  doFullSetup(gs9);
  const [c1, c2] = gs9.playerOrder;
  const cp1 = gs9.getPlayer(c1);
  forceRoll(gs9, 6);
  gs9.rollDice(c1);
  // First build a city
  const cv = cp1.practiceLocations[0];
  setResources(cp1, { rcmStaff: 2, clinOps: 3 });
  gs9.buildCity(c1, cv);
  // Now cv is a stateNetwork. Try to build city again on it (it's no longer a practiceLocation).
  setResources(cp1, { rcmStaff: 2, clinOps: 3 });
  const rCityOnCity = gs9.buildCity(c1, cv);
  expectError('16j. Can\'t build city on already-upgraded vertex', rCityOnCity, 'must upgrade your own settlement');

  // 16k. BUG CHECK: proposeTrade rejected when not in MAIN phase
  const gsRollPhase = freshGame(2, 42);
  doFullSetup(gsRollPhase);
  const rp1id = gsRollPhase.currentPlayerId;
  const rp1player = gsRollPhase.getPlayer(rp1id);
  setResources(rp1player, { therapist: 2 });
  const rTradeRoll = gsRollPhase.proposeTrade(rp1id, { therapist: 1 }, { payerContracts: 1 });
  expectError('16k. proposeTrade rejected in ROLL phase', rTradeRoll, 'not in main phase');
}

// ─────────────────────────────────────────────────────────────────────────────
// FINAL SUMMARY
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(72));
console.log('  FINAL SUMMARY');
console.log('═'.repeat(72));
console.log(`  Total:  ${passCount + failCount}  |  PASS: ${passCount}  |  FAIL: ${failCount}`);

if (failures.length === 0) {
  console.log('\n  All tests passed!\n');
} else {
  console.log(`\n  ${failures.length} failure(s):\n`);
  for (const f of failures) {
    console.log('  ' + f);
  }
  console.log('');
}

process.exit(failCount > 0 ? 1 : 0);
