// =============================================================
// Dice.js — Dice display with animation
// Exposed as window.Dice
// =============================================================

window.Dice = function Dice({ dice, rolling, lastTotal, devIncidentMessage }) {
  const DIE_FACES = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

  const d1 = dice && dice[0] ? dice[0] : null;
  const d2 = dice && dice[1] ? dice[1] : null;
  const total = (d1 && d2) ? d1 + d2 : null;

  const isSeven = total === 7;

  return (
    <div className="dice-section">
      <div className="hud-section-title">Dice</div>

      <div className="dice-row">
        <div className={`die${rolling ? ' rolling' : ''}`}>
          {rolling
            ? <span style={{ fontSize: '28px' }}>🎲</span>
            : (d1 ? DIE_FACES[d1] : <span style={{ color: '#ccc', fontSize: '20px' }}>–</span>)
          }
        </div>
        <div className={`die${rolling ? ' rolling' : ''}`} style={{ animationDelay: '0.08s' }}>
          {rolling
            ? <span style={{ fontSize: '28px' }}>🎲</span>
            : (d2 ? DIE_FACES[d2] : <span style={{ color: '#ccc', fontSize: '20px' }}>–</span>)
          }
        </div>
        {total && !rolling && (
          <div style={{
            fontSize: '28px',
            fontWeight: 700,
            color: isSeven ? '#ef5350' : '#F5A623',
            minWidth: '40px',
            textAlign: 'center',
          }}>
            = {total}
          </div>
        )}
      </div>

      {/* Dev Incident alert on 7 */}
      {isSeven && !rolling && (
        <div className="dev-incident-alert">
          <span style={{ fontSize: '20px' }}>🚨</span>
          <div>
            <div style={{ fontWeight: 700, color: '#ef5350', marginBottom: '2px' }}>
              DEV INCIDENT!
            </div>
            <div style={{ fontSize: '11px', color: 'rgba(239,154,154,0.8)' }}>
              {devIncidentMessage || 'Something went wrong!'}
            </div>
          </div>
        </div>
      )}

      {/* Rolling animation overlay text */}
      {rolling && (
        <div style={{
          textAlign: 'center',
          fontSize: '12px',
          color: 'rgba(255,255,255,0.4)',
          marginTop: '6px',
          fontStyle: 'italic',
        }}>
          Rolling…
        </div>
      )}

      {/* Numeric total (non-7) */}
      {total && !rolling && !isSeven && (
        <div className="dice-total" style={{ fontSize: '13px', color: 'rgba(255,255,255,0.4)', marginTop: '4px' }}>
          Last roll: {total}
        </div>
      )}
    </div>
  );
};
