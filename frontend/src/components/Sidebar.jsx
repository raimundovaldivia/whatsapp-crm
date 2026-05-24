import { useState } from 'react';
import { MessageSquare, Search, RefreshCw, Plus, X, Send } from 'lucide-react';
import ConversationItem from './ConversationItem.jsx';
import { conversationsAPI } from '../utils/api.js';

export default function Sidebar({ conversations, selectedId, onSelect, loading, onRefresh }) {
  const [search, setSearch]       = useState('');
  const [activeTab, setActiveTab] = useState('all'); // 'all' | 'ai' | 'human'
  const [showModal, setShowModal] = useState(false);
  const [phone, setPhone]         = useState('');
  const [name, setName]           = useState('');
  const [text, setText]           = useState('');
  const [sending, setSending]     = useState(false);
  const [error, setError]         = useState('');

  // Conteos por tab
  const aiCount    = conversations.filter(c => c.agent_mode === 'ai').length;
  const humanCount = conversations.filter(c => c.agent_mode === 'human').length;
  const humanUnread = conversations.filter(c => c.agent_mode === 'human' && c.unread_count > 0).length;

  const filtered = conversations.filter(c => {
    // Filtro por tab
    if (activeTab === 'ai'    && c.agent_mode !== 'ai')    return false;
    if (activeTab === 'human' && c.agent_mode !== 'human') return false;
    // Filtro por búsqueda
    const q = search.toLowerCase();
    return (
      c.contact_name?.toLowerCase().includes(q) ||
      c.phone_number?.includes(q) ||
      c.last_message?.toLowerCase().includes(q)
    );
  });

  const openModal = () => { setPhone(''); setName(''); setText(''); setError(''); setShowModal(true); };
  const closeModal = () => { if (!sending) setShowModal(false); };

  const handleSend = async () => {
    if (!phone.trim() || !text.trim()) { setError('Número y mensaje son requeridos'); return; }
    setSending(true);
    setError('');
    try {
      const result = await conversationsAPI.startConversation({ phone: phone.trim(), name: name.trim(), text: text.trim() });
      if (result.success) {
        setShowModal(false);
        onRefresh();
        onSelect(result.data.conversationId);
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSending(false);
    }
  };

  const inputStyle = {
    width: '100%', backgroundColor: '#2a3942', border: '1px solid #374045',
    borderRadius: '8px', padding: '10px 12px', color: '#e9edef',
    fontSize: '14px', outline: 'none', boxSizing: 'border-box',
  };

  return (
    <>
    {/* Modal nueva conversación */}
    {showModal && (
      <div style={{
        position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000,
      }} onClick={closeModal}>
        <div style={{
          backgroundColor: '#1e2a30', borderRadius: '12px', padding: '24px',
          width: '360px', boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }} onClick={e => e.stopPropagation()}>

          {/* Título */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
            <span style={{ fontWeight: 600, fontSize: '16px', color: '#e9edef' }}>Nueva conversación</span>
            <button onClick={closeModal} style={{ background: 'none', border: 'none', color: '#8696a0', cursor: 'pointer', padding: '4px' }}>
              <X size={18} />
            </button>
          </div>

          {/* Campos */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div>
              <label style={{ fontSize: '12px', color: '#8696a0', marginBottom: '6px', display: 'block' }}>
                Número de teléfono *
              </label>
              <input
                type="tel"
                placeholder="56912345678"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                style={inputStyle}
                autoFocus
              />
              <span style={{ fontSize: '11px', color: '#8696a0', marginTop: '4px', display: 'block' }}>
                Con código de país, sin + (ej: 56912345678)
              </span>
            </div>

            <div>
              <label style={{ fontSize: '12px', color: '#8696a0', marginBottom: '6px', display: 'block' }}>
                Nombre (opcional)
              </label>
              <input
                type="text"
                placeholder="Juan Pérez"
                value={name}
                onChange={e => setName(e.target.value)}
                style={inputStyle}
              />
            </div>

            <div>
              <label style={{ fontSize: '12px', color: '#8696a0', marginBottom: '6px', display: 'block' }}>
                Mensaje *
              </label>
              <textarea
                placeholder="Escribe el mensaje..."
                value={text}
                onChange={e => setText(e.target.value)}
                rows={3}
                style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
                onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) handleSend(); }}
              />
              <span style={{ fontSize: '11px', color: '#8696a0', marginTop: '4px', display: 'block' }}>
                Ctrl+Enter para enviar
              </span>
            </div>

            {error && (
              <div style={{ backgroundColor: '#3d1a1a', border: '1px solid #6b2c2c', borderRadius: '8px', padding: '10px 12px', color: '#ff8a80', fontSize: '13px' }}>
                {error}
              </div>
            )}

            <button
              onClick={handleSend}
              disabled={sending}
              style={{
                backgroundColor: sending ? '#374045' : '#00a884',
                color: '#fff', border: 'none', borderRadius: '8px',
                padding: '12px', fontSize: '14px', fontWeight: 600,
                cursor: sending ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
              }}>
              <Send size={16} />
              {sending ? 'Enviando...' : 'Enviar mensaje'}
            </button>
          </div>
        </div>
      </div>
    )}

    <div style={{
      width: '320px', minWidth: '260px', height: '100vh',
      backgroundColor: '#111b21', borderRight: '1px solid #2a3942',
      display: 'flex', flexDirection: 'column', flexShrink: 0,
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px', backgroundColor: '#202c33',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        minHeight: '52px', borderBottom: '1px solid #2a3942',
      }}>
        <span style={{ fontWeight: 600, fontSize: '15px', color: '#e9edef' }}>
          Conversaciones
        </span>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button onClick={openModal}
            style={{ background: 'none', color: '#8696a0', padding: '6px', borderRadius: '50%', display: 'flex', alignItems: 'center', border: 'none', cursor: 'pointer' }}
            onMouseEnter={e => e.currentTarget.style.background = '#374045'}
            onMouseLeave={e => e.currentTarget.style.background = 'none'}
            title="Nueva conversación">
            <Plus size={18} />
          </button>
          <button onClick={onRefresh}
            style={{ background: 'none', color: '#8696a0', padding: '6px', borderRadius: '50%', display: 'flex', alignItems: 'center', border: 'none', cursor: 'pointer' }}
            onMouseEnter={e => e.currentTarget.style.background = '#374045'}
            onMouseLeave={e => e.currentTarget.style.background = 'none'}
            title="Actualizar">
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      {/* Buscador */}
      <div style={{ padding: '8px 12px 4px', backgroundColor: '#111b21' }}>
        <div style={{ backgroundColor: '#202c33', borderRadius: '8px', display: 'flex', alignItems: 'center', padding: '8px 12px', gap: '8px' }}>
          <Search size={16} color="#8696a0" />
          <input
            type="text"
            placeholder="Buscar conversación..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ background: 'none', border: 'none', color: '#e9edef', fontSize: '14px', flex: 1, outline: 'none' }}
          />
        </div>
      </div>

      {/* Tabs — Todos / IA / Humano */}
      <div style={{ display: 'flex', backgroundColor: '#111b21', padding: '4px 12px 6px', gap: '6px' }}>
        {[
          { key: 'all',   label: 'Todos',   count: conversations.length, color: '#8696a0' },
          { key: 'ai',    label: '🤖 IA',    count: aiCount,              color: '#00a884' },
          { key: 'human', label: '👤 Humano', count: humanCount,           color: '#f0b429', urgent: humanUnread },
        ].map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              flex: 1,
              padding: '5px 4px',
              borderRadius: '6px',
              border: activeTab === tab.key ? `1px solid ${tab.color}` : '1px solid #2a3942',
              backgroundColor: activeTab === tab.key ? `${tab.color}22` : 'transparent',
              color: activeTab === tab.key ? tab.color : '#8696a0',
              fontSize: '12px',
              fontWeight: activeTab === tab.key ? 600 : 400,
              cursor: 'pointer',
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '4px',
              transition: 'all 0.15s',
            }}
          >
            <span>{tab.label}</span>
            <span style={{
              backgroundColor: activeTab === tab.key ? tab.color : '#2a3942',
              color: activeTab === tab.key ? '#111b21' : '#8696a0',
              borderRadius: '10px',
              padding: '0 5px',
              fontSize: '10px',
              fontWeight: 700,
              minWidth: '16px',
              textAlign: 'center',
            }}>
              {tab.count}
            </span>
            {/* Pulso rojo si hay conversaciones humanas con mensajes sin leer */}
            {tab.key === 'human' && tab.urgent > 0 && (
              <span style={{
                position: 'absolute',
                top: '-3px',
                right: '-3px',
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                backgroundColor: '#ef4444',
                border: '1px solid #111b21',
                animation: 'pulse 1.5s infinite',
              }} />
            )}
          </button>
        ))}
      </div>

      {/* Lista */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '40px', color: '#8696a0', fontSize: '14px' }}>Cargando...</div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px', color: '#8696a0' }}>
            <MessageSquare size={40} style={{ marginBottom: '12px', opacity: 0.4 }} />
            <div style={{ fontSize: '14px' }}>{search ? 'Sin resultados' : 'Sin conversaciones aún'}</div>
          </div>
        ) : filtered.map(conv => (
          <ConversationItem
            key={conv.id}
            conversation={conv}
            selected={conv.id === selectedId}
            onClick={() => onSelect(conv.id)}
          />
        ))}
      </div>

      {/* Footer */}
      <div style={{
        padding: '8px 16px', backgroundColor: '#202c33',
        borderTop: '1px solid #2a3942', fontSize: '11px',
        color: '#8696a0', textAlign: 'center',
      }}>
        {conversations.length} conversaciones
      </div>
    </div>
    </>
  );
}
