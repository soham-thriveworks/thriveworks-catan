// =============================================================
// TradePanel.js — Player trade + bank trade panel
// Exposed as window.TradePanel
// =============================================================

window.TradePanel = function TradePanel({
  gameState,
  myPlayerId,
  socket,
  isMyTurn,
  pendingTrades,
}) {
  const { useState } = React;

  const [activeTab, setActiveTab] = useState('player'); // 'player' | 'bank'
  const [offerRes, setOfferRes] = useState('therapist');
  const [offerCount, setOfferCount] = useState(1);
  const [wantRes, setWantRes] = useState('payerContracts');
  const [wantCount, setWantCount] = useState(1);
  const [bankGive, setBankGive] = useState('therapist');
  const [bankReceive, setBankReceive] = useState('payerContracts');

  const RESOURCES = [
    { key: 'therapist',      label: '🧑‍⚕️ Therapist' },
    { key: 'payerContracts', label: '📋 Payer Contracts' },
    { key: 'coeStaff',       label: '👥 COE Staff' },
    { key: 'rcmStaff',       label: '💰 RCM Staff' },
    { key: 'clinOps',        label: '⚙️ Clin Ops' },
  ];

  const player = gameState && gameState.players
    ? gameState.players.find(p => p.id === myPlayerId)
    : null;

  const myResources = player ? player.resources || {} : {};

  // Calculate port-based bank rates
  function getBankRate(resource) {
    if (!gameState || !gameState.board || !gameState.board.ports) return 4;
    const ports = gameState.board.ports;
    // Check if player has a settlement/city on a port vertex
    const playerVertices = (gameState.board.vertices || [])
      .filter(v => v.ownerId === myPlayerId);
    const playerVertexIds = new Set(playerVertices.map(v => v.id));

    let bestRate = 4;
    ports.forEach(port => {
      const hasPort = (port.vertexIds || []).some(vid => playerVertexIds.has(vid));
      if (!hasPort) return;
      if (port.resource === 'generic' && port.ratio < bestRate) {
        bestRate = port.ratio;
      }
      if (port.resource === resource && port.ratio < bestRate) {
        bestRate = port.ratio;
      }
    });
    return bestRate;
  }

  function handleProposeTrade() {
    socket.emit('propose_trade', {
      offering: { [offerRes]: offerCount },
      requesting: { [wantRes]: wantCount },
    });
  }

  function handleAcceptTrade(tradeId) {
    socket.emit('accept_trade', { tradeId });
  }

  function handleDeclineTrade(tradeId) {
    socket.emit('decline_trade', { tradeId });
  }

  function handleBankTrade() {
    const rate = getBankRate(bankGive);
    socket.emit('bank_trade', {
      giving: bankGive,
      givingCount: rate,
      receiving: bankReceive,
    });
  }

  function getPlayerName(playerId) {
    if (!gameState || !gameState.players) return playerId;
    const p = gameState.players.find(pl => pl.id === playerId);
    return p ? p.name : playerId;
  }

  function formatResources(resObj) {
    return Object.entries(resObj || {})
      .filter(([, v]) => v > 0)
      .map(([k, v]) => {
        const r = RESOURCES.find(r => r.key === k);
        return `${v}× ${r ? r.label : k}`;
      })
      .join(', ');
  }

  const canTrade = isMyTurn && player;
  const canAffordOffer = (myResources[offerRes] || 0) >= offerCount;
  const bankRate = getBankRate(bankGive);
  const canAffordBank = (myResources[bankGive] || 0) >= bankRate;

  return (
    <div className="trade-section">
      <div className="hud-section-title">Trade</div>

      {/* Tabs */}
      <div className="trade-tabs">
        <button
          className={`trade-tab${activeTab === 'player' ? ' active' : ''}`}
          onClick={() => setActiveTab('player')}
        >
          With Players
        </button>
        <button
          className={`trade-tab${activeTab === 'bank' ? ' active' : ''}`}
          onClick={() => setActiveTab('bank')}
        >
          With Bank
        </button>
      </div>

      {/* Player Trade Tab */}
      {activeTab === 'player' && (
        <div>
          {/* My proposals (awaiting response) */}
          {pendingTrades && pendingTrades.filter(t => t.fromPlayerId === myPlayerId).length > 0 && (
            <div style={{ marginBottom: '12px' }}>
              <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
                Your Offer
              </div>
              {pendingTrades.filter(t => t.fromPlayerId === myPlayerId).map(trade => (
                <div className="incoming-trade" key={trade.tradeId} style={{ borderColor: 'rgba(245,166,35,0.35)' }}>
                  <div className="incoming-trade-header" style={{ color: '#F5A623' }}>
                    ⏳ Awaiting Response…
                  </div>
                  <div className="incoming-trade-offer">
                    <span style={{ color: '#81c784' }}>You offer:</span> {formatResources(trade.offering)}<br />
                    <span style={{ color: '#ef9a9a' }}>You want:</span> {formatResources(trade.requesting)}
                  </div>
                  <div className="trade-action-row">
                    <button
                      className="btn-decline"
                      style={{ width: '100%' }}
                      onClick={() => handleDeclineTrade(trade.tradeId)}
                    >
                      ✕ Cancel Offer
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Incoming trades from others */}
          {pendingTrades && pendingTrades.filter(t => t.fromPlayerId !== myPlayerId).length > 0 && (
            <div style={{ marginBottom: '12px' }}>
              <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
                Incoming Proposals
              </div>
              {pendingTrades.filter(t => t.fromPlayerId !== myPlayerId).map(trade => {
                const canFulfill = Object.entries(trade.requesting || {})
                  .every(([res, amt]) => (myResources[res] || 0) >= amt);
                return (
                  <div className="incoming-trade" key={trade.tradeId}>
                    <div className="incoming-trade-header">
                      From {getPlayerName(trade.fromPlayerId)}
                    </div>
                    <div className="incoming-trade-offer">
                      <span style={{ color: '#81c784' }}>Offers:</span> {formatResources(trade.offering)}<br />
                      <span style={{ color: '#ef9a9a' }}>Wants:</span> {formatResources(trade.requesting)}
                    </div>
                    {!canFulfill && (
                      <div style={{ fontSize: '11px', color: '#9e9e9e', background: 'rgba(255,255,255,0.06)', borderRadius: '6px', padding: '4px 8px', marginBottom: '6px', textAlign: 'center' }}>
                        🚫 Can't Fulfill
                      </div>
                    )}
                    <div className="trade-action-row">
                      {canFulfill && (
                        <button
                          className="btn-accept"
                          onClick={() => handleAcceptTrade(trade.tradeId)}
                        >
                          ✓ Accept
                        </button>
                      )}
                      <button
                        className="btn-decline"
                        onClick={() => handleDeclineTrade(trade.tradeId)}
                      >
                        ✗ Decline
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Propose trade (only on your turn) */}
          {canTrade && (
            <div>
              <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
                Propose Trade
              </div>
              <div className="trade-resource-select">
                <div className="trade-row">
                  <span className="trade-label" style={{ color: '#81c784' }}>Offer</span>
                  <select
                    className="trade-select"
                    value={offerRes}
                    onChange={e => setOfferRes(e.target.value)}
                  >
                    {RESOURCES.map(r => (
                      <option key={r.key} value={r.key}>{r.label} (have {myResources[r.key] || 0})</option>
                    ))}
                  </select>
                  <input
                    type="number"
                    className="trade-count-input"
                    min={1}
                    max={myResources[offerRes] || 0}
                    value={offerCount}
                    onChange={e => setOfferCount(Math.max(1, parseInt(e.target.value) || 1))}
                  />
                </div>
                <div className="trade-row">
                  <span className="trade-label" style={{ color: '#ef9a9a' }}>Want</span>
                  <select
                    className="trade-select"
                    value={wantRes}
                    onChange={e => setWantRes(e.target.value)}
                  >
                    {RESOURCES.map(r => (
                      <option key={r.key} value={r.key}>{r.label}</option>
                    ))}
                  </select>
                  <input
                    type="number"
                    className="trade-count-input"
                    min={1}
                    max={9}
                    value={wantCount}
                    onChange={e => setWantCount(Math.max(1, parseInt(e.target.value) || 1))}
                  />
                </div>
              </div>
              <button
                className="btn-propose"
                onClick={handleProposeTrade}
                disabled={!canAffordOffer || offerRes === wantRes}
              >
                📤 Propose Trade
              </button>
              {!canAffordOffer && (
                <div style={{ fontSize: '11px', color: '#ef9a9a', marginTop: '4px', textAlign: 'center' }}>
                  Not enough {offerRes}
                </div>
              )}
            </div>
          )}
          {!isMyTurn && (
            <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '8px 0' }}>
              You can accept/decline trades on others' turns too.
            </div>
          )}
        </div>
      )}

      {/* Bank Trade Tab */}
      {activeTab === 'bank' && (
        <div>
          <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
            Maritime Trade
          </div>

          {/* Port rates summary */}
          <div style={{ marginBottom: '12px' }}>
            <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', marginBottom: '6px' }}>Your rates:</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {RESOURCES.map(r => {
                const rate = getBankRate(r.key);
                return (
                  <div key={r.key} style={{ fontSize: '11px', color: rate < 4 ? '#F5A623' : 'rgba(255,255,255,0.4)' }}>
                    {r.label}: <span className="bank-ratio">{rate}:1</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="trade-resource-select">
            <div className="trade-row">
              <span className="trade-label" style={{ color: '#ef9a9a' }}>Give</span>
              <select
                className="trade-select"
                value={bankGive}
                onChange={e => setBankGive(e.target.value)}
              >
                {RESOURCES.map(r => (
                  <option key={r.key} value={r.key}>{r.label} (have {myResources[r.key] || 0})</option>
                ))}
              </select>
              <div className="bank-ratio">{bankRate}×</div>
            </div>
            <div className="trade-row">
              <span className="trade-label" style={{ color: '#81c784' }}>Get</span>
              <select
                className="trade-select"
                value={bankReceive}
                onChange={e => setBankReceive(e.target.value)}
              >
                {RESOURCES.filter(r => r.key !== bankGive).map(r => (
                  <option key={r.key} value={r.key}>{r.label}</option>
                ))}
              </select>
              <div className="bank-ratio">1×</div>
            </div>
          </div>

          <button
            className="btn-propose"
            onClick={handleBankTrade}
            disabled={!canTrade || !canAffordBank}
            style={{ marginTop: '10px' }}
          >
            🏦 Trade with Bank ({bankRate}:{1})
          </button>
          {!canAffordBank && player && (
            <div style={{ fontSize: '11px', color: '#ef9a9a', marginTop: '4px', textAlign: 'center' }}>
              Need {bankRate}× {bankGive} (have {myResources[bankGive] || 0})
            </div>
          )}
        </div>
      )}
    </div>
  );
};
