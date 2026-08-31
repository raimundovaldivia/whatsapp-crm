import { useState, useEffect, useRef } from 'react';
import { MessageSquare, Search, RefreshCw, Plus, X, Send, Flame, Loader, Stethoscope, GitMerge } from 'lucide-react';
import ConversationItem from './ConversationItem.jsx';
import { conversationsAPI, api } from '../utils/api.js';
import { useTheme } from '../theme.js';

export default function Sidebar({ conversations, selectedId, onSelect, loading, onRefresh, isMobile }) {
  const { colors } = useTheme();
  const [search, setSearch]           = useState('');
  const [msgResults, setMsgResults]   = useState([]); // resultados de búsqueda en mensajes
  const [msgLoading, setMsgLoading]   = useState(false);
  const msgTimerRef                   = useRef(null);
  const [activeTab, setActiveTab]     = useState('all');
  const [showModal, setShowModal] = useState(false);
  const [phone, setPhone]         = useState('');
  const [name, setName]           = useState('');
  const [text, setText]           = useState('');
  const [sending, setSending]     = useState(false);
  const [error, setError]         = useState('');
  const [scanning, setScanning]   = useState(false);

  // Diagnóstico de número
  const [showDiagModal, setShowDiagModal]   = useState(false);
  const [diagPhone, setDiagPhone]           = useState('');
  const [diagResults, setDiagResults]       = useState(null);
  const [diagLoading, setDiagLoading]       = useState(false);
  const [diagError, setDiagError]           = useState('');
  const [mergingId, setMergingId]           = useState(null);
  const [mergingAll, setMergingAll]         = useState(false);
  const [mergeAllResult, setMergeAllResult] = useState(null);

  // Búsqueda de mensajes con debounce
  useEffect(() => {
    clearTimeout(msgTimerRef.current);
    if (search.trim().length < 2) { setMsgResults([]); setMsgLoading(false); return; }
    setMsgLoading(true);
    msgTimerRef.current = setTimeout(async () => {
      try {
        const res = await api.get(`/conversations/search-messages?q=${encodeURIComponent(search.trim())}`);
        setMsgResults(res.data.data || []);
      } catch { setMsgResults([]); }
      finally { setMsgLoading(false); }
    }, 450);
    return () => clearTimeout(msgTimerRef.current);
  }, [search]);

  const HOT_STATES   = ['interested', 'collecting_order'];
  const now          = Date.now();
  const h24          = 24 * 60 * 60 * 1000;
  const isStalled    = c => {
    const last = new Date(c.last_message_at).getTime();
    return c.pipeline_state !== 'done' && (now - last) > h24;
  };

  const aiCount    = conversations.filter(c => c.agent_mode === 'ai').length;
  const humanCount = conversations.filter(c => c.agent_mode === 'human').length;
  const humanUnread = conversations.filter(c => c.agent_mode === 'human' && c.unread_count > 0).length;
  const unreadCount = conversations.filter(c => c.unread_count > 0).length;
  const hotCount    = conversations.filter(c => HOT_STATES.includes(c.pipeline_state) && !c.hot_lead_excluded).length;
  const stalledCount = conversations.filter(isStalled).length;

  const filtered = conversations.filter(c => {
    if (activeTab === 'ai'     && c.agent_mode !== 'ai')    return false;
    if (activeTab === 'human'  && c.agent_mode !== 'human') return false;
    if (activeTab === 'unread' && !(c.unread_count > 0))    return false;
    if (activeTab === 'hot'     && (!HOT_STATES.includes(c.pipeline_state) || c.hot_lead_excluded)) return false;
    if (activeTab === 'stalled' && !isStalled(c))                          return false;
    const q = search.toLowerCase();
    return (
      c.contact_name?.toLowerCase().includes(q) ||
      c.phone_number?.includes(q) ||
      c.last_message?.toLowerCase().includes(q)
    );
  });

  const [triggering, setTriggering] = useState(false);

  const handleScanHotLeads = async () => {
    setScanning(true);
    try {
      await api.post('/conversations/scan-hot-leads');
      onRefresh();
      setActiveTab('hot');
    } catch (e) { console.error(e); }
    finally { setScanning(false); }
  };

  const handleTriggerFollowUp = async () => {
    setTriggering(true);
    try {
      const r = await api.post('/conversations/trigger-follow-up');
      onRefresh();
      setActiveTab('stalled');
      if (r.data?.sent > 0) alert(`✅ Bot envió ${r.data.sent} mensaje(s) de seguimiento`);
      else alert('Sin conversaciones que necesiten seguimiento ahora mismo');
    } catch (e) { console.error(e); }
    finally { setTriggering(false); }
  };

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

  const handleMergeAllDuplicates = async () => {
    if (!window.confirm('¿Fusionar TODOS los duplicados? Esto busca todos los números guardados en distintos formatos (sin 56, con +, etc.) y los une en una sola conversación. No se pueden deshacer los cambios.')) return;
    setMergingAll(true); setMergeAllResult(null);
    try {
      const r = await api.post('/conversations/merge-duplicates');
      setMergeAllResult(r.data);
      onRefresh();
      // Refrescar diagnóstico si hay número buscado
      if (diagPhone.trim()) {
        const r2 = await api.get(`/conversations/search-by-phone?phone=${encodeURIComponent(diagPhone.trim())}`);
        setDiagResults(r2.data);
      }
    } catch (e) { alert('Error: ' + (e.response?.data?.error || e.message)); }
    finally { setMergingAll(false); }
  };

  const handleDiagSearch = async () => {
    if (!diagPhone.trim()) return;
    setDiagLoading(true); setDiagError(''); setDiagResults(null);
    try {
      const r = await api.get(`/conversations/search-by-phone?phone=${encodeURIComponent(diagPhone.trim())}`);
      setDiagResults(r.data);
    } catch (e) { setDiagError(e.response?.data?.error || e.message); }
    finally { setDiagLoading(false); }
  };

  const handleMergeInto = async (targetId, sourceId) => {
    if (!window.confirm('¿Fusionar esa conversación en esta? Los mensajes del número anterior quedarán aquí y esa conversación se borrará.')) return;
    setMergingId(sourceId);
    try {
      await api.post(`/conversations/merge-into/${targetId}`, { sourceId });
      // Refrescar resultados del diagnóstico
      const r = await api.get(`/conversations/search-by-phone?phone=${encodeURIComponent(diagPhone.trim())}`);
      setDiagResults(r.data);
      onRefresh();
    } catch (e) { alert('Error: ' + (e.response?.data?.error || e.message)); }
    finally { setMergingId(null); }
  };

  const inp = {
    width: '100%', backgroundColor: colors.bgHover, border: `1px solid ${colors.borderStrong}`,
    borderRadius: '8px', padding: '10px 12px', color: colors.textPrimary,
    fontSize: '14px', outline: 'none', boxSizing: 'border-box',
  };

  const fmtDate = (d) => d ? new Date(d).toLocaleDateString('es-CL', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit' }) : '—';

  return (
    <>
    {/* Modal diagnóstico de número */}
    {showDiagModal && (
      <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000 }}
        onClick={() => setShowDiagModal(false)}>
        <div onClick={e => e.stopPropagation()}
          style={{ backgroundColor: colors.bgPanel, borderRadius: '14px', padding: '24px', width: '480px', maxWidth: '95vw',
            maxHeight: '80vh', display: 'flex', flexDirection: 'column', gap: '14px', boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
            border: `1px solid ${colors.border}`, overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Stethoscope size={18} color={colors.green} />
              <span style={{ fontWeight: 700, fontSize: '16px', color: colors.textPrimary }}>Diagnosticar número</span>
            </div>
            <button onClick={() => setShowDiagModal(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.textSecondary }}><X size={18} /></button>
          </div>
          <p style={{ margin: 0, fontSize: '13px', color: colors.textSecondary }}>
            Busca todas las conversaciones de un número en cualquier formato (+56, 56, sin prefijo). Si hay duplicados, podés fusionarlos aquí.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px',
            backgroundColor: colors.bgApp, borderRadius: '8px', border: `1px solid ${colors.border}` }}>
            <div style={{ flex: 1, fontSize: '12px', color: colors.textSecondary }}>
              <strong style={{ color: colors.textPrimary }}>Fusión masiva</strong> — une todos los duplicados de la org de una vez (9-digit sin 56, con +, etc.)
            </div>
            <button onClick={handleMergeAllDuplicates} disabled={mergingAll}
              style={{ flexShrink: 0, padding: '6px 12px', borderRadius: '7px', border: '1px solid #f59e0b',
                backgroundColor: 'transparent', color: mergingAll ? colors.textMuted : '#d97706',
                fontSize: '12px', fontWeight: 600, cursor: mergingAll ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', gap: '5px' }}>
              {mergingAll ? <Loader size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <GitMerge size={12} />}
              {mergingAll ? 'Fusionando...' : 'Fusionar todos'}
            </button>
          </div>
          {mergeAllResult && (
            <div style={{ padding: '8px 12px', borderRadius: '8px', backgroundColor: colors.bgAccent || '#22c55e18',
              border: '1px solid #22c55e44', fontSize: '12px', color: colors.green, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              ✅ Se fusionaron {mergeAllResult.mergedConversations} conversación(es) duplicada(s)
              <button onClick={() => setMergeAllResult(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.green }}><X size={12} /></button>
            </div>
          )}
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              type="tel" placeholder="56987249069 ó 987249069 ó +56987249069" value={diagPhone}
              onChange={e => setDiagPhone(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleDiagSearch()}
              style={{ flex: 1, padding: '9px 12px', borderRadius: '8px', border: `1px solid ${colors.borderStrong}`,
                backgroundColor: colors.bgApp, color: colors.textPrimary, fontSize: '14px', outline: 'none' }}
              autoFocus />
            <button onClick={handleDiagSearch} disabled={diagLoading}
              style={{ padding: '9px 16px', borderRadius: '8px', border: 'none', backgroundColor: colors.green,
                color: 'white', fontWeight: 600, fontSize: '13px', cursor: diagLoading ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', gap: '6px' }}>
              {diagLoading ? <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Search size={14} />}
              Buscar
            </button>
          </div>
          {diagError && <div style={{ padding: '10px 12px', borderRadius: '8px', backgroundColor: '#2d1a1a', color: '#f87171', fontSize: '13px' }}>{diagError}</div>}

          {diagResults && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ fontSize: '13px', color: colors.textSecondary }}>
                Variantes buscadas: {diagResults.variants.map(v => <code key={v} style={{ marginLeft: 4, fontSize: '11px', backgroundColor: colors.bgApp, padding: '1px 5px', borderRadius: '4px' }}>{v}</code>)}
              </div>
              {diagResults.conversations.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '20px', color: colors.textMuted, fontSize: '13px' }}>No se encontraron conversaciones para este número.</div>
              ) : (
                <>
                  {diagResults.conversations.length > 1 && (
                    <div style={{ padding: '8px 12px', borderRadius: '8px', backgroundColor: '#f59e0b18', border: '1px solid #f59e0b44', fontSize: '12px', color: '#d97706' }}>
                      ⚠️ Se encontraron {diagResults.conversations.length} conversaciones — hay duplicados. Fusioná las más antiguas en la más nueva.
                    </div>
                  )}
                  {diagResults.conversations.map((conv, idx) => (
                    <div key={conv.id} style={{ border: `1px solid ${idx === 0 ? colors.green : colors.border}`,
                      borderRadius: '10px', padding: '12px 14px', backgroundColor: colors.bgApp }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: '14px', color: colors.textPrimary }}>
                            {conv.contact_name && conv.contact_name !== 'Cliente' ? conv.contact_name : '(sin nombre)'}
                            {idx === 0 && <span style={{ marginLeft: 6, fontSize: '10px', backgroundColor: colors.green + '22', color: colors.green, borderRadius: '20px', padding: '1px 7px', fontWeight: 700 }}>MÁS RECIENTE</span>}
                          </div>
                          <div style={{ fontSize: '11px', color: colors.textSecondary, marginTop: '2px' }}>
                            📱 {conv.phone_number} · ID #{conv.id}
                          </div>
                          <div style={{ fontSize: '11px', color: colors.textSecondary, marginTop: '2px', display: 'flex', gap: '10px' }}>
                            <span>💬 {conv.message_count} mensajes</span>
                            <span>📅 {fmtDate(conv.first_message_at)} → {fmtDate(conv.last_message_at)}</span>
                          </div>
                        </div>
                        {idx > 0 && (
                          <button
                            onClick={() => handleMergeInto(diagResults.conversations[0].id, conv.id)}
                            disabled={mergingId === conv.id}
                            title={`Fusionar en conversación #${diagResults.conversations[0].id}`}
                            style={{ flexShrink: 0, padding: '6px 10px', borderRadius: '7px', border: '1px solid #f59e0b',
                              backgroundColor: 'transparent', color: '#d97706', fontSize: '11px', fontWeight: 600,
                              cursor: mergingId === conv.id ? 'not-allowed' : 'pointer',
                              display: 'flex', alignItems: 'center', gap: '4px' }}>
                            {mergingId === conv.id ? <Loader size={11} style={{ animation: 'spin 1s linear infinite' }} /> : <GitMerge size={11} />}
                            {mergingId === conv.id ? 'Fusionando...' : 'Fusionar aquí'}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        </div>
      </div>
    )}

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
      width: isMobile ? '100%' : '320px',
      minWidth: isMobile ? 'unset' : '260px',
      height: '100%',
      backgroundColor: colors.bgSub, borderRight: isMobile ? 'none' : `1px solid ${colors.border}`,
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
          <button onClick={() => { setShowDiagModal(true); setDiagPhone(''); setDiagResults(null); setDiagError(''); }}
            style={{ background: 'none', color: colors.textSecondary, padding: '6px', borderRadius: '50%', display: 'flex', alignItems: 'center', border: 'none', cursor: 'pointer' }}
            onMouseEnter={e => { e.currentTarget.style.background = colors.bgHover; e.currentTarget.style.color = colors.textPrimary; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = colors.textSecondary; }}
            title="Diagnosticar número (chats perdidos)"><Stethoscope size={16} /></button>
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
          {msgLoading ? <Loader size={16} color={colors.textSecondary} style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} /> : <Search size={16} color={colors.textSecondary} />}
          <input type="text" placeholder="Buscar conversación o mensaje..." value={search} onChange={e => setSearch(e.target.value)}
            style={{ background: 'none', border: 'none', color: colors.textPrimary, fontSize: '14px', flex: 1, outline: 'none' }} />
          {search && <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.textSecondary, padding: '0', display: 'flex' }}><X size={14} /></button>}
        </div>
      </div>

      {/* Chips de filtro — scrollable horizontal, estilo WhatsApp */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '6px',
        padding: '6px 12px 8px', overflowX: 'auto',
        backgroundColor: colors.bgSub,
        scrollbarWidth: 'none', msOverflowStyle: 'none',
      }}>
        {[
          { key: 'all',     label: 'Todos',      count: conversations.length, color: colors.green,   dot: null },
          { key: 'unread',  label: 'No leídos',  count: unreadCount,          color: '#f87171',      dot: null },
          { key: 'hot',     label: '🔥 Hot',     count: hotCount,             color: '#f97316',      dot: null },
          { key: 'stalled', label: '⏳ Sin cierre', count: stalledCount,      color: '#a78bfa',      dot: null },
          { key: 'ai',      label: '🤖 IA',      count: aiCount,              color: colors.green,   dot: null },
          { key: 'human',   label: '👤 Humano',  count: humanCount,           color: colors.yellow,  dot: humanUnread > 0 },
        ].map(tab => {
          const active = activeTab === tab.key;
          return (
            <button key={tab.key} onClick={() => setActiveTab(tab.key)}
              style={{
                flexShrink: 0,
                padding: '5px 12px', borderRadius: '20px',
                border: active ? 'none' : `1px solid ${colors.border}`,
                backgroundColor: active ? tab.color : colors.bgPanel,
                color: active ? '#fff' : colors.textSecondary,
                fontSize: '12px', fontWeight: active ? 700 : 400,
                cursor: 'pointer', position: 'relative',
                display: 'flex', alignItems: 'center', gap: '5px',
                transition: 'all 0.15s', whiteSpace: 'nowrap',
                boxShadow: active ? `0 2px 8px ${tab.color}44` : 'none',
              }}>
              <span>{tab.label}</span>
              {tab.count > 0 && (
                <span style={{
                  backgroundColor: active ? 'rgba(255,255,255,0.3)' : colors.bgHover,
                  color: active ? '#fff' : colors.textSecondary,
                  borderRadius: '10px', padding: '0 5px',
                  fontSize: '10px', fontWeight: 700, minWidth: '16px', textAlign: 'center',
                }}>{tab.count}</span>
              )}
              {tab.dot && (
                <span style={{ position: 'absolute', top: '-2px', right: '-2px', width: '7px', height: '7px', borderRadius: '50%', backgroundColor: '#ef4444', border: `1px solid ${colors.bgSub}` }} />
              )}
            </button>
          );
        })}

        {/* Botones de acción IA — solo visibles en el tab correspondiente */}
        {activeTab === 'hot' && (
          <button onClick={handleScanHotLeads} disabled={scanning}
            style={{ flexShrink: 0, padding: '5px 10px', borderRadius: '20px', border: `1px solid #f97316`, backgroundColor: 'transparent', color: scanning ? colors.textMuted : '#f97316', fontSize: '11px', fontWeight: 600, cursor: scanning ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
            {scanning ? <Loader size={10} /> : <Flame size={10} />}
            {scanning ? 'Escaneando...' : 'Escanear IA'}
          </button>
        )}
        {activeTab === 'stalled' && (
          <button onClick={handleTriggerFollowUp} disabled={triggering}
            style={{ flexShrink: 0, padding: '5px 10px', borderRadius: '20px', border: `1px solid #a78bfa`, backgroundColor: 'transparent', color: triggering ? colors.textMuted : '#a78bfa', fontSize: '11px', fontWeight: 600, cursor: triggering ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
            {triggering ? <Loader size={10} /> : <span style={{fontSize:'10px'}}>🤖</span>}
            {triggering ? 'Enviando...' : 'Bot seguimiento'}
          </button>
        )}
      </div>

      {/* Lista */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '40px', color: colors.textSecondary, fontSize: '14px' }}>Cargando...</div>
        ) : filtered.length === 0 && msgResults.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px', color: colors.textSecondary }}>
            <MessageSquare size={40} color={colors.textMuted} style={{ marginBottom: '12px' }} />
            <div style={{ fontSize: '14px' }}>{search ? 'Sin resultados' : 'Sin conversaciones aún'}</div>
          </div>
        ) : (
          <>
            {filtered.map(conv => (
              <ConversationItem key={conv.id} conversation={conv} selected={conv.id === selectedId} onClick={() => onSelect(conv.id)} />
            ))}

            {/* Resultados de búsqueda en mensajes */}
            {search.trim().length >= 2 && (
              <>
                {/* Separador solo si hay resultados de conversaciones arriba */}
                {filtered.length > 0 && msgResults.filter(r => !filtered.find(f => f.id === r.id)).length > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 14px 4px' }}>
                    <div style={{ flex: 1, height: '1px', backgroundColor: colors.border }} />
                    <span style={{ fontSize: '10px', color: colors.textMuted, fontWeight: 600, textTransform: 'uppercase', whiteSpace: 'nowrap' }}>Mensajes</span>
                    <div style={{ flex: 1, height: '1px', backgroundColor: colors.border }} />
                  </div>
                )}
                {/* Mostrar resultados de mensajes que no aparecen ya en la lista normal */}
                {msgResults
                  .filter(r => !filtered.find(f => f.id === r.id))
                  .map(r => {
                    const q = search.trim().toLowerCase();
                    const content = r.matched_content || '';
                    const idx = content.toLowerCase().indexOf(q);
                    let snippet = content;
                    if (idx >= 0) {
                      const start = Math.max(0, idx - 30);
                      const end   = Math.min(content.length, idx + q.length + 50);
                      snippet = (start > 0 ? '...' : '') + content.slice(start, end) + (end < content.length ? '...' : '');
                    }
                    const parts = snippet.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
                    const name = r.contact_name && r.contact_name !== r.phone_number ? r.contact_name : r.phone_number;
                    const initials = name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
                    const isSelected = r.id === selectedId;
                    return (
                      <div key={r.id} onClick={() => onSelect(r.id)}
                        style={{ padding: '10px 14px', cursor: 'pointer', borderBottom: `1px solid ${colors.border}`,
                          backgroundColor: isSelected ? colors.bgHover : 'transparent',
                          transition: 'background 0.1s',
                        }}
                        onMouseEnter={e => { if (!isSelected) e.currentTarget.style.backgroundColor = colors.bgHover; }}
                        onMouseLeave={e => { if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent'; }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <div style={{ width: '36px', height: '36px', borderRadius: '50%', backgroundColor: '#4db6ac', flexShrink: 0,
                            display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, color: 'white', fontSize: '12px' }}>
                            {initials}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: '13px', color: colors.textPrimary,
                              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>
                            <div style={{ fontSize: '11px', color: colors.textSecondary, marginTop: '2px', lineHeight: '1.4',
                              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                              {r.direction === 'inbound' ? '← ' : '→ '}
                              {parts.map((p, i) =>
                                p.toLowerCase() === q
                                  ? <mark key={i} style={{ backgroundColor: '#f59e0b55', color: colors.textPrimary, borderRadius: '2px', padding: '0 1px' }}>{p}</mark>
                                  : <span key={i}>{p}</span>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                {msgResults.filter(r => !filtered.find(f => f.id === r.id)).length === 0 && filtered.length === 0 && !msgLoading && (
                  <div style={{ textAlign: 'center', padding: '30px', color: colors.textSecondary }}>
                    <MessageSquare size={32} color={colors.textMuted} style={{ marginBottom: '8px' }} />
                    <div style={{ fontSize: '13px' }}>Sin resultados</div>
                  </div>
                )}
              </>
            )}
          </>
        )}
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
