// =============================================================
// FundingCardModal.js — Full-screen overlay showing a funding
// card's flavour text and letting the player confirm / configure
// before playing it.
// Exposed as window.FundingCardModal
// =============================================================

window.FundingCardModal = function FundingCardModal({
  cardType,       // string — the card type being played
  socket,
  canPlay,        // bool — true only when it's your turn and you've rolled
  onClose,        // called when dismissed without playing
  onActivate,     // called after emit so parent can set board mode etc.
}) {
  const { useState } = React;

  const RESOURCES = [
    { key: 'therapist',      icon: '🧑‍⚕️', label: 'Therapist'       },
    { key: 'payerContracts', icon: '📋',    label: 'Payer Contracts'  },
    { key: 'coeStaff',       icon: '👥',    label: 'COE Staff'        },
    { key: 'rcmStaff',       icon: '💰',    label: 'RCM Staff'        },
    { key: 'clinOps',        icon: '⚙️',    label: 'Clin Ops'         },
  ];

  const CARD_DEFS = {
    engineer: {
      icon: '👩‍💻',
      name: 'Engineer',
      flavour: '"The booking system is down — we\'re on it."',
      effect: 'Move the Dev Incident to any non-desert hex. Then steal 1 resource card from a player with a building on that hex.',
      actionLabel: 'Play — Choose a Hex',
      color: '#ef5350',
    },
    networkExpansion: {
      icon: '🗺️',
      name: 'Network Expansion',
      flavour: '"We\'re expanding to two new markets simultaneously."',
      effect: 'Place 2 free Networks (roads) anywhere connected to your existing network. No resources required.',
      actionLabel: 'Play — Place 2 Networks',
      color: '#42a5f5',
    },
    recruitmentDrive: {
      icon: '🤝',
      name: 'Recruitment Drive',
      flavour: '"Talent pipeline activated. Two new hires incoming."',
      effect: 'Take any 2 resource cards of your choice from the supply.',
      actionLabel: 'Confirm',
      color: '#66bb6a',
    },
    exclusivePayerContract: {
      icon: '🏦',
      name: 'Exclusive Payer Contract',
      flavour: '"We now hold the exclusive contract. Everyone else steps aside."',
      effect: 'Choose one resource type. Every other player must give you ALL of their cards of that type.',
      actionLabel: 'Confirm',
      color: '#FFC107',
    },
    landedHealthSystemPartnership: {
      icon: '🏥',
      name: 'Landed Health System Partnership',
      flavour: '"A major health system just signed with us."',
      effect: 'Worth 1 Victory Point. Revealed automatically when you reach 10 VP and win.',
      actionLabel: null,
      color: '#F5A623',
    },
    launchedNewFeatureThriveCare: {
      icon: '🚀',
      name: 'Launched New Feature to ThriveCare',
      flavour: '"ThriveCare just shipped something big."',
      effect: 'Worth 1 Victory Point. Revealed automatically when you reach 10 VP and win.',
      actionLabel: null,
      color: '#F5A623',
    },
    bookingV2GoLive: {
      icon: '📅',
      name: 'Booking v2 Go Live',
      flavour: '"The new booking system is live — zero incidents."',
      effect: 'Worth 1 Victory Point. Revealed automatically when you reach 10 VP and win.',
      actionLabel: null,
      color: '#F5A623',
    },
    thriveConnectGoLive: {
      icon: '🔗',
      name: 'ThriveConnect Go Live',
      flavour: '"ThriveConnect is now live across all markets."',
      effect: 'Worth 1 Victory Point. Revealed automatically when you reach 10 VP and win.',
      actionLabel: null,
      color: '#F5A623',
    },
    medicaidLaunchedNewState: {
      icon: '🏛️',
      name: 'Medicaid Launched in a New State',
      flavour: '"We just expanded Medicaid access to a brand-new state."',
      effect: 'Worth 1 Victory Point. Revealed automatically when you reach 10 VP and win.',
      actionLabel: null,
      color: '#F5A623',
    },
    victoryPoint: {
      icon: '⭐',
      name: 'Victory Point',
      flavour: '"A milestone achievement for Thriveworks."',
      effect: 'Worth 1 Victory Point. This card is kept hidden and revealed automatically when you reach 10 VP and win.',
      actionLabel: null,
      color: '#F5A623',
    },
  };

  const def = CARD_DEFS[cardType] || {
    icon: '🃏', name: cardType, flavour: '', effect: 'Unknown card.', actionLabel: 'Play', color: '#888',
  };

  // ---- Recruitment Drive: pick 2 resources ----
  const [rdPicks, setRdPicks] = useState([]);

  function toggleRdPick(key) {
    setRdPicks(prev => {
      if (prev.includes(key)) return prev.filter(k => k !== key);
      if (prev.length >= 2) return prev; // max 2
      return [...prev, key];
    });
  }

  // ---- Exclusive Payer Contract: pick 1 resource ----
  const [epcPick, setEpcPick] = useState(null);

  // ---- Play handlers ----
  function handlePlay() {
    if (cardType === 'engineer') {
      // No emit yet — parent sets board to hex-click mode
      onActivate('engineer');
      onClose();
    } else if (cardType === 'networkExpansion') {
      // No emit yet — parent sets board to road-click mode (2 roads)
      onActivate('networkExpansion');
      onClose();
    } else if (cardType === 'recruitmentDrive') {
      if (rdPicks.length !== 2) return;
      socket.emit('play_recruitment_drive', { resource1: rdPicks[0], resource2: rdPicks[1] });
      onActivate(null);
      onClose();
    } else if (cardType === 'exclusivePayerContract') {
      if (!epcPick) return;
      socket.emit('play_exclusive_payer_contract', { resource: epcPick });
      onActivate(null);
      onClose();
    }
  }

  const inputReady = (() => {
    if (cardType === 'engineer' || cardType === 'networkExpansion') return true;
    if (cardType === 'recruitmentDrive') return rdPicks.length === 2;
    if (cardType === 'exclusivePayerContract') return !!epcPick;
    return false;
  })();
  const canConfirm = !!canPlay && inputReady;

  return (
    <div
      className="funding-card-overlay"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="funding-card-modal" style={{ '--card-color': def.color }}>

        {/* Header */}
        <div className="fcm-header" style={{ borderBottom: `2px solid ${def.color}` }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <img
              src="/thriveworks-logo.png"
              className="fcm-logo"
              alt="TW"
              onError={e => { e.target.style.display = 'none'; }}
            />
            <span className="fcm-icon">{def.icon}</span>
          </div>
          <div>
            <div className="fcm-name">{def.name}</div>
            <div className="fcm-type">Funding Card</div>
          </div>
          <button className="fcm-close" onClick={onClose}>✕</button>
        </div>

        {/* Flavour text */}
        <div className="fcm-flavour">"{def.flavour.replace(/^"|"$/g, '')}"</div>

        {/* Effect */}
        <div className="fcm-effect-box" style={{ borderLeft: `3px solid ${def.color}` }}>
          <div className="fcm-effect-label">EFFECT</div>
          <div className="fcm-effect-text">{def.effect}</div>
        </div>

        {/* Recruitment Drive — resource picker */}
        {cardType === 'recruitmentDrive' && (
          <div className="fcm-picker">
            <div className="fcm-picker-label">Choose 2 resources ({rdPicks.length}/2):</div>
            <div className="fcm-picker-grid">
              {RESOURCES.map(r => {
                const selected = rdPicks.includes(r.key);
                const disabled = !selected && rdPicks.length >= 2;
                return (
                  <button
                    key={r.key}
                    className={`fcm-res-btn${selected ? ' selected' : ''}${disabled ? ' disabled' : ''}`}
                    onClick={() => !disabled && toggleRdPick(r.key)}
                    style={selected ? { borderColor: def.color, background: `${def.color}22` } : {}}
                  >
                    <span>{r.icon}</span>
                    <span>{r.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Exclusive Payer Contract — resource picker */}
        {cardType === 'exclusivePayerContract' && (
          <div className="fcm-picker">
            <div className="fcm-picker-label">Choose a resource to claim:</div>
            <div className="fcm-picker-grid">
              {RESOURCES.map(r => {
                const selected = epcPick === r.key;
                return (
                  <button
                    key={r.key}
                    className={`fcm-res-btn${selected ? ' selected' : ''}`}
                    onClick={() => setEpcPick(r.key)}
                    style={selected ? { borderColor: def.color, background: `${def.color}22` } : {}}
                  >
                    <span>{r.icon}</span>
                    <span>{r.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Board-interaction cards — instruction */}
        {(cardType === 'engineer' || cardType === 'networkExpansion') && (
          <div className="fcm-board-hint">
            {cardType === 'engineer'
              ? '👆 After clicking Play, click any non-desert hex on the board to move the Dev Incident.'
              : '👆 After clicking Play, click 2 edges on the board to place your free Networks.'}
          </div>
        )}

        {/* Footer buttons */}
        <div className="fcm-footer">
          <button className="fcm-btn-cancel" onClick={onClose}>Cancel</button>
          {def.actionLabel && (
            <button
              className="fcm-btn-play"
              style={{ background: canConfirm ? def.color : undefined }}
              onClick={handlePlay}
              disabled={!canConfirm}
              title={!canPlay
                ? (cardType === 'engineer'
                    ? 'Play the Engineer card on your turn (before or after rolling)'
                    : 'You can only play this card on your turn after rolling')
                : undefined}
            >
              {canPlay ? `${def.actionLabel} →` : (cardType === 'engineer' ? 'Play on your turn' : 'Play after rolling')}
            </button>
          )}
          {!def.actionLabel && (
            <button className="fcm-btn-cancel" onClick={onClose}>Got it</button>
          )}
        </div>

      </div>
    </div>
  );
};
