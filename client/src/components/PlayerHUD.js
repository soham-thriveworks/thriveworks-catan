// =============================================================
// PlayerHUD.js — Local player's resources, build menu, actions
// Exposed as window.PlayerHUD
// =============================================================

window.PlayerHUD = function PlayerHUD({
  player,
  gameState,
  myPlayerId,
  socket,
  isMyTurn,
  hasRolled,
  onBuildModeChange,
  buildMode,
  onFundingCardClick,
}) {
  if (!player) {
    return (
      <div className="hud-section" style={{ color: 'rgba(255,255,255,0.3)', fontSize: '13px' }}>
        Loading player…
      </div>
    );
  }

  const COLOR_MAP = {
    green:  '#2E7D32',
    blue:   '#1565C0',
    orange: '#E65100',
    purple: '#6A1B9A',
  };

  const playerColor = COLOR_MAP[player.color] || player.color || '#888';

  // Resource definitions
  const RESOURCES = [
    { key: 'therapist',      icon: '🧑‍⚕️', label: 'Therapist',  color: '#4CAF50' },
    { key: 'payerContracts', icon: '📋',    label: 'Payer Contr', color: '#2196F3' },
    { key: 'coeStaff',       icon: '👥',    label: 'COE Staff',   color: '#FFC107' },
    { key: 'rcmStaff',       icon: '💰',    label: 'RCM Staff',   color: '#FF9800' },
    { key: 'clinOps',        icon: '⚙️',    label: 'Clin Ops',    color: '#9E9E9E' },
  ];

  const resources = player.resources || {};
  const fundingCards = player.fundingCards || [];
  const vp = player.victoryPoints || 0;

  // Build costs
  const BUILD_ITEMS = [
    {
      key: 'road',
      icon: '🛣️',
      name: 'Network',
      cost: { therapist: 1, payerContracts: 1 },
      costStr: '1 Therapist + 1 Payer Contracts',
      buildMode: 'road',
    },
    {
      key: 'settlement',
      icon: '🏥',
      name: 'Practice Location',
      cost: { therapist: 1, payerContracts: 1, coeStaff: 1, rcmStaff: 1 },
      costStr: '1 Therapist + 1 Payer + 1 COE + 1 RCM',
      buildMode: 'settlement',
    },
    {
      key: 'city',
      icon: '🏛️',
      name: 'Market',
      cost: { rcmStaff: 2, clinOps: 3 },
      costStr: '2 RCM Staff + 3 Clin Ops',
      buildMode: 'city',
    },
    {
      key: 'fundingCard',
      icon: '🃏',
      name: 'Funding Card',
      cost: { coeStaff: 1, rcmStaff: 1, clinOps: 1 },
      costStr: '1 COE + 1 RCM + 1 Clin Ops',
      buildMode: null,
    },
  ];

  function canAfford(cost) {
    return Object.entries(cost).every(([res, amt]) => (resources[res] || 0) >= amt);
  }

  function handleBuild(item) {
    if (item.key === 'fundingCard') {
      socket.emit('buy_funding_card');
      return;
    }
    // Toggle build mode
    if (buildMode === item.buildMode) {
      onBuildModeChange(null);
    } else {
      onBuildModeChange(item.buildMode);
    }
  }

  function handleRoll() {
    socket.emit('roll_dice');
  }

  function handleEndTurn() {
    socket.emit('end_turn');
    onBuildModeChange(null);
  }

  // Dev card plays
  const PLAY_CARD_MAP = {
    engineer:               { label: '👩‍💻 Engineer',               emit: 'play_engineer' },
    networkExpansion:       { label: '🗺️ Network Expansion',       emit: 'play_network_expansion' },
    recruitmentDrive:       { label: '🤝 Recruitment Drive',       emit: 'play_recruitment_drive' },
    exclusivePayerContract: { label: '🏦 Exclusive Payer Contract', emit: 'play_exclusive_payer_contract' },
    victoryPoint:                    { label: '⭐ Victory Point',              emit: null },
    landedHealthSystemPartnership:   { label: '🏥 Landed Health System',       emit: null },
    launchedNewFeatureThriveCare:    { label: '🚀 New Feature ThriveCare',      emit: null },
    bookingV2GoLive:                 { label: '📅 Booking v2 Go Live',          emit: null },
    thriveConnectGoLive:             { label: '🔗 ThriveConnect Go Live',       emit: null },
    medicaidLaunchedNewState:        { label: '🏛️ Medicaid New State',          emit: null },
  };

  function handlePlayCard(cardType) {
    const entry = PLAY_CARD_MAP[cardType];
    if (!entry) return;
    // Simple emit; complex flows handled in DevIncident overlay via buildMode flags
    if (cardType === 'engineer') {
      onBuildModeChange('devIncident');
    } else if (cardType === 'networkExpansion') {
      onBuildModeChange('networkExpansion');
    } else {
      socket.emit(entry.emit, {});
    }
  }

  const phase = gameState.phase || 'main';
  const isSetupPhase = phase === 'setup_settlement' || phase === 'setup_road';
  const canRoll = isMyTurn && !hasRolled && !isSetupPhase;
  const canEndTurn = isMyTurn && hasRolled && !isSetupPhase;
  const canBuild = isMyTurn && (hasRolled || isSetupPhase) && !isSetupPhase; // normal build only in main phase

  return (
    <div>
      {/* Player info */}
      <div className="hud-section">
        <div className="player-info-row">
          <div className="player-color-badge" style={{ backgroundColor: playerColor }} />
          <span className="player-name-hud">{player.name || 'You'}</span>
          <span className="player-vp">⭐ {vp} VP</span>
        </div>
        {isMyTurn && (
          <div style={{
            fontSize: '11px',
            color: '#F5A623',
            fontWeight: 600,
            marginTop: '4px',
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
          }}>
            <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#F5A623', display: 'inline-block' }} />
            Your Turn
          </div>
        )}
      </div>

      {/* Resources */}
      <div className="hud-section">
        <div className="hud-section-title">Resources ({Object.values(resources).reduce((a,b) => a + b, 0)} total)</div>
        <div className="resource-grid">
          {RESOURCES.map(res => (
            <div className="resource-card" key={res.key} data-resource={res.key}>
              <div className="resource-icon">{res.icon}</div>
              <div className="resource-count">{resources[res.key] || 0}</div>
              <div className="resource-label">{res.label}</div>
              <div className="resource-color-bar" style={{ backgroundColor: res.color }} />
            </div>
          ))}
        </div>
      </div>

      {/* Funding Cards */}
      <div className="hud-section">
        <div className="hud-section-title">Funding Cards</div>
        <div className="funding-cards-row">
          <span className="funding-count-badge">🃏 {fundingCards.length} card{fundingCards.length !== 1 ? 's' : ''}</span>
          {fundingCards.map((card, idx) => {
            const cardType = typeof card === 'object' ? card.type : card;
            const canPlayNow = isMyTurn && hasRolled && PLAY_CARD_MAP[cardType]?.emit !== null && PLAY_CARD_MAP[cardType]?.emit !== undefined;
            return (
              <button
                key={idx}
                className={`funding-card-btn${canPlayNow ? ' playable' : ''}`}
                onClick={() => onFundingCardClick ? onFundingCardClick(cardType) : handlePlayCard(cardType)}
                title="Click to view card"
              >
                {PLAY_CARD_MAP[cardType]?.label || cardType}
              </button>
            );
          })}
        </div>
      </div>

      {/* Build menu */}
      <div className="hud-section">
        <div className="hud-section-title">Build</div>
        <div className="build-grid">
          {BUILD_ITEMS.map(item => {
            const affordable = canAfford(item.cost);
            const isActive = buildMode === item.buildMode && item.buildMode !== null;
            return (
              <button
                key={item.key}
                className={`build-btn${isActive ? ' active' : ''}`}
                onClick={() => handleBuild(item)}
                disabled={!canBuild || !affordable}
                title={item.costStr}
              >
                <span className="build-btn-icon">{item.icon}</span>
                <span className="build-btn-name">{item.name}</span>
                <span className="build-btn-cost">{item.costStr}</span>
              </button>
            );
          })}
        </div>
      </div>

      {isSetupPhase && isMyTurn && (
        <div className="hud-section" style={{ textAlign: 'center', color: '#F5A623', fontSize: '13px', fontWeight: 600 }}>
          {phase === 'setup_settlement' ? '👆 Click a vertex on the board to place your Practice Location' : '👆 Click an edge on the board to place your Network'}
        </div>
      )}
    </div>
  );
};
