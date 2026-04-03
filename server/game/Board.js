'use strict';

/**
 * Board.js
 * Generates and manages the Thriveworks Catan board using cube coordinates.
 *
 * Vertex IDs: sorted cube-coord strings of the 3 adjacent hexes joined by '|'.
 *   Border vertices touching fewer than 3 hexes are padded with 'ocean'.
 * Edge IDs: sorted vertex IDs joined by '--'.
 */

// ---------------------------------------------------------------------------
// Hex coordinate helpers
// ---------------------------------------------------------------------------

const HEX_POSITIONS = [
  // Ring 0
  { q: 0, r: 0, s: 0 },
  // Ring 1
  { q: 1, r: -1, s: 0 }, { q: 1, r: 0, s: -1 }, { q: 0, r: 1, s: -1 },
  { q: -1, r: 1, s: 0 }, { q: -1, r: 0, s: 1 }, { q: 0, r: -1, s: 1 },
  // Ring 2
  { q: 2, r: -2, s: 0 }, { q: 2, r: -1, s: -1 }, { q: 2, r: 0, s: -2 },
  { q: 1, r: 1, s: -2 }, { q: 0, r: 2, s: -2 }, { q: -1, r: 2, s: -1 },
  { q: -2, r: 2, s: 0 }, { q: -2, r: 1, s: 1 }, { q: -2, r: 0, s: 2 },
  { q: -1, r: -1, s: 2 }, { q: 0, r: -2, s: 2 }, { q: 1, r: -2, s: 1 },
];

// Cube-coordinate directions (6 neighbours of a hex)
const HEX_DIRS = [
  { q: 1, r: -1, s: 0 },
  { q: 1, r: 0, s: -1 },
  { q: 0, r: 1, s: -1 },
  { q: -1, r: 1, s: 0 },
  { q: -1, r: 0, s: 1 },
  { q: 0, r: -1, s: 1 },
];

// Each hex has 6 vertices. In cube coordinates the 6 vertex "positions" relative
// to a hex centre can be described by taking pairs of adjacent hex directions.
// Vertex i of hex H is shared by H, H+dir[i], and H+dir[(i+1)%6].
// We use this fact to compute vertex IDs canonically.

function hexKey(q, r, s) {
  return `${q},${r},${s}`;
}

function sortedKey(...keys) {
  return [...keys].sort().join('|');
}

function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// Seeded PRNG (simple mulberry32) — deterministic for tests, random otherwise
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Board class
// ---------------------------------------------------------------------------
class Board {
  constructor(seed) {
    this._rng = mulberry32(seed !== undefined ? seed : (Date.now() & 0xffffffff));
    this.hexes = new Map();      // hexKey → hex object
    this.vertices = new Map();   // vertexId → vertex object
    this.edges = new Map();      // edgeId → edge object
    this.ports = [];

    this._hexKeyToId = new Map(); // hexKey → hexId string (same as hexKey here)

    this._generate();
  }

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------
  _generate() {
    this._placeHexes();
    this._buildVerticesAndEdges();
    this._placePorts();
  }

  _placeHexes() {
    const resources = [
      'therapist', 'therapist', 'therapist', 'therapist',
      'payerContracts', 'payerContracts', 'payerContracts',
      'coeStaff', 'coeStaff', 'coeStaff', 'coeStaff',
      'rcmStaff', 'rcmStaff', 'rcmStaff', 'rcmStaff',
      'clinOps', 'clinOps', 'clinOps',
      'desert',
    ];

    const numbers = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];

    // Shuffle resources with constraint: no two same-type hexes sharing 2+ neighbors
    let shuffledResources = shuffle(resources, this._rng);
    for (let attempt = 0; attempt < 200; attempt++) {
      if (this._resourcesBalanced(shuffledResources)) break;
      shuffledResources = shuffle(resources, this._rng);
    }

    // Place hexes with resources (numbers assigned below)
    for (let i = 0; i < HEX_POSITIONS.length; i++) {
      const { q, r, s } = HEX_POSITIONS[i];
      const resource = shuffledResources[i];
      const id = hexKey(q, r, s);
      this.hexes.set(id, { id, q, r, s, resource, number: null, hasDevIncident: resource === 'desert' });
      this._hexKeyToId.set(id, id);
    }

    // Assign numbers with constraint: no 6 or 8 adjacent to another 6 or 8
    for (let attempt = 0; attempt < 200; attempt++) {
      if (this._tryAssignNumbers(numbers)) break;
    }
  }

  _resourcesBalanced(shuffledResources) {
    const tempMap = new Map();
    for (let i = 0; i < HEX_POSITIONS.length; i++) {
      const { q, r, s } = HEX_POSITIONS[i];
      tempMap.set(hexKey(q, r, s), shuffledResources[i]);
    }
    for (let i = 0; i < HEX_POSITIONS.length; i++) {
      const { q, r, s } = HEX_POSITIONS[i];
      const res = shuffledResources[i];
      if (res === 'desert') continue;
      let sameCount = 0;
      for (const dir of HEX_DIRS) {
        if (tempMap.get(hexKey(q + dir.q, r + dir.r, s + dir.s)) === res) sameCount++;
      }
      if (sameCount >= 2) return false; // cluster of 3+ same type
    }
    return true;
  }

  _tryAssignNumbers(numbers) {
    const shuffled = shuffle(numbers, this._rng);
    const nonDesert = [...this.hexes.values()].filter(h => h.resource !== 'desert');
    for (let i = 0; i < nonDesert.length; i++) nonDesert[i].number = shuffled[i];

    // No 6 or 8 may be adjacent to another 6 or 8
    for (const hex of nonDesert) {
      if (hex.number !== 6 && hex.number !== 8) continue;
      for (const dir of HEX_DIRS) {
        const neighbor = this.hexes.get(hexKey(hex.q + dir.q, hex.r + dir.r, hex.s + dir.s));
        if (neighbor && (neighbor.number === 6 || neighbor.number === 8)) return false;
      }
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Vertex & Edge construction
  // -------------------------------------------------------------------------
  _buildVerticesAndEdges() {
    // Build a lookup set of valid hex keys
    const hexSet = new Set(this.hexes.keys());

    // For every hex, iterate its 6 vertex slots.
    // Vertex slot i of hex H is at the junction of H, H+dir[i], H+dir[(i+1)%6].
    // For off-board neighbours we use 'ocean:q,r,s' — preserving their actual
    // coordinates so that corner hexes (which have two off-board neighbours) still
    // produce unique vertex IDs for each slot.
    for (const hex of this.hexes.values()) {
      for (let i = 0; i < 6; i++) {
        const n1 = this._addHex(hex, HEX_DIRS[i]);
        const n2 = this._addHex(hex, HEX_DIRS[(i + 1) % 6]);

        const k1 = hexKey(n1.q, n1.r, n1.s);
        const k2 = hexKey(n2.q, n2.r, n2.s);

        const h0 = hex.id;
        const h1 = hexSet.has(k1) ? k1 : `ocean:${k1}`;
        const h2 = hexSet.has(k2) ? k2 : `ocean:${k2}`;

        const vId = sortedKey(h0, h1, h2);

        if (!this.vertices.has(vId)) {
          this.vertices.set(vId, {
            id: vId,
            hexIds: [h0, ...(hexSet.has(k1) ? [k1] : []), ...(hexSet.has(k2) ? [k2] : [])],
            ownerId: null,
            buildingType: null, // 'practiceLocation' | 'stateNetwork'
            port: null,         // set during port placement
          });
        }
      }

      // Edges: slot i connects vertex i and vertex (i+1)%6 (using vertex slot numbering)
      for (let i = 0; i < 6; i++) {
        const vId1 = this._vertexId(hex, i);
        const vId2 = this._vertexId(hex, (i + 1) % 6);
        const eId = [vId1, vId2].sort().join('--');

        if (!this.edges.has(eId)) {
          this.edges.set(eId, {
            id: eId,
            vertexIds: [vId1, vId2],
            ownerId: null,
          });
        }
      }
    }
  }

  // Compute the vertex ID for slot i of the given hex
  _vertexId(hex, i) {
    const hexSet = new Set(this.hexes.keys());
    const n1 = this._addHex(hex, HEX_DIRS[i]);
    const n2 = this._addHex(hex, HEX_DIRS[(i + 1) % 6]);
    const k1 = hexKey(n1.q, n1.r, n1.s);
    const k2 = hexKey(n2.q, n2.r, n2.s);
    const h0 = hex.id;
    const h1 = hexSet.has(k1) ? k1 : `ocean:${k1}`;
    const h2 = hexSet.has(k2) ? k2 : `ocean:${k2}`;
    return sortedKey(h0, h1, h2);
  }

  _addHex(hex, dir) {
    return { q: hex.q + dir.q, r: hex.r + dir.r, s: hex.s + dir.s };
  }

  // -------------------------------------------------------------------------
  // Port placement
  // -------------------------------------------------------------------------
  // Ports are placed on border vertices (those touching 'ocean').
  // Standard Catan has 9 ports each touching 2 adjacent border vertices.
  _placePorts() {
    const portTypes = [
      { resource: 'therapist', ratio: 2 },
      { resource: 'payerContracts', ratio: 2 },
      { resource: 'coeStaff', ratio: 2 },
      { resource: 'rcmStaff', ratio: 2 },
      { resource: 'clinOps', ratio: 2 },
      { resource: 'generic', ratio: 3 },
      { resource: 'generic', ratio: 3 },
      { resource: 'generic', ratio: 3 },
      { resource: 'generic', ratio: 3 },
    ];

    // Port edges must be on the OUTER face of the board:
    // both vertices are border vertices AND they share exactly one land hex
    // (if they shared two, the edge would be internal between two border hexes).
    const perimeterEdges = [];
    for (const edge of this.edges.values()) {
      const [v1id, v2id] = edge.vertexIds;
      if (!v1id.includes('ocean') || !v2id.includes('ocean')) continue;
      const v1 = this.vertices.get(v1id);
      const v2 = this.vertices.get(v2id);
      if (!v1 || !v2) continue;
      // Count shared land hexes — outer boundary edges share exactly 1
      const v1hexSet = new Set(v1.hexIds);
      const sharedCount = v2.hexIds.filter(h => v1hexSet.has(h)).length;
      if (sharedCount === 1) perimeterEdges.push(edge);
    }

    // Even distribution: sort perimeter edges by angle from board center,
    // then pick every other one (standard Catan: 18 perimeter edges → 9 ports).
    const HS = 60; // HEX_SIZE
    function edgeMidAngle(edge) {
      function vertexPx(vid) {
        let sx = 0, sy = 0, cnt = 0;
        for (const part of vid.split('|')) {
          const clean = part.startsWith('ocean:') ? part.slice(6) : part;
          const coords = clean.split(',').map(Number);
          if (coords.length >= 2 && !isNaN(coords[0]) && !isNaN(coords[1])) {
            sx += HS * 1.5 * coords[0];
            sy += HS * (Math.sqrt(3) / 2 * coords[0] + Math.sqrt(3) * coords[1]);
            cnt++;
          }
        }
        return cnt > 0 ? { x: sx / cnt, y: sy / cnt } : { x: 0, y: 0 };
      }
      const [v1id, v2id] = edge.vertexIds;
      const p1 = vertexPx(v1id);
      const p2 = vertexPx(v2id);
      return Math.atan2((p1.y + p2.y) / 2, (p1.x + p2.x) / 2);
    }

    // Normalise angles to [0, 2π) and apply a random rotation so layout varies per game
    const TWO_PI = Math.PI * 2;
    const rotOffset = this._rng() * TWO_PI;
    const edgesWithAngles = perimeterEdges.map(e => {
      let a = edgeMidAngle(e);
      if (a < 0) a += TWO_PI;
      a = (a - rotOffset + TWO_PI) % TWO_PI;
      return { edge: e, angle: a };
    });

    // Divide the perimeter into 9 equal sectors (40° each) and pick the edge
    // closest to each sector's centre. This guarantees one port per sector and
    // an even spread regardless of how many perimeter edges the board has.
    const chosen = [];
    const usedVertices = new Set();
    const sectorSize = TWO_PI / 9;

    for (let s = 0; s < 9; s++) {
      const sectorMid = (s + 0.5) * sectorSize;
      const candidates = edgesWithAngles
        .filter(({ angle }) => angle >= s * sectorSize && angle < (s + 1) * sectorSize)
        .filter(({ edge }) => !usedVertices.has(edge.vertexIds[0]) && !usedVertices.has(edge.vertexIds[1]))
        .sort((a, b) => Math.abs(a.angle - sectorMid) - Math.abs(b.angle - sectorMid));

      if (candidates.length > 0) {
        const { edge } = candidates[0];
        chosen.push(edge);
        usedVertices.add(edge.vertexIds[0]);
        usedVertices.add(edge.vertexIds[1]);
      }
    }

    // Fallback: if a sector had no candidates, fill greedily from remaining edges
    if (chosen.length < 9) {
      const chosenIds = new Set(chosen.map(e => e.id));
      for (const { edge } of shuffle([...edgesWithAngles], this._rng)) {
        if (chosen.length >= 9) break;
        if (chosenIds.has(edge.id)) continue;
        if (usedVertices.has(edge.vertexIds[0]) || usedVertices.has(edge.vertexIds[1])) continue;
        chosen.push(edge);
        usedVertices.add(edge.vertexIds[0]);
        usedVertices.add(edge.vertexIds[1]);
      }
    }

    const shuffledPorts = shuffle(portTypes, this._rng);
    for (let i = 0; i < chosen.length; i++) {
      const edge = chosen[i];
      const portDef = shuffledPorts[i];
      const port = { vertexIds: edge.vertexIds, resource: portDef.resource, ratio: portDef.ratio };
      this.ports.push(port);
      for (const vid of edge.vertexIds) {
        if (this.vertices.has(vid)) {
          this.vertices.get(vid).port = { resource: portDef.resource, ratio: portDef.ratio };
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Adjacency helpers
  // -------------------------------------------------------------------------

  /** Returns the vertex IDs of all vertices on a given hex */
  getVerticesOnHex(hexId) {
    const hex = this.hexes.get(hexId);
    if (!hex) return [];
    const result = [];
    for (let i = 0; i < 6; i++) {
      result.push(this._vertexId(hex, i));
    }
    return result;
  }

  /** Returns the edge IDs of all edges on a given hex */
  getEdgesOnHex(hexId) {
    const hex = this.hexes.get(hexId);
    if (!hex) return [];
    const result = [];
    for (let i = 0; i < 6; i++) {
      const v1 = this._vertexId(hex, i);
      const v2 = this._vertexId(hex, (i + 1) % 6);
      const eId = [v1, v2].sort().join('--');
      if (this.edges.has(eId)) result.push(eId);
    }
    return result;
  }

  /** Returns the hex IDs adjacent to a vertex */
  getHexesOnVertex(vid) {
    const v = this.vertices.get(vid);
    return v ? v.hexIds : [];
  }

  /** Returns all edge IDs that connect to a given vertex */
  getEdgesOnVertex(vid) {
    const result = [];
    for (const edge of this.edges.values()) {
      if (edge.vertexIds.includes(vid)) result.push(edge.id);
    }
    return result;
  }

  /** Returns neighbouring vertex IDs (vertices connected by an edge) */
  getVertexNeighborVertices(vid) {
    const result = [];
    for (const edge of this.edges.values()) {
      const [v1, v2] = edge.vertexIds;
      if (v1 === vid) result.push(v2);
      else if (v2 === vid) result.push(v1);
    }
    return result;
  }

  /** Returns edge IDs shared between two vertices */
  getEdgesBetweenVertices(v1, v2) {
    const eId = [v1, v2].sort().join('--');
    return this.edges.has(eId) ? [eId] : [];
  }

  /**
   * Returns true if a vertex can have a building placed on it.
   * Rules: vertex must be unoccupied AND no adjacent vertex may be occupied
   * (distance rule). If initial is true we skip road-connectivity check.
   */
  isVertexBuildable(vid, gameState, initial = false) {
    const vertex = this.vertices.get(vid);
    if (!vertex) return false;
    if (vertex.ownerId !== null) return false;
    // Distance rule: no adjacent vertex may have a building
    for (const nv of this.getVertexNeighborVertices(vid)) {
      const nVertex = this.vertices.get(nv);
      if (nVertex && nVertex.ownerId !== null) return false;
    }
    if (initial) return true;
    // Must be connected by the player's own road
    return false; // Caller checks road connectivity separately
  }

  /**
   * Returns true if a player can build a network (road) on a given edge.
   * The edge must be unoccupied and connected to the player's existing network or settlement.
   */
  isEdgeBuildable(eid, playerId, gameState) {
    const edge = this.edges.get(eid);
    if (!edge) return false;
    if (edge.ownerId !== null) return false;

    // Check if at least one endpoint vertex is the player's building or
    // connects to a player's existing road (with no opponent settlement blocking)
    for (const vid of edge.vertexIds) {
      const vertex = this.vertices.get(vid);
      if (!vertex) continue;

      // Player's building on this vertex
      if (vertex.ownerId === playerId) return true;

      // Check if any road from this vertex belongs to the player
      // Only valid if the vertex is NOT occupied by an opponent
      if (vertex.ownerId !== null && vertex.ownerId !== playerId) continue;

      const adjacentEdges = this.getEdgesOnVertex(vid);
      for (const adjEid of adjacentEdges) {
        if (adjEid === eid) continue;
        const adjEdge = this.edges.get(adjEid);
        if (adjEdge && adjEdge.ownerId === playerId) return true;
      }
    }
    return false;
  }

  /**
   * Compute the longest continuous road length for a player.
   * Uses DFS to find the longest path in the player's road graph.
   */
  getLongestRoad(playerId, gameState) {
    // Gather all edges owned by this player
    const playerEdges = [];
    for (const edge of this.edges.values()) {
      if (edge.ownerId === playerId) playerEdges.push(edge);
    }
    if (playerEdges.length === 0) return 0;

    // Build adjacency: vertex → [vertex] only through player roads,
    // respecting that opponent buildings break continuity
    const players = gameState ? gameState.players : null;

    const adjMap = new Map(); // vertexId → Set<vertexId>
    for (const edge of playerEdges) {
      const [v1, v2] = edge.vertexIds;
      if (!adjMap.has(v1)) adjMap.set(v1, new Set());
      if (!adjMap.has(v2)) adjMap.set(v2, new Set());
      adjMap.get(v1).add(v2);
      adjMap.get(v2).add(v1);
    }

    // Collect all vertices in this subgraph
    const allVerts = [...adjMap.keys()];

    let longest = 0;

    // DFS from each vertex
    const dfs = (current, visitedEdges) => {
      let local = visitedEdges.size;
      longest = Math.max(longest, local);

      const neighbors = adjMap.get(current) || new Set();
      for (const next of neighbors) {
        const eIds = this.getEdgesBetweenVertices(current, next);
        if (eIds.length === 0) continue;
        const eId = eIds[0];
        if (visitedEdges.has(eId)) continue;

        // If the 'next' vertex is occupied by an opponent, we cannot continue through it
        if (players) {
          const vx = this.vertices.get(next);
          if (vx && vx.ownerId !== null && vx.ownerId !== playerId) {
            // Can still count this edge, but cannot continue from next
            visitedEdges.add(eId);
            longest = Math.max(longest, visitedEdges.size);
            visitedEdges.delete(eId);
            continue;
          }
        }

        visitedEdges.add(eId);
        dfs(next, visitedEdges);
        visitedEdges.delete(eId);
      }
    };

    for (const v of allVerts) {
      dfs(v, new Set());
    }

    return longest;
  }

  // -------------------------------------------------------------------------
  // Serialisation helpers
  // -------------------------------------------------------------------------
  toJSON() {
    return {
      hexes: [...this.hexes.values()],
      vertices: [...this.vertices.values()],
      edges: [...this.edges.values()],
      ports: this.ports,
    };
  }

  /** Quick lookup */
  getHex(id) { return this.hexes.get(id) || null; }
  getVertex(id) { return this.vertices.get(id) || null; }
  getEdge(id) { return this.edges.get(id) || null; }

  /** Move the Dev Incident token */
  setDevIncident(hexId) {
    for (const hex of this.hexes.values()) {
      hex.hasDevIncident = (hex.id === hexId);
    }
  }

  getDevIncidentHex() {
    for (const hex of this.hexes.values()) {
      if (hex.hasDevIncident) return hex;
    }
    return null;
  }

  /** Get all players on a hex (have a building on any vertex of the hex) */
  getPlayersOnHex(hexId, gameState) {
    const verts = this.getVerticesOnHex(hexId);
    const playerIds = new Set();
    for (const vid of verts) {
      const v = this.vertices.get(vid);
      if (v && v.ownerId !== null) playerIds.add(v.ownerId);
    }
    return [...playerIds];
  }
}

module.exports = Board;
