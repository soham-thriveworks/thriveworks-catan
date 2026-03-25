// =============================================================
// Lobby.js — Create / Join / Waiting Room
// Exposed as window.Lobby
// =============================================================

window.Lobby = function Lobby({ socket, onGameStart }) {
  const { useState, useEffect } = React;

  const [tab, setTab] = React.useState('create'); // 'create' | 'join'
  const [playerName, setPlayerName] = React.useState('');
  const [color, setColor] = React.useState('green');
  const [roomCode, setRoomCode] = React.useState('');
  const [joinCode, setJoinCode] = React.useState('');
  const [phase, setPhase] = React.useState('form'); // 'form' | 'waiting'
  const [waitingPlayers, setWaitingPlayers] = React.useState([]);
  const [myPlayerId, setMyPlayerId] = React.useState(null);
  const [isHost, setIsHost] = React.useState(false);
  const [error, setError] = React.useState('');

  const PLAYER_COLORS = [
    { key: 'green',  hex: '#2E7D32', label: 'Green'  },
    { key: 'blue',   hex: '#1565C0', label: 'Blue'   },
    { key: 'orange', hex: '#E65100', label: 'Orange' },
    { key: 'purple', hex: '#6A1B9A', label: 'Purple' },
  ];

  const myPlayerIdRef = React.useRef(null);

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
    };

    const onRoomJoined = ({ players, roomCode: code, playerId }) => {
      // Only update our own playerId — other players' join events arrive without a playerId
      if (playerId) {
        myPlayerIdRef.current = playerId;
        setMyPlayerId(playerId);
      }
      setRoomCode(code);
      setWaitingPlayers(players);
      setPhase('waiting');
      setError('');
    };

    const onGameStarted = ({ gameState }) => {
      onGameStart(gameState, myPlayerIdRef.current);
    };

    const onError = ({ message }) => setError(message);

    socket.on('room_created', onRoomCreated);
    socket.on('room_joined', onRoomJoined);
    socket.on('game_started', onGameStarted);
    socket.on('error', onError);

    return () => {
      socket.off('room_created', onRoomCreated);
      socket.off('room_joined', onRoomJoined);
      socket.off('game_started', onGameStarted);
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

  const canStart = waitingPlayers.length >= 2; // Allow 2–4

  // ---- Render: Waiting Room ----
  if (phase === 'waiting') {
    return (
      <div className="lobby-screen">
        <div className="lobby-logo-wrap">
          <img className="lobby-logo" src="/thriveworks-logo.png" alt="Thriveworks" onError={e => { e.target.style.display='none'; }} />
          <div className="lobby-title">Thriveworks Catan</div>
          <div className="lobby-subtitle">Internal Hackathon Edition</div>
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

  // ---- Render: Form ----
  return (
    <div className="lobby-screen">
      <div className="lobby-logo-wrap">
        <img className="lobby-logo" src="/thriveworks-logo.png" alt="Thriveworks" onError={e => { e.target.style.display='none'; }} />
        <div className="lobby-title">Thriveworks Catan</div>
        <div className="lobby-subtitle">Build your practice. Grow your network.</div>
      </div>

      <div className="lobby-card">
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
