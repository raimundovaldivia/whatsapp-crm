import { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../utils/api.js';
import { useTheme } from '../theme.js';

const money = value => `$${Number(value || 0).toLocaleString('es-CL')}`;
const sourceLabel = { observed: 'Expresado por el cliente', manual: 'Confirmado por el equipo', inferred: 'Inferido por el sistema', unknown: 'Sin confirmar' };
const chileDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const shift = (day, offset) => new Date(Date.parse(`${day}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
const dateTime = value => new Date(value).toLocaleString('es-CL', { timeZone: 'America/Santiago', dateStyle: 'short', timeStyle: 'short' });

export default function StatsPanel({ onOpenConversation }) {
  const { colors } = useTheme();
  const [range, setRange] = useState(() => ({ from: chileDay(), to: chileDay() }));
  const [tab, setTab] = useState('activity');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [visibleCount, setVisibleCount] = useState(30);
  const requestId = useRef(0);
  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true); setError('');
    try {
      const response = await api.get('/dashboard/daily-sales', { params: range });
      if (id === requestId.current) { setData(response.data.data); setVisibleCount(30); }
    } catch (err) {
      if (id === requestId.current) { setData(null); setError(err.response?.data?.error || 'No se pudieron actualizar los datos. Intenta nuevamente.'); }
    } finally { if (id === requestId.current) setLoading(false); }
  }, [range]);
  useEffect(() => {
    load();
    const timer = setInterval(() => { if (!document.hidden) load(); }, 60000);
    return () => { clearInterval(timer); ++requestId.current; };
  }, [load]);
  const selectRange = (offset, end = 0) => { const today = chileDay(); setRange({ from: shift(today, offset), to: shift(today, end) }); };
  const panel = { background: colors.bgPanel, border: `1px solid ${colors.border}`, borderRadius: 12, padding: 18 };
  const button = { background: colors.bgPanel, color: colors.textPrimary, border: `1px solid ${colors.border}`, borderRadius: 8, padding: '8px 12px', cursor: 'pointer' };
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 };
  const field = { ...button, colorScheme: 'dark', maxWidth: '100%' };
  const metric = (label, value, detail) => <div key={label} style={panel}><div style={{ color: colors.textSecondary, fontSize: 12 }}>{label}</div><div style={{ fontSize: 24, fontWeight: 750, margin: '8px 0' }}>{value}</div><div style={{ color: colors.textSecondary, fontSize: 12 }}>{detail}</div></div>;
  const headerCell = { textAlign: 'left', padding: 12, borderBottom: `1px solid ${colors.border}`, fontSize: 12 };
  const cell = { padding: 12, borderBottom: `1px solid ${colors.border}`, verticalAlign: 'top', fontSize: 13 };
  const activity = data?.activity;
  const cohort = data?.cohort;
  return <div style={{ flex: 1, height: '100vh', overflowY: 'auto', background: colors.bg, color: colors.textPrimary, padding: '20px clamp(12px, 3vw, 28px)', boxSizing: 'border-box' }}>
    <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 12, flexWrap: 'wrap' }}>
      <div><h1 style={{ margin: 0, fontSize: 22 }}>Ventas del día</h1><p style={{ color: colors.textSecondary, fontSize: 13 }}>Pedidos y conversaciones del CRM · Horario de Chile</p></div>
      <button style={button} onClick={load} disabled={loading}><RefreshCw size={14} aria-hidden="true" /> {loading ? 'Actualizando…' : 'Actualizar'}</button>
    </header>
    <section style={{ ...panel, display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap', marginBottom: 16 }}>
      <label style={{ display: 'grid', gap: 6 }}>Desde<input aria-label="Desde" type="date" value={range.from} max={chileDay()} onChange={e => setRange(r => ({ ...r, from: e.target.value }))} style={field} /></label>
      <label style={{ display: 'grid', gap: 6 }}>Hasta<input aria-label="Hasta" type="date" value={range.to} max={chileDay()} onChange={e => setRange(r => ({ ...r, to: e.target.value }))} style={field} /></label>
      <button style={button} onClick={() => selectRange(0)}>Hoy</button><button style={button} onClick={() => selectRange(-1, -1)}>Ayer</button>
      <button style={button} onClick={() => selectRange(-6)}>7 días</button><button style={button} onClick={() => selectRange(-29)}>30 días</button>
    </section>
    <nav aria-label="Vistas de estadísticas" style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
      {[['activity', 'Actividad'], ['opportunities', 'Oportunidades'], ['results', 'Resultados']].map(([id, label]) => <button key={id} aria-pressed={tab === id} style={{ ...button, borderColor: tab === id ? colors.green : colors.border }} onClick={() => setTab(id)}>{label}</button>)}
    </nav>
    {error && <p role="alert" style={{ ...panel, color: colors.dangerSoft }}>{error}</p>}
    {loading && <p role="status">Actualizando datos del CRM…</p>}
    {data && !loading && <>
      <p style={{ ...panel, lineHeight: 1.6 }}>{data.summary}<br /><small style={{ color: colors.textSecondary }}>Actualizado: {dateTime(data.generated_at)} · Se actualiza cada minuto mientras el panel está visible.</small></p>
      {tab === 'activity' && <>
        <div style={grid}>
          {metric('Personas que consultaron', cohort.contacts, `${cohort.acquisition_ads} con origen en anuncio identificado · ${cohort.direct_or_unknown} directas / sin origen identificado`)}
          {metric('Conversión de consultas', `${cohort.conversion_rate}%`, `${cohort.converted} personas con pedido posterior a su consulta`)}
          {metric('Pedidos creados', activity.orders, `${activity.buyers} compradores únicos · excluye borradores y cancelados`)}
          {metric('Valor de pedidos', money(activity.order_value), `Ticket promedio: ${money(activity.average_ticket)}`)}
          {metric('Cobrado en el período', money(activity.collected), 'Pagos confirmados con fecha registrada; pueden corresponder a pedidos anteriores')}
          {metric('Saldo pendiente actual', money(activity.receivable_current), 'Todos los pedidos vigentes del CRM, sin limitar por fecha de creación')}
          {metric('Pendientes de entrega actuales', activity.pending_delivery_current, 'La entrega y el pago se cuentan por separado')}
        </div>
        <section style={{ ...panel, marginTop: 16 }}><h2 style={{ fontSize: 16 }}>Pedidos por fecha de creación</h2><div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr><th style={headerCell}>Fecha Chile</th><th style={headerCell}>Pedidos</th><th style={headerCell}>Valor</th></tr></thead><tbody>{data.daily.map(day => <tr key={day.day}><td style={cell}>{day.day}</td><td style={cell}>{day.orders}</td><td style={cell}>{money(day.order_value)}</td></tr>)}</tbody></table></div></section>
      </>}
      {tab === 'opportunities' && <>
        <div style={grid}>{metric('En limbo', cohort.limbo, 'Sin pedido; revisar el contexto antes de contactar')}{metric('Conversaciones activas', cohort.active, 'Todavía pueden avanzar sin seguimiento adicional')}{metric('Con pedido anterior en curso', data.operational_contacts, 'Continuar en pago o entrega; no volver a vender el mismo pedido')}</div>
        <section style={{ ...panel, marginTop: 16 }}><h2 style={{ fontSize: 16 }}>Dónde se detienen</h2>{data.reasons.length ? data.reasons.map(r => <p key={`${r.source}:${r.code}`}><strong>{r.count}</strong> · {r.label} <small style={{ color: colors.textSecondary }}>({sourceLabel[r.source]})</small></p>) : <p>No hay abandonos identificados en este período.</p>}<p style={{ color: colors.textSecondary, fontSize: 12 }}>El silencio después del precio no confirma una objeción de precio.</p></section>
        <section style={{ ...panel, marginTop: 16 }}><h2 style={{ fontSize: 16 }}>Siguiente acción por contacto</h2><div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 620 }}><thead><tr>{['Contacto', 'Etapa y motivo', 'Siguiente acción', ''].map((h, i) => <th key={i} style={headerCell}>{h}</th>)}</tr></thead><tbody>{data.opportunities.slice(0, visibleCount).map(c => <tr key={c.conversation_id}><td style={cell}>{c.contact_name}<br /><small>{c.phone_number || 'Sin teléfono'}</small></td><td style={cell}>{c.stage_label}<br /><small style={{ color: colors.textSecondary }}>{c.reason_label} · {sourceLabel[c.reason_source]}</small></td><td style={cell}>{c.action}</td><td style={cell}><button style={button} onClick={() => onOpenConversation?.(c.conversation_id)}>Ver conversación</button></td></tr>)}</tbody></table></div>{!data.opportunities.length && <p>No hay oportunidades pendientes entre las consultas del período.</p>}{data.opportunities.length > visibleCount && <button style={button} onClick={() => setVisibleCount(n => n + 30)}>Mostrar 30 más</button>}</section>
      </>}
      {tab === 'results' && <>
        <div style={grid}>{metric('Pedidos de recompra', data.results.repeat_orders, 'Pedidos con una compra anterior registrada en el CRM')}{metric('Compradores del período', activity.buyers, 'Personas únicas con pedidos creados en estas fechas')}</div>
        <section style={{ ...panel, marginTop: 16 }}><h2 style={{ fontSize: 16 }}>Campaña anterior a cada compra</h2><p style={{ fontSize: 12, color: colors.textSecondary }}>Último anuncio identificado en los {data.attribution_window_days} días previos a cada pedido. Es una regla de atribución, no una prueba de causalidad. El origen de adquisición se conserva por separado.</p><div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}><thead><tr>{['Campaña', 'Compradores', 'Pedidos', 'Recompras', 'Valor de pedidos'].map(h => <th key={h} style={headerCell}>{h}</th>)}</tr></thead><tbody>{data.results.campaigns.map(c => <tr key={c.key}><td style={cell}>{c.label}</td><td style={cell}>{c.buyers}</td><td style={cell}>{c.orders}</td><td style={cell}>{c.repeat_orders}</td><td style={cell}>{money(c.order_value)}</td></tr>)}</tbody></table></div><p style={{ color: colors.textSecondary, fontSize: 12 }}>Un comprador puede aparecer en más de una campaña. El total de compradores únicos se calcula por separado.</p></section>
      </>}
      <footer style={{ ...panel, marginTop: 16, color: colors.textSecondary, fontSize: 12, lineHeight: 1.7 }}>
        <strong>Cómo leer estas cifras</strong><br />Las consultas agrupan a cada persona con mensajes entrantes en el período; su conversión incluye pedidos posteriores hasta la última actualización. Los pedidos y cobros se agrupan por sus propias fechas. Por eso son cifras distintas.<br />Shopify no se consulta ni se suma en este panel. No se importan ni modifican pedidos al abrir Estadísticas.<br />Los saldos y entregas son actuales. Las fechas anteriores se recalculan con el estado vigente; todavía no representan cierres contables congelados.
        {activity.confirmed_payments_without_date > 0 && <p role="status">Hay {money(activity.confirmed_payments_without_date)} confirmados sin fecha de pago verificable: reducen el saldo, pero no se asignan a un día inventado.</p>}
      </footer>
    </>}
  </div>;
}
