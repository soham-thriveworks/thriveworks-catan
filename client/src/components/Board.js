// =============================================================
// Board.js — SVG Hex Board Renderer
// Exposed as window.Board
// =============================================================

window.Board = function Board({
  gameState,
  myPlayerId,
  phase,
  onVertexClick,
  onEdgeClick,
  onHexClick,
  buildMode,
  resourceAnimations,
}) {
  if (!gameState || !gameState.board) {
    return (
      <div className="board-svg-wrap" style={{ color: 'rgba(255,255,255,0.3)', fontSize: '14px' }}>
        Loading board…
      </div>
    );
  }

  const { hexes = [], vertices = [], edges = [], ports = [] } = gameState.board;

  // ---- Coordinate helpers ----
  const HEX_SIZE = 60;
  const CENTER_X = 410;
  const CENTER_Y = 360;

  function hexToPixel(q, r) {
    const x = CENTER_X + HEX_SIZE * (3 / 2) * q;
    const y = CENTER_Y + HEX_SIZE * (Math.sqrt(3) / 2 * q + Math.sqrt(3) * r);
    return { x, y };
  }

  function hexCorners(cx, cy, size) {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const angleDeg = 60 * i; // flat-top: 0°, 60°, 120°...
      const angleRad = (Math.PI / 180) * angleDeg;
      pts.push({
        x: cx + size * Math.cos(angleRad),
        y: cy + size * Math.sin(angleRad),
      });
    }
    return pts;
  }

  function cornersToPoints(corners) {
    return corners.map(c => `${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(' ');
  }

  // ---- Resource colors / labels ----
  const RES_COLOR = {
    therapist:      '#4CAF50',
    payerContracts: '#2196F3',
    coeStaff:       '#FFC107',
    rcmStaff:       '#FF9800',
    clinOps:        '#9E9E9E',
    desert:         '#E0D5C1',
  };

  const RES_LABEL = {
    therapist:      '🧑‍⚕️',
    payerContracts: '📋',
    coeStaff:       '👥',
    rcmStaff:       '💰',
    clinOps:        '⚙️',
    desert:         '🕴️',
  };

  // ---- Player color map ----
  const COLOR_MAP = {
    green:  '#2E7D32',
    blue:   '#1565C0',
    orange: '#E65100',
    purple: '#6A1B9A',
  };

  function playerColor(playerId) {
    if (!gameState.players) return '#888';
    const p = gameState.players.find(pl => pl.id === playerId);
    return p ? (COLOR_MAP[p.color] || p.color || '#888') : '#888';
  }

  // ---- Determine what is clickable ----
  const isInitialSettlementPhase = phase === 'place_initial_settlement';
  const isInitialRoadPhase = phase === 'place_initial_road';
  const isBuildSettlement = buildMode === 'settlement' || isInitialSettlementPhase;
  const isBuildCity = buildMode === 'city';
  const isBuildRoad = buildMode === 'road' || isInitialRoadPhase;
  const isMoveDevIncident = buildMode === 'devIncident';

  // Pre-compute which vertex ids already have buildings
  const occupiedVertices = new Set(vertices.filter(v => v.buildingType).map(v => v.id));
  const occupiedEdges = new Set(edges.filter(e => e.ownerId).map(e => e.id));

  // Build vertex adjacency from edges for distance-rule check
  const vertexAdjacency = React.useMemo(() => {
    const adj = new Map();
    edges.forEach(edge => {
      const [v1, v2] = edge.vertexIds || [];
      if (!v1 || !v2) return;
      if (!adj.has(v1)) adj.set(v1, []);
      if (!adj.has(v2)) adj.set(v2, []);
      adj.get(v1).push(v2);
      adj.get(v2).push(v1);
    });
    return adj;
  }, [edges]);

  // ---- Compute vertex pixel coords ----
  // A vertex in a flat-top hex grid sits exactly at the centroid of the 3 adjacent
  // hex centers (including virtual ocean hexes). The vertex ID encodes all 3 cube
  // coords as "q,r,s|q,r,s|q,r,s" (ocean ones prefixed "ocean:q,r,s"), so we can
  // parse the ID directly for a geometrically exact position.
  const vertexPixels = React.useMemo(() => {
    const map = {};
    vertices.forEach(v => {
      const parts = v.id.split('|');
      let sumX = 0, sumY = 0, count = 0;
      for (const part of parts) {
        const clean = part.startsWith('ocean:') ? part.slice(6) : part;
        const coords = clean.split(',').map(Number);
        if (coords.length >= 2 && !isNaN(coords[0]) && !isNaN(coords[1])) {
          const { x, y } = hexToPixel(coords[0], coords[1]);
          sumX += x;
          sumY += y;
          count++;
        }
      }
      if (count > 0) map[v.id] = { x: sumX / count, y: sumY / count };
    });
    return map;
  }, [vertices]);

  // ---- Build connectivity helpers (Item 9) ----
  function isEdgeBuildableByMe(edge) {
    if (edge.ownerId) return false;
    const [v1id, v2id] = edge.vertexIds || [];
    for (const vid of [v1id, v2id]) {
      const v = vertices.find(vx => vx.id === vid);
      if (!v) continue;
      if (v.ownerId === myPlayerId) return true;
      if (v.ownerId && v.ownerId !== myPlayerId) continue; // blocked by opponent
      if (edges.some(e => e.id !== edge.id && e.ownerId === myPlayerId && (e.vertexIds || []).includes(vid)))
        return true;
    }
    return false;
  }

  function isVertexConnectedToMyRoad(vid) {
    return edges.some(e => e.ownerId === myPlayerId && (e.vertexIds || []).includes(vid));
  }

  // ---- Dice total check for number highlight ----
  const lastDiceTotal = gameState.lastDiceTotal;

  // ---- Render hexes ----
  function renderHexes() {
    return hexes.map(hex => {
      const { x: cx, y: cy } = hexToPixel(hex.q, hex.r);
      const corners = hexCorners(cx, cy, HEX_SIZE);
      const pointsStr = cornersToPoints(corners);
      const fillColor = RES_COLOR[hex.resource] || '#888';
      const isDesert = hex.resource === 'desert';
      const isClickable = isMoveDevIncident && !isDesert;
      const isHighlighted = lastDiceTotal && hex.number === lastDiceTotal;

      return (
        <g
          key={hex.id}
          className="hex-tile"
          onClick={isClickable ? () => onHexClick(hex.id) : undefined}
          style={{ cursor: isClickable ? 'pointer' : 'default' }}
        >
          {/* Main polygon */}
          <polygon
            className="hex-poly"
            points={pointsStr}
            fill={fillColor}
            stroke={isHighlighted ? '#FFD700' : 'rgba(0,0,0,0.25)'}
            strokeWidth={isHighlighted ? 3 : 1.5}
            opacity={0.92}
          />
          {/* Inner hex outline */}
          <polygon
            points={cornersToPoints(hexCorners(cx, cy, HEX_SIZE - 3))}
            fill="none"
            stroke="rgba(255,255,255,0.12)"
            strokeWidth={1}
            pointerEvents="none"
          />

          {/* Resource emoji */}
          <text
            x={cx}
            y={cy - (hex.number ? 22 : 0)}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={isDesert ? 26 : 22}
            style={{ userSelect: 'none', pointerEvents: 'none' }}
          >
            {RES_LABEL[hex.resource] || ''}
          </text>

          {/* Number token */}
          {hex.number && (
            <g className="number-token">
              <circle className="number-circle" cx={cx} cy={cy + 14} r={20} />
              <text
                className={`number-text${[6, 8].includes(hex.number) ? ' red' : ''}`}
                x={cx}
                y={cy + 11}
                fontSize={14}
              >
                {hex.number}
              </text>
              {/* Pip dots — centered within circle, well below number */}
              {renderPips(hex.number, cx, cy + 24)}
            </g>
          )}

          {/* Dev Incident marker */}
          {hex.hasDevIncident && (
            <text
              className="dev-incident-marker"
              x={cx}
              y={cy - (hex.number ? 38 : 10)}
              fontSize={24}
            >
              🚨
            </text>
          )}

          {/* Move target highlight */}
          {isClickable && (
            <polygon
              points={pointsStr}
              fill="rgba(229,57,53,0.15)"
              stroke="rgba(229,57,53,0.6)"
              strokeWidth={2}
              strokeDasharray="6 3"
              pointerEvents="none"
            />
          )}
        </g>
      );
    });
  }

  function renderPips(number, cx, cy) {
    const pipCount = {
      2: 1, 3: 2, 4: 3, 5: 4, 6: 5,
      8: 5, 9: 4, 10: 3, 11: 2, 12: 1,
    }[number] || 0;
    const spacing = 3.5;
    const totalW = (pipCount - 1) * spacing;
    return Array.from({ length: pipCount }, (_, i) => (
      <circle
        key={i}
        cx={cx - totalW / 2 + i * spacing}
        cy={cy}
        r={1.5}
        fill={[6, 8].includes(number) ? '#c62828' : '#555'}
        pointerEvents="none"
      />
    ));
  }

  // ---- Render edges ----
  function renderEdges() {
    return edges.map(edge => {
      const [v1id, v2id] = edge.vertexIds || [];
      const p1 = vertexPixels[v1id];
      const p2 = vertexPixels[v2id];
      if (!p1 || !p2) return null;

      const isOwned = !!edge.ownerId;
      const isMyRoad = edge.ownerId === myPlayerId;
      const isBuildable = isBuildRoad && (isInitialRoadPhase ? !isOwned : isEdgeBuildableByMe(edge));
      const roadColor = isOwned ? playerColor(edge.ownerId) : 'rgba(255,255,255,0.12)';

      return (
        <line
          key={edge.id}
          className={`edge-line${isBuildable ? ' buildable' : ''}`}
          x1={p1.x.toFixed(2)} y1={p1.y.toFixed(2)}
          x2={p2.x.toFixed(2)} y2={p2.y.toFixed(2)}
          stroke={isBuildable ? 'rgba(245,166,35,0.6)' : roadColor}
          strokeWidth={isOwned ? 5 : (isBuildable ? 4 : 2)}
          strokeDasharray={!isOwned && !isBuildable ? '4 3' : undefined}
          opacity={isOwned ? 1 : (isBuildable ? 0.7 : 0.4)}
          onClick={isBuildable ? () => onEdgeClick(edge.id) : undefined}
          style={{ cursor: isBuildable ? 'pointer' : 'default' }}
          strokeLinecap="round"
        />
      );
    });
  }

  // ---- Render vertices ----
  function renderVertices() {
    return vertices.map(v => {
      const pos = vertexPixels[v.id];
      if (!pos) return null;

      const hasBuilding = !!v.buildingType;
      const isCity = v.buildingType === 'stateNetwork';
      const isSettlement = v.buildingType === 'practiceLocation';
      const owner = v.ownerId;
      const color = owner ? playerColor(owner) : 'rgba(255,255,255,0.2)';

      const isMyBuilding = owner === myPlayerId;

      // Clickable if:
      // - settlement phase + vertex is empty + no adjacent building (distance rule)
      // - city mode + vertex has my settlement
      const hasAdjacentBuilding = (vertexAdjacency.get(v.id) || []).some(nv => occupiedVertices.has(nv));
      const isBuildableSettlement = isBuildSettlement && !hasBuilding && !hasAdjacentBuilding
        && (isInitialSettlementPhase || isVertexConnectedToMyRoad(v.id));
      const isBuildableCity = isBuildCity && isSettlement && isMyBuilding;
      const isClickable = isBuildableSettlement || isBuildableCity;

      return (
        <g key={v.id}>
          {hasBuilding ? (
            // Render building shape
            <g
              className="building-icon"
              transform={`translate(${pos.x.toFixed(2)}, ${pos.y.toFixed(2)})`}
              onClick={isBuildableCity ? () => onVertexClick(v.id) : undefined}
              style={{ cursor: isBuildableCity ? 'pointer' : 'default' }}
            >
              {isCity ? (
                // Market: municipal building — pediment + body + steps
                <>
                  {/* Steps / base */}
                  <polygon
                    points="-13,7 13,7 11,4 -11,4"
                    fill={color}
                    stroke="rgba(255,255,255,0.5)"
                    strokeWidth={1}
                  />
                  {/* Main building body */}
                  <rect
                    x={-10} y={-6} width={20} height={10}
                    fill={color}
                    stroke="rgba(255,255,255,0.7)"
                    strokeWidth={1.5}
                  />
                  {/* Triangular pediment / roof */}
                  <polygon
                    points="-12,-6 0,-17 12,-6"
                    fill={color}
                    stroke="rgba(255,255,255,0.7)"
                    strokeWidth={1.5}
                  />
                  {/* Pediment inner triangle (detail) */}
                  <polygon
                    points="-7,-7 0,-13 7,-7"
                    fill="rgba(255,255,255,0.2)"
                    stroke="none"
                  />
                  {/* Door */}
                  <rect
                    x={-3} y={-1} width={6} height={5}
                    fill="rgba(0,0,0,0.35)"
                    stroke="none"
                  />
                </>
              ) : (
                // Settlement: house shape
                <polygon
                  points="-8,4 -8,-4 0,-12 8,-4 8,4"
                  fill={color}
                  stroke="rgba(255,255,255,0.7)"
                  strokeWidth={1.5}
                />
              )}
            </g>
          ) : (
            // Empty vertex dot
            <circle
              className={`vertex-dot${isClickable ? ' buildable' : ''}`}
              cx={pos.x.toFixed(2)}
              cy={pos.y.toFixed(2)}
              r={isClickable ? 7 : 4}
              fill={isClickable ? 'rgba(245,166,35,0.7)' : 'rgba(255,255,255,0.12)'}
              stroke={isClickable ? '#F5A623' : 'rgba(255,255,255,0.2)'}
              strokeWidth={isClickable ? 2 : 1}
              onClick={isClickable ? () => onVertexClick(v.id) : undefined}
              style={{ cursor: isClickable ? 'pointer' : 'default' }}
            />
          )}
          {/* If city mode and this is my settlement, show upgrade ring */}
          {isBuildableCity && (
            <circle
              cx={pos.x.toFixed(2)}
              cy={pos.y.toFixed(2)}
              r={18}
              fill="rgba(245,166,35,0.08)"
              stroke="rgba(245,166,35,0.85)"
              strokeWidth={2.5}
              strokeDasharray="5 3"
              onClick={() => onVertexClick(v.id)}
              style={{ cursor: 'pointer' }}
            />
          )}
        </g>
      );
    });
  }

  // ---- Render ports ----
  const PORT_ABBREV = {
    therapist:      'Therapist',
    payerContracts: 'Payer',
    coeStaff:       'COE Staff',
    rcmStaff:       'RCM Staff',
    clinOps:        'Clin Ops',
  };

  function renderPorts() {
    return (ports || []).map((port, idx) => {
      const [v1id, v2id] = port.vertexIds || [];
      const p1 = vertexPixels[v1id];
      const p2 = vertexPixels[v2id];
      if (!p1 || !p2) return null;

      const mx = (p1.x + p2.x) / 2;
      const my = (p1.y + p2.y) / 2;

      // Push label outward from board center into ocean
      const dx = mx - CENTER_X;
      const dy = my - CENTER_Y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const labelX = mx + (dx / dist) * 52;
      const labelY = my + (dy / dist) * 52;

      const isGeneric = port.resource === 'generic' || port.resource === 'any';
      // Line 1: emoji + ratio  Line 2: resource abbreviation
      const icon = isGeneric ? '🔄' : (RES_LABEL[port.resource] || '?');
      const ratioText = `${port.ratio}:1`;
      const nameText = isGeneric ? 'ANY' : (PORT_ABBREV[port.resource] || port.resource);

      const pillW = 52;
      const pillH = 30;

      return (
        <g key={idx}>
          {/* Connector lines to both port vertices */}
          <line x1={labelX.toFixed(1)} y1={labelY.toFixed(1)} x2={p1.x.toFixed(1)} y2={p1.y.toFixed(1)}
            stroke="rgba(255,255,255,0.25)" strokeWidth={1.2} strokeDasharray="3 2" />
          <line x1={labelX.toFixed(1)} y1={labelY.toFixed(1)} x2={p2.x.toFixed(1)} y2={p2.y.toFixed(1)}
            stroke="rgba(255,255,255,0.25)" strokeWidth={1.2} strokeDasharray="3 2" />
          {/* Port vertex dots */}
          <circle cx={p1.x.toFixed(1)} cy={p1.y.toFixed(1)} r={4}
            fill="rgba(255,255,255,0.35)" stroke="rgba(255,255,255,0.7)" strokeWidth={1} />
          <circle cx={p2.x.toFixed(1)} cy={p2.y.toFixed(1)} r={4}
            fill="rgba(255,255,255,0.35)" stroke="rgba(255,255,255,0.7)" strokeWidth={1} />
          {/* Background pill */}
          <rect
            x={(labelX - pillW / 2).toFixed(1)} y={(labelY - pillH / 2).toFixed(1)}
            width={pillW} height={pillH} rx={6}
            fill={isGeneric ? 'rgba(74,144,217,0.9)' : 'rgba(245,166,35,0.9)'}
            stroke="rgba(255,255,255,0.4)" strokeWidth={1}
          />
          {/* Icon + ratio on top line */}
          <text x={labelX.toFixed(1)} y={(labelY - 5).toFixed(1)}
            textAnchor="middle" dominantBaseline="middle"
            fontSize={9} fontWeight="700" fill="#fff"
            style={{ pointerEvents: 'none', userSelect: 'none' }}>
            {icon} {ratioText}
          </text>
          {/* Resource name on bottom line */}
          <text x={labelX.toFixed(1)} y={(labelY + 7).toFixed(1)}
            textAnchor="middle" dominantBaseline="middle"
            fontSize={7} fill="rgba(255,255,255,0.9)"
            style={{ pointerEvents: 'none', userSelect: 'none' }}>
            {nameText}
          </text>
        </g>
      );
    });
  }

  // ---- SVG bounds ----
  const svgWidth = 820;
  const svgHeight = 720;

  return (
    <div className="board-svg-wrap">
      <svg
        className="board-svg"
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        width="100%"
        height="100%"
        style={{ maxHeight: '100%', maxWidth: '100%' }}
      >
        {/* Ocean background */}
        <rect width={svgWidth} height={svgHeight} fill="#0a2a4a" rx={16} />

        {/* Hex tiles */}
        {renderHexes()}

        {/* Edges (roads) — below vertices */}
        {renderEdges()}

        {/* Ports */}
        {renderPorts()}

        {/* Vertices (buildings) */}
        {renderVertices()}
      </svg>

      {/* Resource float animations — absolutely positioned over board */}
      {(resourceAnimations || []).map(anim => {
        const hex = hexes.find(h => h.id === anim.hexId);
        if (!hex) return null;
        const { x, y } = hexToPixel(hex.q, hex.r);
        const pctX = (x / svgWidth * 100).toFixed(2) + '%';
        const pctY = (y / svgHeight * 100).toFixed(2) + '%';
        return (
          <div
            key={anim.key}
            className="resource-float-anim"
            style={{ left: pctX, top: pctY, animationDelay: `${anim.delay || 0}ms` }}
          >
            {anim.emoji}
          </div>
        );
      })}
    </div>
  );
};
