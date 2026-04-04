// =============================================================
// App.js — Main application entry point
// Manages top-level state and socket event listeners
// =============================================================

(function () {
  const { useState, useEffect, useCallback, useRef } = React;

  // ---- Color map ----
  const COLOR_MAP = {
    green:  '#2E7D32',
    blue:   '#1565C0',
    orange: '#E65100',
    purple: '#6A1B9A',
  };

  function playerColor(p) {
    if (!p) return '#888';
    return COLOR_MAP[p.color] || p.color || '#888';
  }

  // ---- Game screen ----
  function GameScreen({
    gameState,
    myPlayerId,
    messages,
    pendingTrades,
    diceState,
    devIncidentMessage,
    devIncidentPhase,
    mustDiscard,
    resourceAnimations,
    stealToast,
    socket,
    onGameOver,
  }) {
    const [buildMode, setBuildMode] = useState(null);
    const [stealAnim, setStealAnim] = useState(null);
    const [tradeAnim, setTradeAnim] = useState(null);

    const RES_EMOJI_TRADE = { therapist: '🧑‍⚕️', payerContracts: '📋', coeStaff: '👥', rcmStaff: '💰', clinOps: '⚙️' };
    function getFirstResourceEmoji(resources) {
      if (!resources) return '🃏';
      const key = Object.keys(resources)[0];
      return RES_EMOJI_TRADE[key] || '🃏';
    }

    // Steal animation — triggered by server broadcast to entire room
    useEffect(() => {
      if (!socket) return;
      function handleStealAnimation({ thiefId, victimId }) {
        const fromEl = document.querySelector(`[data-player-id="${victimId}"]`);
        const toEl   = document.querySelector(`[data-player-id="${thiefId}"]`);
        if (!fromEl || !toEl) return;
        const fromRect = fromEl.getBoundingClientRect();
        const toRect   = toEl.getBoundingClientRect();
        const fromX = fromRect.left + fromRect.width / 2;
        const fromY = fromRect.top  + fromRect.height / 2;
        setStealAnim({
          key: Date.now(),
          fromX,
          fromY,
          dx: (toRect.left + toRect.width  / 2) - fromX,
          dy: (toRect.top  + toRect.height / 2) - fromY,
        });
        setTimeout(() => setStealAnim(null), 1200);
      }
      socket.on('steal_animation', handleStealAnimation);
      return () => socket.off('steal_animation', handleStealAnimation);
    }, [socket]);

    // Trade exchange animation — triggered when a trade is accepted
    useEffect(() => {
      if (!socket) return;
      function handleTradeAnimation({ accepted, fromPlayerId, toPlayerId, offering, requesting }) {
        if (!accepted) return;
        const fromEl = document.querySelector(`[data-player-id="${fromPlayerId}"]`);
        const toEl   = document.querySelector(`[data-player-id="${toPlayerId}"]`);
        if (!fromEl || !toEl) return;
        const fromRect = fromEl.getBoundingClientRect();
        const toRect   = toEl.getBoundingClientRect();
        const fromX = fromRect.left + fromRect.width  / 2;
        const fromY = fromRect.top  + fromRect.height / 2;
        const toX   = toRect.left  + toRect.width  / 2;
        const toY   = toRect.top   + toRect.height / 2;
        setTradeAnim({
          key: Date.now(),
          fromX, fromY, toX, toY,
          dx: toX - fromX,
          dy: toY - fromY,
          offeringEmoji:   getFirstResourceEmoji(offering),
          requestingEmoji: getFirstResourceEmoji(requesting),
        });
        setTimeout(() => setTradeAnim(null), 1400);
      }
      socket.on('trade_resolved', handleTradeAnimation);
      return () => socket.off('trade_resolved', handleTradeAnimation);
    }, [socket]);

    // Hurry-up notification
    useEffect(() => {
      if (!socket) return;
      function handleHurryUp({ fromPlayerName }) {
        setHurryUp({ fromPlayerName, key: Date.now() });
        setTimeout(() => setHurryUp(null), 3500);
      }
      socket.on('hurry_up', handleHurryUp);
      return () => socket.off('hurry_up', handleHurryUp);
    }, [socket]);

    const [activeCardModal, setActiveCardModal] = useState(null); // cardType string or null
    const [networkExpansionEdges, setNetworkExpansionEdges] = useState([]);
    const [rollReminder, setRollReminder] = useState(false);
    const [hurryUp, setHurryUp] = useState(null); // { fromPlayerName, key }
    // buildMode: null | 'road' | 'settlement' | 'city' | 'devIncident' | 'networkExpansion'

    const players = gameState.players || [];
    const me = players.find(p => p.id === myPlayerId);
    const currentPlayerId = gameState.currentPlayerId;
    const currentPlayer = players.find(p => p.id === currentPlayerId);
    const isMyTurn = currentPlayerId === myPlayerId;
    const hasRolled = gameState.hasRolled || false;

    // Phase derived from gameState
    const phase = gameState.phase || 'main';
    const isSetupSettlement = phase === 'setup_settlement';
    const isSetupRoad = phase === 'setup_road';
    const isInitialPlacement = isSetupSettlement || isSetupRoad;

    const boardPhase = (() => {
      if (isMyTurn && isSetupSettlement) return 'place_initial_settlement';
      if (isMyTurn && isSetupRoad) return 'place_initial_road';
      return phase;
    })();

    const effectiveBuildMode = (() => {
      if (isMyTurn && isSetupSettlement) return 'settlement';
      if (isMyTurn && isSetupRoad) return 'road';
      if (isMyTurn && phase === 'dev_incident_move') return 'devIncident';
      return buildMode;
    })();

    // ---- Roll reminder: nudge current player after 20s of not rolling ----
    useEffect(() => {
      setRollReminder(false);
      if (!isMyTurn || hasRolled || isInitialPlacement) return;
      const t = setTimeout(() => setRollReminder(true), 20000);
      return () => clearTimeout(t);
    }, [isMyTurn, hasRolled, isInitialPlacement, gameState.currentPlayerId]);

    // ---- Board interaction handlers ----
    function handleVertexClick(vertexId) {
      if (!isMyTurn) return;
      if (effectiveBuildMode === 'settlement') {
        if (isInitialPlacement) {
          socket.emit('place_initial_settlement', { vertexId });
        } else {
          socket.emit('build_settlement', { vertexId });
          setBuildMode(null);
        }
      } else if (effectiveBuildMode === 'city') {
        socket.emit('build_city', { vertexId });
        setBuildMode(null);
      }
    }

    function handleEdgeClick(edgeId) {
      if (!isMyTurn) return;
      if (effectiveBuildMode === 'road') {
        if (isInitialPlacement) {
          socket.emit('place_initial_road', { edgeId });
        } else {
          socket.emit('build_road', { edgeId });
          setBuildMode(null);
        }
      } else if (effectiveBuildMode === 'networkExpansion') {
        setNetworkExpansionEdges(prev => {
          const next = [...prev, edgeId];
          if (next.length === 2) {
            socket.emit('play_network_expansion', { edgeId1: next[0], edgeId2: next[1] });
            setBuildMode(null);
            return [];
          }
          return next; // wait for second click
        });
      }
    }

    function handleHexClick(hexId) {
      if (!isMyTurn) return;
      if (effectiveBuildMode === 'devIncident') {
        if (phase === 'dev_incident_move') {
          // After a 7 roll — server is already in dev_incident_move phase
          socket.emit('move_dev_incident', { hexId });
        } else {
          // After clicking an engineer card — tell server to play the card + move the incident
          socket.emit('play_engineer', { hexId });
        }
        setBuildMode(null);
      }
    }

    // ---- Turn bar content ----
    function TurnBar() {
      const vpLeader = [...players].sort((a, b) => (b.victoryPoints || 0) - (a.victoryPoints || 0))[0];
      const turnLabel = isMyTurn
        ? 'Your Turn'
        : currentPlayer
          ? `${currentPlayer.name}'s Turn`
          : 'Waiting…';

      return (
        <div className="turn-bar">
          <div className="turn-bar-logo">
            <img
              src="/thriveworks-logo.png"
              alt="TW"
              className="turn-bar-logo-img"
              onError={e => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'inline'; }}
            />
            <span style={{ display: 'none' }}>⚕️ TW Catan</span>
          </div>
          <div className="turn-indicator">
            <div
              className="turn-dot"
              style={{ backgroundColor: currentPlayer ? playerColor(currentPlayer) : '#888' }}
            />
            <span className="turn-text">{turnLabel}</span>
          </div>
          {isInitialPlacement && (
            <span className="badge" style={{ marginLeft: '8px' }}>
              Setup — {isSetupSettlement ? 'Place Practice Location' : 'Place Network'}
            </span>
          )}
          {isMyTurn && !hasRolled && !isInitialPlacement && (
            <span className="badge" style={{ marginLeft: '8px', color: '#F5A623' }}>Roll dice to begin</span>
          )}
          {vpLeader && (
            <span className="turn-bar-vp" style={{ marginLeft: 'auto' }}>
              🏆 Leading: {vpLeader.name} ({vpLeader.victoryPoints || 0} VP)
            </span>
          )}
          {!isMyTurn && !isInitialPlacement && (
            <button
              className="btn-hurry-up"
              onClick={() => socket.emit('hurry_up')}
              title="Nudge the current player"
            >
              ⌚ Hurry Up
            </button>
          )}
        </div>
      );
    }

    // ---- Other players strip ----
    function OthersBar() {
      const others = players.filter(p => p.id !== myPlayerId);
      if (!others.length) return <div className="others-bar" />;
      return (
        <div className="others-bar">
          <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.3)', flexShrink: 0, textTransform: 'uppercase', letterSpacing: '0.8px' }}>
            Players:
          </span>
          {others.map(p => {
            const totalResources = p.resourceCount != null ? p.resourceCount : Object.values(p.resources || {}).reduce((a, b) => a + b, 0);
            const practices    = (p.practiceLocations || []).length;
            const markets      = (p.stateNetworks || []).length;
            const networks     = (p.networks || []).length;
            const fundingCards = p.fundingCardCount || 0;
            const engineers    = p.playedEngineers || 0;
            const isActive     = p.id === currentPlayerId;
            return (
              <div
                key={p.id}
                data-player-id={p.id}
                className={`other-player-card${isActive ? ' active-player' : ''}`}
              >
                <div className="other-player-header">
                  <div className="other-player-dot" style={{ backgroundColor: playerColor(p) }} />
                  <span className="other-player-name">{p.name}</span>
                  <span className="other-player-vp">⭐ {p.victoryPoints || 0}</span>
                  {isActive && <span style={{ marginLeft: '4px', fontSize: '10px', color: '#F5A623' }}>●</span>}
                </div>
                <div className="other-player-stats">
                  <span className="other-player-stat" title="Resources">🗂️ {totalResources}</span>
                  <span className="other-player-stat" title="Funding Cards">🃏 {fundingCards}</span>
                  <span className="other-player-stat" title="Practice Locations">🏥 {practices}</span>
                  <span className="other-player-stat" title="Markets">🏛️ {markets}</span>
                  <span className="other-player-stat" title="Networks">🛣️ {networks}</span>
                  <span className="other-player-stat" title="Engineers Played">👩‍💻 {engineers}</span>
                </div>
              </div>
            );
          })}
        </div>
      );
    }

    return (
      <div className="game-screen">
        {/* Turn bar */}
        <TurnBar />

        {/* Board */}
        <div className="board-area">
          <window.Board
            gameState={gameState}
            myPlayerId={myPlayerId}
            phase={boardPhase}
            onVertexClick={handleVertexClick}
            onEdgeClick={handleEdgeClick}
            onHexClick={handleHexClick}
            buildMode={effectiveBuildMode}
            resourceAnimations={resourceAnimations}
          />
        </div>

        {/* Right sidebar */}
        <div className="sidebar" data-player-id={myPlayerId}>
          {/* Dice */}
          <window.Dice
            dice={diceState.dice}
            rolling={diceState.rolling}
            lastTotal={diceState.total}
            devIncidentMessage={devIncidentMessage}
          />

          {/* Roll / End Turn — always visible, right under dice */}
          {!isInitialPlacement && (
            <div className="sidebar-actions">
              <button
                className="btn-roll"
                onClick={() => socket.emit('roll_dice')}
                disabled={!isMyTurn || hasRolled}
              >
                🎲 Roll Dice
              </button>
              <button
                className="btn-end-turn"
                onClick={() => { socket.emit('end_turn'); setBuildMode(null); }}
                disabled={!isMyTurn || !hasRolled}
              >
                ✅ End Turn
              </button>
            </div>
          )}
          {isInitialPlacement && isMyTurn && (
            <div className="sidebar-setup-hint">
              {phase === 'setup_settlement'
                ? '👆 Click the board to place your Practice Location'
                : '👆 Click an edge to place your Network'}
            </div>
          )}

          {/* Roll reminder */}
          {rollReminder && (
            <div className="roll-reminder" onClick={() => { socket.emit('roll_dice'); setRollReminder(false); }}>
              🎲 Don't forget to roll!
            </div>
          )}

          {/* Resources + Build */}
          <window.PlayerHUD
            player={me}
            gameState={gameState}
            myPlayerId={myPlayerId}
            socket={socket}
            isMyTurn={isMyTurn}
            hasRolled={hasRolled}
            onBuildModeChange={setBuildMode}
            buildMode={effectiveBuildMode}
            onFundingCardClick={cardType => setActiveCardModal(cardType)}
          />

          {/* Trade section */}
          <div className="sidebar-section-header">
            🤝 Trade
            {pendingTrades.length > 0 && (
              <span className="trade-badge">{pendingTrades.length}</span>
            )}
          </div>
          <window.TradePanel
            gameState={gameState}
            myPlayerId={myPlayerId}
            socket={socket}
            isMyTurn={isMyTurn}
            pendingTrades={pendingTrades}
          />
        </div>

        {/* Bottom area: other players + chat */}
        <div className="bottom-area">
          <OthersBar />
          <window.Chat
            messages={messages}
            myPlayerId={myPlayerId}
            players={players}
            socket={socket}
          />
        </div>

        {/* Funding Card Modal */}
        {activeCardModal && (
          <window.FundingCardModal
            cardType={activeCardModal}
            socket={socket}
            canPlay={
              isMyTurn &&
              // Engineer can be played before OR after rolling; all others require rolling first
              (activeCardModal === 'engineer' ? !isInitialPlacement : hasRolled) &&
              !gameState.hasPlayedFundingCard &&
              (me?.fundingCards || []).some(c => c.type === activeCardModal && !c.isNew)
            }
            onClose={() => setActiveCardModal(null)}
            onActivate={mode => {
              if (mode === 'engineer') setBuildMode('devIncident');
              else if (mode === 'networkExpansion') { setBuildMode('networkExpansion'); setNetworkExpansionEdges([]); }
            }}
          />
        )}

        {/* Dev Incident overlay */}
        <window.DevIncident
          gameState={gameState}
          myPlayerId={myPlayerId}
          socket={socket}
          devIncidentPhase={devIncidentPhase}
          mustDiscard={mustDiscard}
        />

        {/* Steal animation */}
        {stealAnim && (
          <div
            key={stealAnim.key}
            className="steal-anim"
            style={{
              left: stealAnim.fromX,
              top: stealAnim.fromY,
              '--dx': `${stealAnim.dx}px`,
              '--dy': `${stealAnim.dy}px`,
            }}
          >
            🃏
          </div>
        )}

        {/* Trade exchange animation */}
        {tradeAnim && (
          <React.Fragment key={tradeAnim.key}>
            <div className="trade-anim-card" style={{
              left: tradeAnim.fromX,
              top:  tradeAnim.fromY,
              '--dx': `${tradeAnim.dx}px`,
              '--dy': `${tradeAnim.dy}px`,
            }}>
              {tradeAnim.offeringEmoji}
            </div>
            <div className="trade-anim-card" style={{
              left: tradeAnim.toX,
              top:  tradeAnim.toY,
              '--dx': `${-tradeAnim.dx}px`,
              '--dy': `${-tradeAnim.dy}px`,
              animationDelay: '0.05s',
            }}>
              {tradeAnim.requestingEmoji}
            </div>
          </React.Fragment>
        )}

        {/* Steal toast */}
        {stealToast && (
          <div style={{
            position: 'fixed',
            bottom: '24px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 500,
            background: 'rgba(20,15,35,0.97)',
            border: '1.5px solid rgba(245,166,35,0.6)',
            borderRadius: '12px',
            padding: '12px 22px',
            color: '#fff',
            fontSize: '14px',
            fontWeight: 600,
            boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
            animation: 'incidentModalIn 0.3s ease',
            maxWidth: '360px',
            textAlign: 'center',
          }}>
            {stealToast}
          </div>
        )}

        {/* Hurry-up overlay */}
        {hurryUp && (
          <div key={hurryUp.key} className="hurry-up-overlay">
            <div className="hurry-up-watch">⌚</div>
            <div className="hurry-up-text">PLAY OR PASS</div>
            <div className="hurry-up-from">{hurryUp.fromPlayerName} is waiting</div>
          </div>
        )}
      </div>
    );
  }

  // ---- Game Over overlay ----
  function GameOverOverlay({ winnerId, winnerName, players, onNewGame }) {
    const sorted = [...(players || [])].sort((a, b) => (b.victoryPoints || 0) - (a.victoryPoints || 0));
    const COLOR_MAP = { green: '#2E7D32', blue: '#1565C0', orange: '#E65100', purple: '#6A1B9A' };
    return (
      <div className="game-over-overlay">
        <div className="game-over-card">
          <div className="game-over-emoji">🏆</div>
          <div className="game-over-title">Game Over!</div>
          <div className="game-over-winner">{winnerName} wins!</div>

          {/* Player leaderboard */}
          <div className="game-over-leaderboard">
            {sorted.map((p, i) => {
              const isWinner = p.id === winnerId;
              const color = COLOR_MAP[p.color] || p.color || '#888';
              const practices = (p.practiceLocations || []).length;
              const markets   = (p.stateNetworks || []).length;
              const networks  = (p.networks || []).length;
              const cards     = p.fundingCardCount || 0;
              const resources = Object.values(p.resources || {}).reduce((s, v) => s + v, 0);
              return (
                <div
                  key={p.id}
                  className={`gol-row${isWinner ? ' gol-winner' : ''}`}
                >
                  <span className="gol-rank">{i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`}</span>
                  <span className="gol-dot" style={{ background: color }} />
                  <span className="gol-name">{p.name}</span>
                  <span className="gol-vp">⭐ {p.victoryPoints || 0} VP</span>
                  <div className="gol-stats">
                    <span title="Practice Locations">🏥 {practices}</span>
                    <span title="Markets">🏛️ {markets}</span>
                    <span title="Networks">🛣️ {networks}</span>
                    <span title="Funding Cards">🃏 {cards}</span>
                    <span title="Resources in hand">🗂️ {resources}</span>
                  </div>
                </div>
              );
            })}
          </div>

          <button className="btn-new-game" onClick={onNewGame}>
            🔄 Play Again
          </button>
        </div>
      </div>
    );
  }

  // ================================================================
  // ROOT APP
  // ================================================================
  function App() {
    // ---- Socket ----
    const socketRef = useRef(null);
    const [socketReady, setSocketReady] = useState(false);

    // ---- Screen state ----
    const [screen, setScreen] = useState('lobby'); // 'lobby' | 'game'

    // ---- Game state ----
    const [gameState, setGameState] = useState(null);
    const [myPlayerId, setMyPlayerId] = useState(null);
    const myPlayerIdRef = useRef(null);

    // ---- Chat messages ----
    const [messages, setMessages] = useState([]);

    // ---- Pending trades ----
    const [pendingTrades, setPendingTrades] = useState([]);

    // ---- Trade alert sequence (for tab auto-switch) ----
    const [tradeAlertSeq, setTradeAlertSeq] = useState(0);

    // ---- Dev Incident message pool ----
    // ---- Dice state ----
    const [diceState, setDiceState] = useState({ dice: null, rolling: false, total: null });
    const [devIncidentMessage, setDevIncidentMessage] = useState(null);
    const [resourceAnimations, setResourceAnimations] = useState([]);

    // ---- Dev Incident ----
    const [devIncidentPhase, setDevIncidentPhase] = useState(null); // null | 'discard' | 'move' | 'steal'
    const [mustDiscard, setMustDiscard] = useState(0);

    // ---- Steal toast ----
    const [stealToast, setStealToast] = useState(null);

    // ---- Game over ----
    const [gameOver, setGameOver] = useState(null); // { winnerId, winnerName }

    // ---- Init socket ----
    useEffect(() => {
      const socket = io(window.location.origin, {
        reconnectionAttempts: 5,
        timeout: 10000,
      });
      socketRef.current = socket;

      socket.on('connect', () => {
        console.log('[Socket] Connected:', socket.id);
        setSocketReady(true);
      });

      socket.on('disconnect', () => {
        console.log('[Socket] Disconnected');
        setSocketReady(false);
      });

      socket.on('connect_error', (err) => {
        console.warn('[Socket] Connection error:', err.message);
      });

      // ---- Game Events ----
      // NOTE: game_started is handled by the Lobby component via onGameStart callback.
      // We only listen for game_state_update and other mid-game events here.

      socket.on('game_state_update', ({ gameState: gs }) => {
        setGameState(gs);
      });

      const RES_EMOJI = {
        therapist: '🧑‍⚕️', payerContracts: '📋', coeStaff: '👥', rcmStaff: '💰', clinOps: '⚙️',
      };

      socket.on('dice_rolled', ({ dice, total, playerId, playerName, resourcesProduced, devIncidentMessage }) => {
        if (devIncidentMessage) setDevIncidentMessage(devIncidentMessage);
        setDiceState({ dice, rolling: true, total });
        // Spawn resource float animations after dice settle (~1s)
        if (resourcesProduced && resourcesProduced.length > 0) {
          setTimeout(() => {
            const anims = resourcesProduced.map((r, i) => ({
              key: `${Date.now()}-${i}`,
              hexId: r.hexId,
              emoji: RES_EMOJI[r.resource] || '📦',
              delay: i * 200,
            }));
            setResourceAnimations(anims);
            setTimeout(() => setResourceAnimations([]), 2000);
          }, 1000);
        }
        setTimeout(() => setDiceState({ dice, rolling: false, total }), 1600);
        setMessages(prev => [...prev, {
          type: 'system',
          message: `🎲 ${playerName || playerId} rolled ${dice[0]} + ${dice[1]} = ${total}${total === 7 ? ` — DEV INCIDENT! ${devIncidentMessage || ''}` : ''}`,
        }]);
      });

      socket.on('dev_incident_triggered', ({ playersOverLimit }) => {
        // Update discard phase for affected players (handled via discard_required)
        setMessages(prev => [...prev, {
          type: 'system',
          message: '🚨 Dev Incident! Players with >7 cards must discard half.',
        }]);
      });

      socket.on('discard_required', ({ playerId, mustDiscard: n }) => {
        setMustDiscard(n);
        setDevIncidentPhase('discard');
        setMessages(prev => [...prev, {
          type: 'system',
          message: `⚠️ Player must discard ${n} cards.`,
        }]);
      });

      socket.on('trade_proposed', (trade) => {
        setPendingTrades(prev => [...prev, trade]);
        // If this trade is from someone else, alert the trade tab
        if (trade.fromPlayerId !== myPlayerIdRef.current) {
          setTradeAlertSeq(s => s + 1);
        }
      });

      socket.on('resource_stolen', ({ stolenResource, fromPlayerId, fromPlayerName, isVictim }) => {
        const RES_EMOJI_LOCAL = { therapist: '🧑‍⚕️', payerContracts: '📋', coeStaff: '👥', rcmStaff: '💰', clinOps: '⚙️' };
        const msg = isVictim
          ? `🚨 ${fromPlayerName} stole 1 resource from you!`
          : `🎉 You stole 1 ${RES_EMOJI_LOCAL[stolenResource] || ''} ${stolenResource || 'resource'} from ${fromPlayerName}!`;
        setMessages(prev => [...prev, { type: 'system', message: msg }]);
        setStealToast(msg);
        setTimeout(() => setStealToast(null), 3500);
      });

      socket.on('trade_resolved', ({ tradeId, accepted }) => {
        setPendingTrades(prev => prev.filter(t => t.tradeId !== tradeId));
        setMessages(prev => [...prev, {
          type: 'system',
          message: accepted ? '🤝 Trade accepted!' : '❌ Trade declined.',
        }]);
      });

      socket.on('chat_message', (msg) => {
        setMessages(prev => [...prev, msg]);
      });

      socket.on('game_over', ({ winnerId, winnerName }) => {
        setGameOver({ winnerId, winnerName });
      });

      socket.on('error', ({ message }) => {
        console.error('[Game Error]', message);
        setMessages(prev => [...prev, {
          type: 'system',
          message: `⚠️ ${message}`,
        }]);
      });

      return () => {
        socket.disconnect();
      };
    }, []);

    // ---- Lobby callbacks ----
    const handleLobbySetPlayerId = useCallback((id) => {
      setMyPlayerId(id);
    }, []);

    // Lobby wraps onGameStart and also sets myPlayerId
    const handleGameStart = useCallback((gs, pid) => {
      setGameState(gs);
      setMyPlayerId(pid);
      myPlayerIdRef.current = pid;
      setScreen('game');
    }, []);

    // Dev incident phase — derived from gameState.phase
    // move/steal only shown to the player whose turn it is
    useEffect(() => {
      if (!gameState) return;
      const p = gameState.phase;
      const isCurrentPlayer = gameState.currentPlayerId === myPlayerId;
      if (p === 'dev_incident_discard') setDevIncidentPhase('discard');
      else if (p === 'dev_incident_move') setDevIncidentPhase(isCurrentPlayer ? 'move' : null);
      else if (p === 'dev_incident_steal') setDevIncidentPhase(isCurrentPlayer ? 'steal' : null);
      else { setDevIncidentPhase(null); setMustDiscard(0); }
    }, [gameState?.phase, gameState?.currentPlayerId, myPlayerId]);

    // ---- New game ----
    function handleNewGame() {
      setGameOver(null);
      setGameState(null);
      setMyPlayerId(null);
      setMessages([]);
      setPendingTrades([]);
      setDiceState({ dice: null, rolling: false, total: null });
      setDevIncidentPhase(null);
      setMustDiscard(0);
      setScreen('lobby');
    }

    // ---- Render ----
    if (!socketReady && screen === 'lobby') {
      return (
        <div style={{
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(145deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
          flexDirection: 'column',
          gap: '16px',
        }}>
          <div style={{ fontSize: '2rem' }}>⚕️</div>
          <div style={{ color: '#F5A623', fontWeight: 700, fontSize: '1.2rem', letterSpacing: '2px' }}>
            THRIVEWORKS CATAN
          </div>
          <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: '13px' }}>
            Connecting to server…
          </div>
          <div style={{
            width: '40px', height: '40px',
            border: '3px solid rgba(245,166,35,0.2)',
            borderTop: '3px solid #F5A623',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
          }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      );
    }

    return (
      <div>
        {screen === 'lobby' && socketRef.current && (
          <window.Lobby
            socket={socketRef.current}
            onGameStart={handleGameStart}
          />
        )}

        {screen === 'game' && gameState && (
          <GameScreen
            gameState={gameState}
            myPlayerId={myPlayerId}
            messages={messages}
            pendingTrades={pendingTrades}
            diceState={diceState}
            devIncidentMessage={devIncidentMessage}
            devIncidentPhase={devIncidentPhase}
            mustDiscard={mustDiscard}
            resourceAnimations={resourceAnimations}
            stealToast={stealToast}
            socket={socketRef.current}
            onGameOver={() => {}}
          />
        )}

        {gameOver && (
          <GameOverOverlay
            winnerId={gameOver.winnerId}
            winnerName={gameOver.winnerName}
            players={players}
            onNewGame={handleNewGame}
          />
        )}
      </div>
    );
  }

  // ---- Mount ----
  const root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(<App />);
})();
