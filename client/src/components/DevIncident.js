// =============================================================
// DevIncident.js — Dev Incident flow overlay
// Handles discard / move / steal phases
// Exposed as window.DevIncident
// =============================================================

window.DevIncident = function DevIncident({
  gameState,
  myPlayerId,
  socket,
  devIncidentPhase, // 'discard' | 'move' | 'steal' | null
  mustDiscard,       // number of cards to discard
}) {
  const { useState, useMemo } = React;

  const [discardSelection, setDiscardSelection] = useState({});
  // discardSelection: { therapist: 0, payerContracts: 0, ... }

  const player = gameState && gameState.players
    ? gameState.players.find(p => p.id === myPlayerId)
    : null;

  const myResources = player ? player.resources || {} : {};

  const RESOURCES = [
    { key: 'therapist',      icon: '🧑‍⚕️', label: 'Therapist',       color: '#4CAF50' },
    { key: 'payerContracts', icon: '📋',    label: 'Payer Contracts',  color: '#2196F3' },
    { key: 'coeStaff',       icon: '👥',    label: 'COE Staff',        color: '#FFC107' },
    { key: 'rcmStaff',       icon: '💰',    label: 'RCM Staff',        color: '#FF9800' },
    { key: 'clinOps',        icon: '⚙️',    label: 'Clin Ops',         color: '#9E9E9E' },
  ];

  const COLOR_MAP = {
    green:  '#2E7D32',
    blue:   '#1565C0',
    orange: '#E65100',
    purple: '#6A1B9A',
  };

  const totalDiscardSelected = useMemo(
    () => Object.values(discardSelection).reduce((a, b) => a + b, 0),
    [discardSelection]
  );

  function adjustDiscard(resKey, delta) {
    const current = discardSelection[resKey] || 0;
    const have = myResources[resKey] || 0;
    const newVal = Math.min(have, Math.max(0, current + delta));
    setDiscardSelection(prev => ({ ...prev, [resKey]: newVal }));
  }

  function handleDiscard() {
    if (totalDiscardSelected !== mustDiscard) return;
    socket.emit('discard_cards', { cards: discardSelection });
    setDiscardSelection({});
  }

  function handleSteal(targetPlayerId) {
    // The board hex click sets the hex; this steals from a player on that hex
    socket.emit('move_dev_incident', { targetPlayerId });
  }

  // ---- Phase: discard ----
  if (devIncidentPhase === 'discard' && mustDiscard > 0) {
    return (
      <div className="dev-incident-overlay">
        <div className="dev-incident-modal">
          <div className="dev-incident-title">
            🚨 Dev Incident — Discard Required
          </div>
          <div className="dev-incident-desc">
            You have too many resources during a Dev Incident!<br />
            You must discard <strong style={{ color: '#ef5350' }}>{mustDiscard}</strong> resource card{mustDiscard !== 1 ? 's' : ''}.
          </div>

          <div className="discard-resources">
            {RESOURCES.map(res => {
              const have = myResources[res.key] || 0;
              const selected = discardSelection[res.key] || 0;
              if (have === 0) return null;
              return (
                <div
                  key={res.key}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    background: selected > 0 ? 'rgba(229,57,53,0.15)' : 'rgba(255,255,255,0.06)',
                    border: `1.5px solid ${selected > 0 ? '#ef5350' : 'rgba(255,255,255,0.12)'}`,
                    borderRadius: '10px',
                    padding: '10px 8px',
                    gap: '4px',
                  }}
                >
                  <span style={{ fontSize: '22px' }}>{res.icon}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <button
                      onClick={() => adjustDiscard(res.key, -1)}
                      disabled={selected === 0}
                      style={{
                        width: '22px', height: '22px', borderRadius: '50%',
                        background: 'rgba(255,255,255,0.1)', color: '#fff',
                        fontSize: '14px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        border: '1px solid rgba(255,255,255,0.2)', cursor: selected === 0 ? 'not-allowed' : 'pointer',
                        opacity: selected === 0 ? 0.4 : 1,
                      }}
                    >−</button>
                    <span style={{ color: selected > 0 ? '#ef5350' : '#fff', fontWeight: 700, fontSize: '15px', minWidth: '18px', textAlign: 'center' }}>
                      {selected}
                    </span>
                    <button
                      onClick={() => adjustDiscard(res.key, 1)}
                      disabled={selected >= have || totalDiscardSelected >= mustDiscard}
                      style={{
                        width: '22px', height: '22px', borderRadius: '50%',
                        background: 'rgba(255,255,255,0.1)', color: '#fff',
                        fontSize: '14px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        border: '1px solid rgba(255,255,255,0.2)', cursor: 'pointer',
                        opacity: (selected >= have || totalDiscardSelected >= mustDiscard) ? 0.4 : 1,
                      }}
                    >+</button>
                  </div>
                  <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    {res.label}<br />({have})
                  </span>
                </div>
              );
            })}
          </div>

          <div className="discard-selected-count">
            Selected: {totalDiscardSelected} / {mustDiscard}
            {totalDiscardSelected > mustDiscard && (
              <span style={{ color: '#ef5350', marginLeft: '8px' }}>Too many!</span>
            )}
          </div>

          <button
            className="btn-primary"
            style={{ width: '100%' }}
            onClick={handleDiscard}
            disabled={totalDiscardSelected !== mustDiscard}
          >
            🗑️ Confirm Discard
          </button>
        </div>
      </div>
    );
  }

  // ---- Phase: move (non-blocking banner — board clicks must remain usable) ----
  if (devIncidentPhase === 'move') {
    return (
      <div
        className="dev-incident-move-banner"
        style={{
          position: 'fixed',
          top: '72px',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 300,
          pointerEvents: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          background: 'rgba(20,10,10,0.92)',
          border: '2px solid #ef5350',
          borderRadius: '12px',
          padding: '10px 20px',
          color: '#ef9a9a',
          fontWeight: 700,
          fontSize: '14px',
          boxShadow: '0 4px 24px rgba(229,57,53,0.4)',
          animation: 'incidentFlash 0.6s ease-in-out 3',
        }}
      >
        <span style={{ fontSize: '22px' }}>🚨</span>
        <span>Click any non-desert hex to move the Dev Incident</span>
      </div>
    );
  }

  // ---- Phase: steal ----
  if (devIncidentPhase === 'steal') {
    // Find players on the hex with the dev incident
    const devIncidentHex = gameState.board && gameState.board.hexes
      ? gameState.board.hexes.find(h => h.hasDevIncident)
      : null;

    const eligiblePlayers = devIncidentHex
      ? (gameState.players || []).filter(p => {
          if (p.id === myPlayerId) return false;
          if ((p.resourceCount || 0) === 0) return false;
          // Check if they have a building on this hex
          const hexVertices = (gameState.board.vertices || []).filter(
            v => v.hexIds && v.hexIds.includes(devIncidentHex.id) && v.ownerId === p.id
          );
          return hexVertices.length > 0;
        })
      : [];

    return (
      <div className="dev-incident-overlay">
        <div className="dev-incident-modal">
          <div className="dev-incident-title">
            🚨 Steal a Resource
          </div>
          <div className="dev-incident-desc">
            Choose a player to steal one resource card from.
          </div>

          {eligiblePlayers.length === 0 ? (
            <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: '13px', textAlign: 'center', marginBottom: '16px' }}>
              No players to steal from on this hex.
            </div>
          ) : (
            <div className="steal-players">
              {eligiblePlayers.map(p => {
                const totalCards = p.resourceCount || 0;
                return (
                  <button
                    key={p.id}
                    className="steal-player-btn"
                    onClick={() => handleSteal(p.id)}
                    style={{ width: '100%', justifyContent: 'space-between' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <div
                        className="steal-dot"
                        style={{ backgroundColor: COLOR_MAP[p.color] || p.color || '#888' }}
                      />
                      <span style={{ fontWeight: 600 }}>{p.name}</span>
                    </div>
                    <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)' }}>
                      🃏 {totalCards} cards
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <button
            className="btn-secondary"
            style={{ width: '100%', borderRadius: '10px' }}
            onClick={() => socket.emit('move_dev_incident', { targetPlayerId: null })}
          >
            Skip (no steal)
          </button>
        </div>
      </div>
    );
  }

  // No overlay needed
  return null;
};
