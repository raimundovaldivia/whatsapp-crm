import { useState, useEffect, useCallback } from 'react';
import { Users, UserCheck, UserX, Search, RefreshCw, MessageSquare } from 'lucide-react';
import { api } from '../utils/api.js';
import { useTheme } from '../theme.js';
import { formatDateTime } from '../utils/dates.js';

const TYPE_COLORS = {
  lead:     { label: 'Lead',    color: '#fb923c', bg: '#2e1500', border: '#fb923c44' },
  customer: { label: 'Cliente', color: '#4ade80', bg: '#0a2015', border: '#4ade8044' },
};

export default function ContactsPanel({ onSelectConversation }) {
  const { colors } = useTheme();
  const [contacts,   setContacts]   = useState([]);
  const [stats,      setStats]      = useState({ total: 0, leads: 0, customers: 0 });
  const [loading,    setLoading]    = useState(true);
  const [typeFilter, setTypeFilter] = useState('all');   // all | lead | customer
  const [search,     setSearch]     = useState('');
  const [page,       setPage]       = useState(1);
  const [total,      setTotal]      = useState(0);
  const [toast,      setToast]      = useState(null);
  const PAGE_SIZE = 100;

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, ...(typeFilter !== 'all' && { type: typeFilter }), ...(search && { search }) };
      const [contactsRes, statsRes] = await Promise.all([
        api.get('/contacts', { params }),
        api.get('/contacts/stats'),
      ]);
      setContacts(contactsRes.data.data || []);
      setTotal(contactsRes.data.total || 0);
      setStats(statsRes.data.data || { total: 0, leads: 0, customers: 0 });
    } catch {
      showToast('Error cargando contactos', 'error');
    } finally {
      setLoading(false);
    }
  }, [typeFilter, search, page]);

  useEffect(() => { load(); }, [load]);

  const setTypeFilterR = v => { setTypeFilter(v); setPage(1); };

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const conversionRate = stats.total > 0 ? Math.round((stats.customers / stats.total) * 100) : 0;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100vh', backgroundColor: colors.bgApp, overflow: 'hidden' }}>

      {/* Header */}
      <div style={{ padding: '14px 24px', backgroundColor: colors.bgPanel, borderBottom: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', gap: '12px' }}>
        <Users size={20} color={colors.green} />
        <h1 style={{ color: colors.textPrimary, fontSize: '17px', fontWeight: 600, flex: 1 }}>Contactos</h1>
        <button onClick={load} style={{ background: 'none', color: colors.textSecondary, padding: '6px', borderRadius: '50%', display: 'flex', border: 'none', cursor: 'pointer' }}>
          <RefreshCw size={15} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>

        {/* Stats */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
          {[
            { icon: <Users size={18} color={colors.textSecondary} />,   label: 'Total',      value: stats.total,      color: colors.textPrimary },
            { icon: <UserX size={18} color='#fb923c' />,                label: 'Leads',      value: stats.leads,      color: '#fb923c' },
            { icon: <UserCheck size={18} color='#4ade80' />,            label: 'Clientes',   value: stats.customers,  color: '#4ade80' },
            { icon: <MessageSquare size={18} color={colors.green} />,   label: 'Conversión', value: `${conversionRate}%`, color: colors.green },
          ].map(({ icon, label, value, color }) => (
            <div key={label} style={{ backgroundColor: colors.bgPanel, borderRadius: '12px', padding: '14px 16px', border: `1px solid ${colors.border}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>{icon}<span style={{ fontSize: '11px', color: colors.textSecondary }}>{label}</span></div>
              <div style={{ fontSize: '20px', fontWeight: 700, color }}>{value}</div>
            </div>
          ))}
        </div>

        {/* Filtros + búsqueda */}
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          {[
            { key: 'all',      label: 'Todos' },
            { key: 'lead',     label: '🟠 Leads' },
            { key: 'customer', label: '🟢 Clientes' },
          ].map(({ key, label }) => (
            <button key={key} onClick={() => setTypeFilterR(key)}
              style={{ padding: '5px 14px', borderRadius: '20px', fontSize: '12px', fontWeight: 500,
                border: `1px solid ${typeFilter === key ? colors.green : colors.border}`,
                backgroundColor: typeFilter === key ? colors.green : colors.bgPanel,
                color: typeFilter === key ? 'white' : colors.textSecondary, cursor: 'pointer' }}>
              {label}
            </button>
          ))}

          <div style={{ flex: 1, minWidth: 200, display: 'flex', alignItems: 'center', gap: '8px', backgroundColor: colors.bgPanel, border: `1px solid ${colors.border}`, borderRadius: '10px', padding: '6px 12px' }}>
            <Search size={14} color={colors.textSecondary} />
            <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}
              placeholder="Buscar nombre o teléfono..."
              style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: colors.textPrimary, fontSize: '13px' }} />
          </div>
        </div>

        {/* Lista */}
        {loading ? (
          <div style={{ textAlign: 'center', padding: '60px', color: colors.textSecondary, opacity: 0.5 }}>
            <Users size={40} style={{ marginBottom: 12, opacity: 0.3 }} />
            <div>Cargando contactos...</div>
          </div>
        ) : contacts.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px', color: colors.textSecondary, opacity: 0.5 }}>
            <Users size={40} style={{ marginBottom: 12, opacity: 0.3 }} />
            <div>Sin contactos en este filtro</div>
          </div>
        ) : (
          <>
            {/* Encabezado tabla */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 130px 120px 120px 90px', gap: '12px', padding: '0 16px', fontSize: '11px', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              <span>Contacto</span>
              <span>Teléfono</span>
              <span>Último mensaje</span>
              <span>Pedidos</span>
              <span>Tipo</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {contacts.map(c => <ContactRow key={c.id} contact={c} colors={colors} onGoToConversation={onSelectConversation} />)}
            </div>

            {/* Paginación */}
            {totalPages > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', padding: '16px 0' }}>
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                  style={{ padding: '6px 16px', borderRadius: '8px', border: `1px solid ${colors.border}`, backgroundColor: colors.bgPanel, color: page === 1 ? colors.textSecondary : colors.textPrimary, cursor: page === 1 ? 'not-allowed' : 'pointer', fontSize: '13px' }}>
                  ← Anterior
                </button>
                <span style={{ fontSize: '13px', color: colors.textSecondary }}>
                  Página <strong style={{ color: colors.textPrimary }}>{page}</strong> de {totalPages}
                  <span style={{ marginLeft: '8px', opacity: 0.6 }}>({total} total)</span>
                </span>
                <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                  style={{ padding: '6px 16px', borderRadius: '8px', border: `1px solid ${colors.border}`, backgroundColor: colors.bgPanel, color: page === totalPages ? colors.textSecondary : colors.textPrimary, cursor: page === totalPages ? 'not-allowed' : 'pointer', fontSize: '13px' }}>
                  Siguiente →
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {toast && (
        <div style={{ position: 'fixed', bottom: '24px', right: '24px', zIndex: 1000,
          backgroundColor: toast.type === 'error' ? '#2d1a1a' : '#0a2015',
          color: toast.type === 'error' ? '#f87171' : '#4ade80',
          padding: '12px 20px', borderRadius: '10px', fontSize: '13px', fontWeight: 500,
          border: `1px solid ${toast.type === 'error' ? '#f8717133' : '#4ade8033'}` }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function ContactRow({ contact, colors, onGoToConversation }) {
  const typeStyle = TYPE_COLORS[contact.contact_type] || TYPE_COLORS.lead;
  const displayName = contact.name && contact.name !== 'Cliente' ? contact.name : null;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 130px 120px 120px 90px', gap: '12px', padding: '10px 16px',
      backgroundColor: colors.bgPanel, borderRadius: '10px', border: `1px solid ${colors.border}`,
      alignItems: 'center', cursor: onGoToConversation ? 'pointer' : 'default' }}
      onMouseEnter={e => e.currentTarget.style.borderColor = colors.borderStrong}
      onMouseLeave={e => e.currentTarget.style.borderColor = colors.border}>

      {/* Nombre */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
        <div style={{ width: 32, height: 32, borderRadius: '50%', backgroundColor: typeStyle.bg,
          border: `1px solid ${typeStyle.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: typeStyle.color, fontSize: '13px', fontWeight: 700, flexShrink: 0 }}>
          {(displayName || contact.phone || '?')[0].toUpperCase()}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: colors.textPrimary, fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {displayName || contact.phone}
          </div>
          {displayName && <div style={{ color: colors.textSecondary, fontSize: '11px' }}>{contact.city || contact.email || ''}</div>}
        </div>
      </div>

      {/* Teléfono */}
      <div style={{ color: colors.textSecondary, fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {contact.phone}
      </div>

      {/* Último mensaje */}
      <div style={{ color: colors.textSecondary, fontSize: '12px' }}>
        {contact.last_seen_at ? formatDateTime(contact.last_seen_at) : '—'}
      </div>

      {/* Pedidos */}
      <div style={{ color: contact.total_orders > 0 ? '#4ade80' : colors.textSecondary, fontSize: '13px', fontWeight: contact.total_orders > 0 ? 600 : 400 }}>
        {contact.total_orders > 0 ? `${contact.total_orders} pedido${contact.total_orders !== 1 ? 's' : ''}` : '—'}
      </div>

      {/* Tipo */}
      <div style={{ backgroundColor: typeStyle.bg, color: typeStyle.color, borderRadius: '20px', padding: '3px 10px',
        fontSize: '11px', fontWeight: 600, border: `1px solid ${typeStyle.border}`, textAlign: 'center' }}>
        {typeStyle.label}
      </div>
    </div>
  );
}
