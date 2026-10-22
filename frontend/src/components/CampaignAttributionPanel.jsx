import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, BarChart3, CheckCircle2, Clock3, ExternalLink, Megaphone, MessageCircle, MousePointerClick, RefreshCw, ShoppingBag, Users } from 'lucide-react';
import { api } from '../utils/api.js';
import { useTheme } from '../theme.js';

const money = value => `$${Math.round(Number(value || 0)).toLocaleString('es-CL')}`;
const shortDate = value => value ? new Date(value).toLocaleString('es-CL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const isoDate = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const shiftedDate = days => { const date = new Date(); date.setDate(date.getDate() + days); return isoDate(date); };
const orderStatus = value => ({
  nuevo: 'Nuevo', por_despachar: 'Por despachar', asignado_ruta: 'Asignado a ruta',
  en_camino: 'En camino', no_entregado: 'No entregado', entregado: 'Entregado',
  paid: 'Pagado', payment_received: 'Pago recibido', draft: 'Borrador', sent: 'Enviado',
}[value] || value || '—');
const itemSummary = value => {
  let items = value;
  try { if (typeof items === 'string') items = JSON.parse(items); } catch { items = []; }
  if (!Array.isArray(items)) return '';
  return items.map(item => `${item.quantity || 1}× ${item.name || item.title || item.product_name || 'Producto'}`).join(' · ');
};

export default function CampaignAttributionPanel({ onOpenConversation }) {
  const { colors } = useTheme();
  const [from, setFrom] = useState(() => shiftedDate(-1));
  const [to, setTo] = useState(() => shiftedDate(-1));
  const [basis, setBasis] = useState('purchase');
  const [provider, setProvider] = useState('');
  const [data, setData] = useState({ totals: {}, summary: [], records: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [recovering, setRecovering] = useState(false);
  const [firstPurchaseOnly, setFirstPurchaseOnly] = useState(false);
  const [recoveryResult, setRecoveryResult] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const endpoint = basis === 'journey' ? '/marketing-attribution/funnel' : '/marketing-attribution';
      const response = await api.get(endpoint, { params: { from, to, basis, provider: provider || undefined } });
      setData(response.data?.data || { totals: {}, summary: [], records: [] });
    } catch (err) {
      setError(err.response?.data?.error || 'No se pudo cargar el rendimiento de campañas.');
    } finally { setLoading(false); }
  }, [from, to, basis, provider]);

  useEffect(() => { load(); }, [load]);
  const totals = data.totals || {};
  const purchaseMode = basis === 'purchase';
  const journeyMode = basis === 'journey';
  const setRange = (startOffset, endOffset = 0) => { setFrom(shiftedDate(startOffset)); setTo(shiftedDate(endOffset)); };
  const recoverOrders = async () => {
    if (!provider) return;
    setRecovering(true); setError(''); setRecoveryResult('');
    try {
      const response = await api.post('/marketing-attribution/recover-orders', {
        from,
        to,
        provider,
        firstPurchaseOnly,
        campaignName: `Hacienda Diez Ríos · recuperación ${provider}`,
      });
      const recovered = Number(response.data?.data?.recovered || 0);
      setRecoveryResult(recovered
        ? `${recovered} pedido(s) recuperado(s) y agregado(s) a Ads.`
        : 'No se encontraron pedidos nuevos para recuperar en este período.');
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'No se pudieron recuperar los pedidos manuales.');
    } finally { setRecovering(false); }
  };

  return (
    <main style={{ flex: 1, minWidth: 0, height: '100%', overflow: 'auto', background: colors.bgApp, color: colors.textPrimary }}>
      <div style={{ maxWidth: 1280, margin: '0 auto', padding: 'clamp(16px, 3vw, 32px)' }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 22 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><Megaphone size={24} color={colors.green} /><h1 style={{ margin: 0, fontSize: 22 }}>Campañas a WhatsApp</h1></div>
            <p style={{ margin: '7px 0 0', color: colors.textSecondary, fontSize: 13, lineHeight: 1.5 }}>Compradores y contactos identificados desde anuncios, sin contar dos veces a la misma persona.</p>
          </div>
          <button onClick={load} disabled={loading} style={button(colors)}><RefreshCw size={15} />{loading ? 'Actualizando…' : 'Actualizar'}</button>
        </header>

        <section style={{ ...card(colors), display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap', marginBottom: 16 }}>
          <Field label="Analizar"><select value={basis} onChange={event => setBasis(event.target.value)} style={input(colors)}><option value="journey">Embudo y clientes en limbo</option><option value="purchase">Compras realizadas</option><option value="contact">Contactos recibidos</option></select></Field>
          <Field label="Desde"><input type="date" value={from} onChange={event => setFrom(event.target.value)} style={input(colors)} /></Field>
          <Field label="Hasta"><input type="date" value={to} onChange={event => setTo(event.target.value)} style={input(colors)} /></Field>
          <Field label="Canal"><select value={provider} onChange={event => setProvider(event.target.value)} style={input(colors)}><option value="">Todos</option><option value="evolution">Evolution</option><option value="kapso">Kapso</option><option value="meta">Meta directo</option></select></Field>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button onClick={() => setRange(-1, -1)} style={button(colors)}>Ayer</button>
            <button onClick={() => setRange(0, 0)} style={button(colors)}>Hoy</button>
            <button onClick={() => setRange(-1, 0)} style={button(colors)}>Ayer y hoy</button>
            <button onClick={() => setRange(-6, 0)} style={button(colors)}>7 días</button>
            <button onClick={() => setRange(-29, 0)} style={button(colors)}>30 días</button>
          </div>
          {purchaseMode && provider && <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', flexBasis: '100%', paddingTop: 4 }}>
            <button onClick={recoverOrders} disabled={recovering} style={button(colors)}>{recovering ? 'Recuperando…' : 'Recuperar pedidos manuales'}</button>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: colors.textSecondary, fontSize: 11 }}>
              <input type="checkbox" checked={firstPurchaseOnly} onChange={event => setFirstPurchaseOnly(event.target.checked)} />
              Solo primera compra
            </label>
            <span style={{ color: colors.textMuted, fontSize: 11 }}>Úsalo solo para fechas en que el canal estuvo inhabilitado; máximo 7 días.</span>
          </div>}
          {recoveryResult && <div style={{ color: colors.green, fontSize: 11, flexBasis: '100%' }}>{recoveryResult}</div>}
          <div style={{ color: colors.textMuted, fontSize: 11, flexBasis: '100%' }}>{journeyMode ? 'Sigue cada contacto desde el anuncio hasta el pedido y muestra el punto donde dejó de avanzar.' : purchaseMode ? 'Se muestran pedidos creados en el período y se asignan al último anuncio que inició el chat antes de la compra.' : 'Se muestran los contactos que iniciaron el chat desde un anuncio en el período y sus compras posteriores.'}</div>
        </section>

        {error && <div style={{ ...card(colors), borderColor: `${colors.red}77`, color: colors.red, marginBottom: 16 }}>{error}</div>}

        {journeyMode ? <JourneyAnalysis data={data} loading={loading} colors={colors} onOpenConversation={onOpenConversation} onRefresh={load} /> : <>
        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12, marginBottom: 20 }}>
          <Metric icon={Users} label={purchaseMode ? 'Compradores únicos' : 'Contactos desde anuncios'} value={totals.contacts || 0} colors={colors} />
          <Metric icon={ShoppingBag} label="Pedidos atribuidos" value={totals.orders || 0} colors={colors} />
          <Metric icon={BarChart3} label={purchaseMode ? 'Pedidos por comprador' : 'Conversión'} value={purchaseMode ? Number(totals.ordersPerBuyer || 0).toLocaleString('es-CL') : `${Number(totals.conversionRate || 0).toLocaleString('es-CL')}%`} colors={colors} />
          <Metric icon={MessageCircle} label="Ventas atribuidas" value={money(totals.revenue)} colors={colors} accent />
        </section>

        <SectionTitle title={purchaseMode ? 'Compras por campaña' : 'Rendimiento por campaña'} subtitle="Agrupa por ID de campaña, anuncio, enlace o título disponible." colors={colors} />
        <div style={{ ...card(colors), padding: 0, overflowX: 'auto', marginBottom: 24 }}>
          {data.summary?.length ? data.summary.map(row => (
            <div key={`${row.provider}:${row.campaign_key}`} style={{ display: 'grid', gridTemplateColumns: 'minmax(230px, 2fr) repeat(4, minmax(80px, .7fr))', gap: 12, alignItems: 'center', padding: '14px 16px', borderBottom: `1px solid ${colors.border}`, minWidth: 760 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 750, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.campaign_name}</div>
                <div style={{ color: colors.textMuted, fontSize: 11, marginTop: 4 }}>{row.provider} · atribución {row.precision} · {purchaseMode ? 'última compra' : 'última respuesta'} {shortDate(row.last_order_at || row.last_seen_at)}</div>
              </div>
              <SmallMetric label="Contactos" value={row.contacts} colors={colors} />
              <SmallMetric label="Pedidos" value={row.orders} colors={colors} />
              <SmallMetric label={purchaseMode ? 'Pedidos / comprador' : 'Conversión'} value={purchaseMode ? Number(row.orders_per_buyer || 0).toLocaleString('es-CL') : `${row.conversion_rate}%`} colors={colors} />
              <SmallMetric label="Ventas" value={money(row.revenue)} colors={colors} />
            </div>
          )) : <Empty loading={loading} purchaseMode={purchaseMode} colors={colors} />}
        </div>

        <SectionTitle title={purchaseMode ? 'Personas que compraron' : 'Registro de contactos'} subtitle={purchaseMode ? 'Una fila por persona y campaña; los pedidos repetidos se agrupan sin duplicar al comprador.' : 'Cada persona conserva el anuncio con el que inició la conversación.'} colors={colors} />
        <div style={{ display: 'grid', gap: 10 }}>
          {data.records?.length ? data.records.map(record => (
            <article key={record.id} style={{ ...card(colors), display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, alignItems: 'center' }}>
              <div>
                <strong style={{ display: 'block', fontSize: 14 }}>{record.contact_name || record.phone_number}</strong>
                <span style={{ color: colors.textSecondary, fontSize: 12 }}>{record.phone_number} · {record.provider}</span>
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{record.campaign_name || record.ad_name || record.headline || 'Anuncio de WhatsApp'}</div>
                <div style={{ marginTop: 5, display: 'flex', gap: 7, flexWrap: 'wrap', color: colors.textMuted, fontSize: 11 }}>
                  <span style={tag(colors, record.precision === 'exacta')}>Atribución {record.precision}</span>
                  <span>{purchaseMode ? `Compra ${shortDate(record.last_order_at)}` : shortDate(record.first_seen_at)}</span><span>·</span><span>{record.orders} pedido(s)</span><span>·</span><span>{money(record.revenue)}</span>
                </div>
                {purchaseMode && <div style={{ color: colors.textSecondary, fontSize: 11, marginTop: 7, lineHeight: 1.4 }}>{itemSummary(record.latest_order_items) || 'Productos no disponibles'} · {orderStatus(record.last_order_status)}</div>}
              </div>
              <div style={{ display: 'flex', gap: 7 }}>
                {record.source_url && <a href={record.source_url} target="_blank" rel="noreferrer" title="Abrir anuncio" style={iconButton(colors)}><ExternalLink size={15} /></a>}
                <button onClick={() => onOpenConversation?.(record.conversation_id)} style={button(colors)}>Ver chat</button>
              </div>
            </article>
          )) : !loading && <Empty purchaseMode={purchaseMode} colors={colors} />}
        </div>
        </>}
      </div>
    </main>
  );
}

function JourneyAnalysis({ data, loading, colors, onOpenConversation, onRefresh }) {
  const [filter, setFilter] = useState('limbo');
  const [savingReason, setSavingReason] = useState(null);
  const totals = data.totals || {};
  const funnel = data.funnel || {};
  const cohorts = data.cohorts || {};
  const records = (data.records || []).filter(record => filter === 'all' || record.outcome === filter);
  const steps = [
    ['Contactos Ads', funnel.contacts],
    ['Recibieron respuesta', funnel.answered],
    ['Interés definido', funnel.qualified],
    ['Enlace enviado', funnel.links_sent],
    ['Abrieron enlace', funnel.links_clicked],
    ['Pedido creado', funnel.converted],
  ];
  const minutes = value => value === null || value === undefined ? 'Sin datos' : `${Number(value).toLocaleString('es-CL')} min`;
  const saveReason = async (conversationId, reason) => {
    if (!reason) return;
    setSavingReason(conversationId);
    try { await api.patch(`/conversations/${conversationId}/limbo-reason`, { reason }); await onRefresh?.(); }
    finally { setSavingReason(null); }
  };

  if (loading) return <div style={{ ...card(colors), textAlign: 'center', color: colors.textMuted }}>Calculando el recorrido de las conversaciones…</div>;
  return <>
    <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 20 }}>
      <Metric icon={Users} label="Contactos desde Ads" value={totals.contacts || 0} colors={colors} />
      <Metric icon={CheckCircle2} label="Con pedidos" value={totals.converted || 0} colors={colors} accent />
      <Metric icon={AlertTriangle} label="En limbo" value={totals.limbo || 0} colors={colors} />
      <Metric icon={BarChart3} label="Conversión" value={`${Number(totals.conversion_rate || 0).toLocaleString('es-CL')}%`} colors={colors} />
    </section>

    <SectionTitle title="Árbol de avance" subtitle="Cada número muestra cuántas personas alcanzaron ese punto del recorrido." colors={colors} />
    <section style={{ ...card(colors), display: 'flex', alignItems: 'stretch', gap: 8, overflowX: 'auto', marginBottom: 20 }}>
      {steps.map(([label, value], index) => <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '1 0 130px' }}>
        <div style={{ flex: 1, minHeight: 74, borderRadius: 10, border: `1px solid ${colors.border}`, background: colors.bgSub, padding: 11, display: 'grid', alignContent: 'center' }}>
          <strong style={{ fontSize: 20 }}>{value || 0}</strong><span style={{ color: colors.textSecondary, fontSize: 11, marginTop: 4 }}>{label}</span>
        </div>
        {index < steps.length - 1 && <span style={{ color: colors.textMuted, fontWeight: 800 }}>›</span>}
      </div>)}
    </section>

    <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, marginBottom: 20 }}>
      <CohortCard title="Quienes compraron" icon={CheckCircle2} data={cohorts.converted} colors={colors} accent />
      <CohortCard title="Quienes quedaron en limbo" icon={Clock3} data={cohorts.limbo} colors={colors} />
      <div style={card(colors)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 750, fontSize: 13 }}><MousePointerClick size={16} color={colors.infoSoft} />Motivos principales</div>
        <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
          {(data.reasons || []).slice(0, 5).map(reason => <div key={reason.code} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12 }}><span style={{ color: colors.textSecondary }}>{reason.label}</span><strong>{reason.count}</strong></div>)}
          {!data.reasons?.length && <span style={{ color: colors.textMuted, fontSize: 12 }}>Todavía no hay abandonos clasificables.</span>}
        </div>
      </div>
    </section>

    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'end', flexWrap: 'wrap', marginBottom: 10 }}>
      <SectionTitle title="Detalle por persona" subtitle="Observado significa que el cliente expresó el motivo; inferido indica una conclusión por su último paso." colors={colors} />
      <Field label="Mostrar"><select value={filter} onChange={event => setFilter(event.target.value)} style={input(colors)}><option value="limbo">En limbo</option><option value="converted">Con pedido</option><option value="active">Todavía activos</option><option value="all">Todos</option></select></Field>
    </div>
    <div style={{ display: 'grid', gap: 10 }}>
      {records.map(record => <article key={record.conversation_id} style={{ ...card(colors), display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 14, alignItems: 'center' }}>
        <div><strong style={{ display: 'block', fontSize: 14 }}>{record.contact_name || record.phone_number}</strong><span style={{ color: colors.textSecondary, fontSize: 11 }}>{record.campaign_name || record.ad_name || record.headline || 'Anuncio de WhatsApp'} · {record.provider}</span></div>
        <div><div style={{ fontSize: 12, fontWeight: 750 }}>{record.stage_label}</div><div style={{ color: colors.textSecondary, fontSize: 11, marginTop: 5 }}>{record.reason_label}</div>{record.future_purchase_intent !== null && record.future_purchase_intent !== undefined && <div style={{ color: record.future_purchase_intent ? colors.green : colors.warning, fontSize: 10, marginTop: 4 }}>{record.future_purchase_intent ? 'Sí nos consideraría en una próxima compra' : 'No nos consideraría en una próxima compra'}</div>}<div style={{ color: colors.textMuted, fontSize: 10, marginTop: 4 }}>{record.reason_source === 'manual' ? 'Motivo confirmado manualmente' : record.reason_source === 'observed' ? 'Motivo observado' : record.reason_source === 'inferred' ? `Motivo inferido · ${Math.round(Number(record.reason_confidence || 0) * 100)}%` : 'Motivo desconocido'}</div><select aria-label="Confirmar motivo" disabled={savingReason === record.conversation_id} value={record.limbo_reason_code || ''} onChange={event => saveReason(record.conversation_id, event.target.value)} style={{ ...input(colors), height: 32, width: '100%', marginTop: 8, fontSize: 11 }}><option value="">Confirmar o corregir motivo…</option><option value="price">Precio</option><option value="delivery">Despacho o ubicación</option><option value="payment">Medio de pago</option><option value="later">Comprará después</option><option value="stock">Producto o disponibilidad</option><option value="competitor">Compró en otro lugar</option><option value="no_need">No lo necesita ahora</option><option value="service">Atención o servicio</option><option value="declined">No le interesa</option><option value="no_reply">No respondió</option><option value="unknown">Desconocido</option></select></div>
        <div style={{ fontSize: 11, color: colors.textSecondary, lineHeight: 1.7 }}>Primera respuesta: <strong>{minutes(record.first_response_minutes)}</strong><br />Respuesta del cliente: <strong>{minutes(record.customer_reply_minutes)}</strong><br />Sin responder: <strong>{record.silent_hours == null ? '—' : `${record.silent_hours} h`}</strong></div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button onClick={() => onOpenConversation?.(record.conversation_id)} style={button(colors)}>Ver conversación</button></div>
      </article>)}
      {!records.length && <Empty colors={colors} />}
    </div>
  </>;
}

function CohortCard({ title, icon: Icon, data = {}, colors, accent }) {
  const response = data.median_first_response_minutes == null ? 'Sin datos' : `${Number(data.median_first_response_minutes).toLocaleString('es-CL')} min`;
  return <div style={card(colors)}><div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 750, fontSize: 13 }}><Icon size={16} color={accent ? colors.green : colors.warning} />{title}</div><div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginTop: 14 }}><SmallMetric label="Personas" value={data.contacts || 0} colors={colors} /><SmallMetric label="1ª respuesta" value={response} colors={colors} /><SmallMetric label="Mensajes" value={data.average_messages || 0} colors={colors} /></div></div>;
}

function Field({ label, children }) { return <label style={{ display: 'grid', gap: 5, fontSize: 11, fontWeight: 700, minWidth: 150 }}>{label}{children}</label>; }
function Metric({ icon: Icon, label, value, colors, accent }) { return <div style={card(colors)}><Icon size={18} color={accent ? colors.green : colors.infoSoft} /><div style={{ marginTop: 14, fontSize: 24, fontWeight: 800 }}>{value}</div><div style={{ marginTop: 4, fontSize: 11, color: colors.textSecondary }}>{label}</div></div>; }
function SmallMetric({ label, value, colors }) { return <div><div style={{ fontWeight: 750, fontSize: 14 }}>{value}</div><div style={{ color: colors.textMuted, fontSize: 10, marginTop: 3 }}>{label}</div></div>; }
function SectionTitle({ title, subtitle, colors }) { return <div style={{ margin: '0 0 10px' }}><h2 style={{ margin: 0, fontSize: 15 }}>{title}</h2><p style={{ margin: '4px 0 0', color: colors.textMuted, fontSize: 11 }}>{subtitle}</p></div>; }
function Empty({ loading, purchaseMode, colors }) { return <div style={{ padding: 28, textAlign: 'center', color: colors.textMuted, fontSize: 13 }}>{loading ? 'Cargando registros…' : purchaseMode ? 'No hay compras atribuidas a anuncios en este período.' : 'Todavía no hay respuestas de anuncios registradas en este período. Los próximos contactos se guardarán automáticamente.'}</div>; }
function card(colors) { return { background: colors.bgPanel, border: `1px solid ${colors.border}`, borderRadius: 13, padding: 16 }; }
function input(colors) { return { height: 38, borderRadius: 9, border: `1px solid ${colors.border}`, background: colors.bgSub, color: colors.textPrimary, padding: '0 10px', outline: 'none' }; }
function button(colors) { return { minHeight: 36, borderRadius: 9, border: `1px solid ${colors.borderStrong}`, background: colors.bgSub, color: colors.textPrimary, padding: '0 12px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, cursor: 'pointer', fontWeight: 650, fontSize: 12 }; }
function iconButton(colors) { return { ...button(colors), width: 36, padding: 0, textDecoration: 'none' }; }
function tag(colors, exact) { return { color: exact ? colors.green : colors.warning, border: `1px solid ${exact ? colors.green : colors.warning}55`, background: `${exact ? colors.green : colors.warning}12`, borderRadius: 12, padding: '2px 7px' }; }
