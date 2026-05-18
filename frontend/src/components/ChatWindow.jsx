import { useState, useRef, useEffect } from 'react';
import { Bot, User, Send, Phone, MoreVertical, Pause, Play } from 'lucide-react';
import MessageBubble from './MessageBubble.jsx';
import AgentToggle from './AgentToggle.jsx';

export default function ChatWindow({ conversation, messages, onSendMessage, onToggleAgentMode }) {
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  const isHumanMode = conversation.agent_mode === 'human';

  // Auto scroll al último mensaje
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || sending) return;

    setInputText('');
    setSending(true);
    setError(null);

    try {
      await onSendMessage(conversation.id, text);
    } catch (err) {
      setError('Error enviando el mensaje. Intenta de nuevo.');
      setInputText(text); // Restaurar texto
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const initials = (conversation.contact_name || conversation.phone_number || '?')
    .split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      backgroundColor: '#0b141a',
      backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='60' height='60'%3E%3Cpath d='M30 5l5 10h10l-8 7 3 10-10-6-10 6 3-10-8-7h10z' fill='%23ffffff05'/%3E%3C/svg%3E")`,
    }}>
      {/* Header del chat */}
      <div style={{
        padding: '10px 16px',
        backgroundColor: '#202c33',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: '1px solid #2a3942',
        minHeight: '60px',
        zIndex: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {/* Avatar */}
          <div style={{
            width: '40px', height: '40px', borderRadius: '50%',
            backgroundColor: '#4db6ac',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 600, color: 'white', fontSize: '14px',
          }}>
            {initials}
          </div>

          <div>
            <div style={{ fontWeight: 600, fontSize: '15px', color: '#e9edef' }}>
              {conversation.contact_name || conversation.phone_number}
            </div>
            <div style={{ fontSize: '12px', color: '#8696a0' }}>
              {conversation.phone_number}
              {conversation.contact_name !== conversation.phone_number && ' · ' + conversation.phone_number}
            </div>
          </div>
        </div>

        {/* Toggle IA/Humano */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <AgentToggle
            mode={conversation.agent_mode}
            onToggle={() => onToggleAgentMode(conversation.id, conversation.agent_mode)}
          />
        </div>
      </div>

      {/* Banner cuando el modo es humano */}
      {isHumanMode && (
        <div style={{
          backgroundColor: '#f0b429',
          color: '#000',
          padding: '8px 16px',
          fontSize: '13px',
          fontWeight: 500,
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}>
          <User size={14} />
          <span>Modo manual activo — el agente IA está pausado. Tú estás respondiendo.</span>
          <button
            onClick={() => onToggleAgentMode(conversation.id, conversation.agent_mode)}
            style={{
              marginLeft: 'auto',
              backgroundColor: 'rgba(0,0,0,0.15)',
              color: '#000',
              padding: '3px 10px',
              borderRadius: '12px',
              fontSize: '12px',
              fontWeight: 600,
              display: 'flex', alignItems: 'center', gap: '4px',
            }}
          >
            <Play size={11} /> Reactivar IA
          </button>
        </div>
      )}

      {/* Área de mensajes */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
      }}>
        {messages.length === 0 ? (
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#8696a0', fontSize: '14px',
          }}>
            Sin mensajes aún
          </div>
        ) : (
          messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Error */}
      {error && (
        <div style={{
          padding: '8px 16px',
          backgroundColor: '#3b1f1f',
          color: '#e57373',
          fontSize: '13px',
          textAlign: 'center',
        }}>
          {error}
        </div>
      )}

      {/* Input de mensaje */}
      <div style={{
        padding: '10px 16px',
        backgroundColor: '#202c33',
        display: 'flex',
        alignItems: 'flex-end',
        gap: '10px',
        borderTop: '1px solid #2a3942',
      }}>
        <textarea
          ref={inputRef}
          value={inputText}
          onChange={e => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isHumanMode ? 'Escribe un mensaje...' : 'Escribe para responder manualmente...'}
          rows={1}
          style={{
            flex: 1,
            backgroundColor: '#2a3942',
            border: 'none',
            borderRadius: '8px',
            padding: '10px 14px',
            color: '#e9edef',
            fontSize: '14px',
            resize: 'none',
            maxHeight: '120px',
            lineHeight: '1.5',
            fontFamily: 'inherit',
          }}
          onInput={e => {
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
          }}
        />

        <button
          onClick={handleSend}
          disabled={!inputText.trim() || sending}
          style={{
            backgroundColor: inputText.trim() ? '#00a884' : '#374045',
            color: 'white',
            width: '42px',
            height: '42px',
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'background 0.2s',
            flexShrink: 0,
          }}
        >
          <Send size={18} />
        </button>
      </div>
    </div>
  );
}
