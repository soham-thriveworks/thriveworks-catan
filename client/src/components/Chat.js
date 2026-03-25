// =============================================================
// Chat.js — In-game chat panel
// Exposed as window.Chat
// =============================================================

window.Chat = function Chat({ messages, myPlayerId, players, socket }) {
  const { useState, useEffect, useRef } = React;

  const [input, setInput] = useState('');
  const messagesEndRef = useRef(null);

  // Auto-scroll to bottom when new message arrives
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  const COLOR_MAP = {
    green:  '#2E7D32',
    blue:   '#1565C0',
    orange: '#E65100',
    purple: '#6A1B9A',
  };

  function getPlayerColor(playerId) {
    if (!players) return '#888';
    const p = players.find(pl => pl.id === playerId);
    return p ? (COLOR_MAP[p.color] || p.color || '#888') : '#888';
  }

  function getPlayerName(playerId) {
    if (!players) return playerId;
    const p = players.find(pl => pl.id === playerId);
    return p ? p.name : playerId;
  }

  function handleSend() {
    const text = input.trim();
    if (!text) return;
    socket.emit('send_chat', { message: text });
    setInput('');
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="chat-section">
      <div className="chat-header">💬 Chat</div>

      <div className="chat-messages">
        {(!messages || messages.length === 0) && (
          <div className="chat-system-msg">No messages yet. Say hello! 👋</div>
        )}

        {(messages || []).map((msg, idx) => {
          if (msg.type === 'system' || !msg.playerId) {
            return (
              <div className="chat-system-msg" key={idx}>
                {msg.message || msg.text}
              </div>
            );
          }

          const isMe = msg.playerId === myPlayerId;
          const color = getPlayerColor(msg.playerId);
          const name = msg.playerName || getPlayerName(msg.playerId);

          return (
            <div
              className="chat-message"
              key={idx}
              style={{ textAlign: isMe ? 'right' : 'left' }}
            >
              <span
                className="chat-message-name"
                style={{ color, marginRight: '4px' }}
              >
                {name}:
              </span>
              <span className="chat-message-text">{msg.message || msg.text}</span>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-row">
        <input
          className="chat-input"
          type="text"
          placeholder="Send a message…"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          maxLength={200}
        />
        <button className="btn-chat-send" onClick={handleSend} disabled={!input.trim()}>
          ➤
        </button>
      </div>
    </div>
  );
};
