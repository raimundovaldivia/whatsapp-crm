import { useState } from 'react';
import { MessageSquare, Search, RefreshCw } from 'lucide-react';
import ConversationItem from './ConversationItem.jsx';

export default function Sidebar({ conversations, selectedId, onSelect, loading, onRefresh }) {
  const [search, setSearch] = useState('');

  const filtered = conversations.filter(c => {
    const q = search.toLowerCase();
    return (
      c.contact_name?.toLowerCase().includes(q) ||
      c.phone_number?.includes(q) ||
      c.last_message?.toLowerCase().includes(q)
    );
  });

  return (
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
        <button onClick={onRefresh}
          style={{ background: 'none', color: '#8696a0', padding: '6px', borderRadius: '50%', display: 'flex', alignItems: 'center' }}
          onMouseEnter={e => e.currentTarget.style.background = '#374045'}
          onMouseLeave={e => e.currentTarget.style.background = 'none'}
          title="Actualizar">
          <RefreshCw size={16} />
        </button>
      </div>

      {/* Buscador */}
      <div style={{ padding: '8px 12px', backgroundColor: '#111b21' }}>
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
  );
}
