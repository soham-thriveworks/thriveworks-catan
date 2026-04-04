// =============================================================
// Lobby.js — Create / Join / Waiting Room
// Exposed as window.Lobby
// =============================================================

window.Lobby = function Lobby({ socket, onGameStart }) {
  const { useState, useEffect } = React;

  const SESSION_KEY = 'tw_catan_session';

  function saveSession(data) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(data)); } catch (_) {}
  }

  const [tab, setTab] = React.useState('create'); // 'create' | 'join'
  const [playerName, setPlayerName] = React.useState('');
  const [color, setColor] = React.useState('green');
  const [roomCode, setRoomCode] = React.useState('');
  const [joinCode, setJoinCode] = React.useState('');
  const [phase, setPhase] = React.useState('form'); // 'form' | 'waiting' | 'rejoining'
  const [waitingPlayers, setWaitingPlayers] = React.useState([]);
  const [myPlayerId, setMyPlayerId] = React.useState(null);
  const [isHost, setIsHost] = React.useState(false);
  const [error, setError] = React.useState('');

  // Saved session for rejoin prompt
  const [savedSession, setSavedSession] = React.useState(() => {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (_) { return null; }
  });

  const PLAYER_COLORS = [
    { key: 'green',  hex: '#2E7D32', label: 'Green'  },
    { key: 'blue',   hex: '#1565C0', label: 'Blue'   },
    { key: 'orange', hex: '#E65100', label: 'Orange' },
    { key: 'purple', hex: '#6A1B9A', label: 'Purple' },
  ];

  const myPlayerIdRef = React.useRef(null);
  const rejoinPendingRef = React.useRef(false);

  useEffect(() => {
    if (!socket) return;

    const onRoomCreated = ({ roomCode: code, playerId }) => {
      myPlayerIdRef.current = playerId;
      setRoomCode(code);
      setMyPlayerId(playerId);
      setIsHost(true);
      setPhase('waiting');
      setWaitingPlayers([{ id: playerId, name: playerName, color, isHost: true }]);
      setError('');
      saveSession({ roomCode: code, playerId, playerName, color, gameStarted: false });
    };

    const onRoomJoined = ({ players, roomCode: code, playerId }) => {
      if (playerId) {
        myPlayerIdRef.current = playerId;
        setMyPlayerId(playerId);
        saveSession({ roomCode: code, playerId, playerName, color, gameStarted: false });
      }
      setRoomCode(code);
      setWaitingPlayers(players);
      setPhase('waiting');
      setError('');
    };

    const onGameStarted = ({ gameState }) => {
      // Mark game as started in session so rejoin knows to restore game screen
      try {
        const s = JSON.parse(localStorage.getItem(SESSION_KEY) || '{}');
        saveSession({ ...s, gameStarted: true });
      } catch (_) {}
      onGameStart(gameState, myPlayerIdRef.current);
    };

    const onError = ({ message }) => {
      if (rejoinPendingRef.current) {
        // Rejoin failed — clear the stale session so user isn't stuck in a loop
        rejoinPendingRef.current = false;
        try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
        setSavedSession(null);
      }
      setError(message);
      setPhase('form');
    };

    const onRejoinSuccess = ({ playerId, roomCode: code, gameState, players, gameStarted }) => {
      rejoinPendingRef.current = false;
      myPlayerIdRef.current = playerId;
      setMyPlayerId(playerId);
      setRoomCode(code);
      setSavedSession(null);
      if (gameStarted && gameState) {
        onGameStart(gameState, playerId);
      } else {
        setWaitingPlayers(players || []);
        setPhase('waiting');
      }
    };

    socket.on('room_created', onRoomCreated);
    socket.on('room_joined', onRoomJoined);
    socket.on('game_started', onGameStarted);
    socket.on('rejoin_success', onRejoinSuccess);
    socket.on('error', onError);

    return () => {
      socket.off('room_created', onRoomCreated);
      socket.off('room_joined', onRoomJoined);
      socket.off('game_started', onGameStarted);
      socket.off('rejoin_success', onRejoinSuccess);
      socket.off('error', onError);
    };
  }, [socket]);

  const handleCreate = () => {
    if (!playerName.trim()) { setError('Please enter your name.'); return; }
    setError('');
    socket.emit('create_room', { playerName: playerName.trim(), color });
  };

  const handleJoin = () => {
    if (!playerName.trim()) { setError('Please enter your name.'); return; }
    if (!joinCode.trim())   { setError('Please enter a room code.'); return; }
    setError('');
    socket.emit('join_room', { roomCode: joinCode.trim().toUpperCase(), playerName: playerName.trim(), color });
  };

  const handleStart = () => {
    socket.emit('start_game');
  };

  const handleRejoin = () => {
    if (!savedSession) return;
    rejoinPendingRef.current = true;
    setPhase('rejoining');
    setError('');
    socket.emit('rejoin_room', { roomCode: savedSession.roomCode, playerId: savedSession.playerId });
    // Fallback: if no response in 5s, clear session and go back to form
    setTimeout(() => {
      if (rejoinPendingRef.current) {
        rejoinPendingRef.current = false;
        try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
        setSavedSession(null);
        setError('Could not rejoin — the room may have ended.');
        setPhase('form');
      }
    }, 5000);
  };

  const handleDismissSession = () => {
    try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
    setSavedSession(null);
  };

  const canStart = waitingPlayers.length >= 2; // Allow 2–4

  // ---- Render: Waiting Room ----
  if (phase === 'waiting') {
    return (
      <div className="lobby-screen">
        <div className="lobby-logo-wrap">
          <img className="lobby-logo" src="/thriveworks-logo.png" alt="Thriveworks" onError={e => { e.target.style.display='none'; }} />
          <div className="lobby-title">Thriveworks Catan</div>
          <div className="lobby-subtitle">Build your practice. Grow your network.</div>
        </div>

        <div className="lobby-card">
          <div className="waiting-room">
            <div className="room-code-display">
              <div className="room-code-label">Room Code</div>
              <div className="room-code-value">{roomCode}</div>
            </div>

            <div className="waiting-title">
              Players ({waitingPlayers.length}/4)
            </div>

            <div className="waiting-players">
              {waitingPlayers.map((p) => (
                <div className="waiting-player" key={p.id || p.name}>
                  <div
                    className="waiting-player-dot"
                    style={{ backgroundColor: PLAYER_COLORS.find(c => c.key === p.color)?.hex || p.color || '#888' }}
                  />
                  <span className="waiting-player-name">
                    {p.name}{p.id === myPlayerId ? ' (You)' : ''}
                  </span>
                  {(p.isHost || p.id === waitingPlayers[0]?.id) && (
                    <span className="waiting-player-host">HOST</span>
                  )}
                </div>
              ))}
            </div>

            {isHost ? (
              <>
                <div className="waiting-hint">
                  {canStart
                    ? 'Ready! Click Start to begin.'
                    : `Waiting for ${2 - waitingPlayers.length} more player(s)…`}
                </div>
                <button
                  className="btn-primary"
                  onClick={handleStart}
                  disabled={!canStart}
                >
                  🚀 Start Game
                </button>
              </>
            ) : (
              <div className="waiting-hint">Waiting for the host to start the game…</div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ---- Render: Rejoining ----
  if (phase === 'rejoining') {
    return (
      <div className="lobby-screen">
        <div className="lobby-logo-wrap">
          <img className="lobby-logo" src="/thriveworks-logo.png" alt="Thriveworks" onError={e => { e.target.style.display='none'; }} />
          <div className="lobby-title">Thriveworks Catan</div>
        </div>
        <div className="lobby-card" style={{ textAlign: 'center', padding: '40px' }}>
          <div style={{ fontSize: '2rem', marginBottom: '12px' }}>🔄</div>
          <div style={{ color: '#fff', fontWeight: 600, fontSize: '16px', marginBottom: '8px' }}>Rejoining room {savedSession?.roomCode}…</div>
          <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: '13px' }}>Hang tight, reconnecting you to your game.</div>
        </div>
      </div>
    );
  }

  // ---- Render: Form ----
  return (
    <div className="lobby-screen">
      <div className="lobby-logo-wrap">
        <img className="lobby-logo" src="/thriveworks-logo.png" alt="Thriveworks" onError={e => { e.target.style.display='none'; }} />
        <div className="lobby-title">Thriveworks Catan</div>
        <div className="lobby-subtitle">Build your practice. Grow your network.</div>
      </div>

      <div className="lobby-card">
        {/* Rejoin banner */}
        {savedSession && (
          <div className="rejoin-banner">
            <div className="rejoin-banner-text">
              <span className="rejoin-banner-icon">🔌</span>
              <div>
                <div className="rejoin-banner-title">Resume previous game?</div>
                <div className="rejoin-banner-sub">Room <strong>{savedSession.roomCode}</strong> as <strong>{savedSession.playerName}</strong></div>
              </div>
            </div>
            <div className="rejoin-banner-actions">
              <button className="btn-rejoin" onClick={handleRejoin}>Rejoin</button>
              <button className="btn-rejoin-dismiss" onClick={handleDismissSession}>✕</button>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="lobby-tabs">
          <button
            className={`lobby-tab${tab === 'create' ? ' active' : ''}`}
            onClick={() => { setTab('create'); setError(''); }}
          >
            Create Game
          </button>
          <button
            className={`lobby-tab${tab === 'join' ? ' active' : ''}`}
            onClick={() => { setTab('join'); setError(''); }}
          >
            Join Game
          </button>
        </div>

        <div className="lobby-form">
          {/* Player Name */}
          <div>
            <label>Your Name</label>
            <input
              type="text"
              placeholder="e.g. Alex"
              value={playerName}
              onChange={e => setPlayerName(e.target.value)}
              maxLength={20}
              onKeyDown={e => e.key === 'Enter' && (tab === 'create' ? handleCreate() : handleJoin())}
            />
          </div>

          {/* Room code (join only) */}
          {tab === 'join' && (
            <div>
              <label>Room Code</label>
              <input
                type="text"
                placeholder="e.g. THRV-4X2K"
                value={joinCode}
                onChange={e => setJoinCode(e.target.value.toUpperCase())}
                maxLength={9}
                onKeyDown={e => e.key === 'Enter' && handleJoin()}
              />
            </div>
          )}

          {/* Color picker */}
          <div>
            <label>Pick Your Color</label>
            <div className="color-picker">
              {PLAYER_COLORS.map(c => (
                <div
                  key={c.key}
                  className={`color-swatch${color === c.key ? ' selected' : ''}`}
                  style={{ backgroundColor: c.hex }}
                  title={c.label}
                  onClick={() => setColor(c.key)}
                />
              ))}
            </div>
          </div>

          {/* Error */}
          {error && (
            <div style={{ color: '#ef9a9a', fontSize: '13px', background: 'rgba(229,57,53,0.1)', padding: '8px 12px', borderRadius: '8px', border: '1px solid rgba(229,57,53,0.3)' }}>
              ⚠️ {error}
            </div>
          )}

          {/* CTA */}
          {tab === 'create' ? (
            <button className="btn-primary" onClick={handleCreate}>
              ✨ Create Room
            </button>
          ) : (
            <button className="btn-primary" onClick={handleJoin}>
              🚪 Join Room
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
