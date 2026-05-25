import { useState } from 'react';
import { MessageSquare, Search, RefreshCw, Plus, X, Send } from 'lucide-react';
import ConversationItem from './ConversationItem.jsx';
import { conversationsAPI } from '../utils/api.js';
import { useTheme } from '../theme.js';

export default function Sidebar({ conversations, selectedId, onSelect, loading, onRefresh }) {
  const { colors } = useTheme();
  const [search, setSearch]       = useState('');
  const [activeTab, setActiveTab] = useState('all'); // 'all' | 'ai' | 'human'
  const [showModal, setShowModal] = useState(false);
  const [phone, setPhone]         = useState('');
  const [name, setName]           = useState('');
  const [text, setText]           = useState('');
  const [sending, setSending]     = useState(false);
  const [error, setError]         = useState('');

  const aiCount    = conversations.filter(c => c.agent_mode === 'ai').length;
  const humanCount = conversations.filter(c => c.agent_mode === 'human').length;
  const humanUnread = conversations.filter(c => c.agent_mode === 'human' && c.unread_count > 0).length;

  const filtered = conversations.filter(c => {
    if (activeTab === 'ai'    && c.agent_mode !== 'ai')    return false;
    if (activeTab === 'human' && c.agent_mode !== 'human') return false;
    const q = search.toLowerCase();
    return (
      c.contact_name?.toLowerCase().includes(q) ||
      c.phone_number?.includes(q) ||
      c.last_message?.toLowerCase().includes(q)
    );
  });

  const openModal  = () => { setPhone(''); setName(''); setText(''); setError(''); setShowModal(true); };
  const closeModal = () => { if (!sending) setShowModal(false); };

  const handleSend = async () => {
    if (!phone.trim() || !text.trim()) { setError('Número y mensaje son requeridos'); return; }
    setSending(true); setError('');
    try {
      const result = await conversationsAPI.startConversation({ phone: phone.trim(), name: name.trim(), text: text.trim() });
      if (result.success) { setShowModal(false); onRefresh(); onSelect(result.data.conversationId); }
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally { setSending(false); }
  };

  const inp = {
    width: '100%', backgroundColor: colors.bgHover, border: `1px solid ${colors.borderStrong}`,
    borderRadius: '8px', padding: '10px 12px', color: colors.textPrimary,
    fontSize: '14px', outline: 'none', boxSizing: 'border-box',
  };

  return (
    <>
    {/* Modal nueva conversación */}
    {showModal && (
      <div style={{
        position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }} onClick={closeModal}>
        <div style={{
          backgroundColor: colors.bgPanel, borderRadius: '12px', padding: '24px',
          width: '360px', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          border: `1px solid ${colors.border}`,
        }} onClick={e => e.stopPropagation()}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
            <span style={{ fontWeight: 600, fontSize: '16px', color: colors.textPrimary }}>Nueva conversación</span>
            <button onClick={closeModal} style={{ background: 'none', border: 'none', color: colors.textSecondary, cursor: 'pointer', padding: '4px' }}>
              <X size={18} />
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div>
              <label style={{ fontSize: '12px', color: colors.textSecondary, marginBottom: '6px', display: 'block' }}>Número de teléfono *</label>
              <input type="tel" placeholder="56912345678" value={phone} onChange={e => setPhone(e.target.value)} style={inp} autoFocus />
              <span style={{ fontSize: '11px', color: colors.textSecondary, marginTop: '4px', display: 'block' }}>Con código de país, sin + (ej: 56912345678)</span>
            </div>
            <div>
              <label style={{ fontSize: '12px', color: colors.textSecondary, marginBottom: '6px', display: 'block' }}>Nombre (opcional)</label>
              <input type="text" placeholder="Juan Pérez" value={name} onChange={e => setName(e.target.value)} style={inp} />
            </div>
            <div>
              <label style={{ fontSize: '12px', color: colors.textSecondary, marginBottom: '6px', display: 'block' }}>Mensaje *</label>
              <textarea placeholder="Escribe el mensaje..." value={text} onChange={e => setText(e.target.value)} rows={3}
                style={{ ...inp, resize: 'vertical', fontFamily: 'inherit' }}
                onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) handleSend(); }} />
              <span style={{ fontSize: '11px', color: colors.textSecondary, marginTop: '4px', display: 'block' }}>Ctrl+Enter para enviar</span>
            </div>
            {error && (
              <div style={{ backgroundColor: colors.bgApp, border: `1px solid ${colors.red}66`, borderRadius: '8px', padding: '10px 12px', color: colors.red, fontSize: '13px' }}>
                {error}
              </div>
            )}
            <button onClick={handleSend} disabled={sending}
              style={{
                backgroundColor: sending ? colors.bgHover : colors.green, color: 'white',
                border: 'none', borderRadius: '8px', padding: '12px', fontSize: '14px', fontWeight: 600,
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
      backgroundColor: colors.bgSub, borderRight: `1px solid ${colors.border}`,
      display: 'flex', flexDirection: 'column', flexShrink: 0,
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px', backgroundColor: colors.bgPanel,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        minHeight: '52px', borderBottom: `1px solid ${colors.border}`,
      }}>
        <span style={{ fontWeight: 600, fontSize: '15px', color: colors.textPrimary }}>Conversaciones</span>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button onClick={openModal}
            style={{ background: 'none', color: colors.textSecondary, padding: '6px', borderRadius: '50%', display: 'flex', alignItems: 'center', border: 'none', cursor: 'pointer' }}
            onMouseEnter={e => { e.currentTarget.style.background = colors.bgHover; e.currentTarget.style.color = colors.textPrimary; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = colors.textSecondary; }}
            title="Nueva conversación"><Plus size={18} /></button>
          <button onClick={onRefresh}
            style={{ background: 'none', color: colors.textSecondary, padding: '6px', borderRadius: '50%', display: 'flex', alignItems: 'center', border: 'none', cursor: 'pointer' }}
            onMouseEnter={e => { e.currentTarget.style.background = colors.bgHover; e.currentTarget.style.color = colors.textPrimary; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = colors.textSecondary; }}
            title="Actualizar"><RefreshCw size={16} /></button>
        </div>
      </div>

      {/* Buscador */}
      <div style={{ padding: '8px 12px 4px', backgroundColor: colors.bgSub }}>
        <div style={{ backgroundColor: colors.bgPanel, borderRadius: '8px', display: 'flex', alignItems: 'center', padding: '8px 12px', gap: '8px', border: `1px solid ${colors.border}` }}>
          <Search size={16} color={colors.textSecondary} />
          <input type="text" placeholder="Buscar conversación..." value={search} onChange={e => setSearch(e.target.value)}
            style={{ background: 'none', border: 'none', color: colors.textPrimary, fontSize: '14px', flex: 1, outline: 'none' }} />
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', backgroundColor: colors.bgSub, padding: '4px 12px 6px', gap: '6px' }}>
        {[
          { key: 'all',   label: 'Todos',    count: conversations.length, color: colors.textSecondary },
          { key: 'ai',    label: '🤖 IA',    count: aiCount,              color: colors.green },
          { key: 'human', label: '👤 Humano', count: humanCount,          color: colors.yellow, urgent: humanUnread },
        ].map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            style={{
              flex: 1, padding: '5px 4px', borderRadius: '6px',
              border: activeTab === tab.key ? `1px solid ${tab.color}` : `1px solid ${colors.border}`,
              backgroundColor: activeTab === tab.key ? `${tab.color}22` : 'transparent',
              color: activeTab === tab.key ? tab.color : colors.textSecondary,
              fontSize: '12px', fontWeight: activeTab === tab.key ? 600 : 400,
              cursor: 'pointer', position: 'relative',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px',
              transition: 'all 0.15s',
            }}>
            <span>{tab.label}</span>
            <span style={{
              backgroundColor: activeTab === tab.key ? tab.color : colors.bgHover,
              color: activeTab === tab.key ? 'white' : colors.textSecondary,
              borderRadius: '10px', padding: '0 5px', fontSize: '10px', fontWeight: 700, minWidth: '16px', textAlign: 'center',
            }}>{tab.count}</span>
            {tab.key === 'human' && tab.urgent > 0 && (
              <span style={{
                position: 'absolute', top: '-3px', right: '-3px',
                width: '8px', height: '8px', borderRadius: '50%',
                backgroundColor: '#ef4444', border: `1px solid ${colors.bgSub}`,
                animation: 'pulse 1.5s infinite',
              }} />
            )}
          </button>
        ))}
      </div>

      {/* Lista */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '40px', color: colors.textSecondary, fontSize: '14px' }}>Cargando...</div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px', color: colors.textSecondary }}>
            <MessageSquare size={40} color={colors.textMuted} style={{ marginBottom: '12px' }} />
            <div style={{ fontSize: '14px' }}>{search ? 'Sin resultados' : 'Sin conversaciones aún'}</div>
          </div>
        ) : filtered.map(conv => (
          <ConversationItem key={conv.id} conversation={conv} selected={conv.id === selectedId} onClick={() => onSelect(conv.id)} />
        ))}
      </div>

      {/* Footer */}
      <div style={{
        padding: '8px 16px', backgroundColor: colors.bgPanel,
        borderTop: `1px solid ${colors.border}`, fontSize: '11px',
        color: colors.textSecondary, textAlign: 'center',
      }}>
        {conversations.length} conversaciones
      </div>
    </div>
    </>
  );
}
