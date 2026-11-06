import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Search, MessageSquare } from 'lucide-react';
import api, { conversationsAPI } from '../utils/api';
import { useTheme } from '../theme.js';
import { cadenceLabels, statusLabels, filterFrequencyCustomers, latestConversationId } from '../utils/purchase-frequency.mjs';

const PAGE_SIZE = 50;

export default function PurchaseFrequencyPanel({ onOpenConversation }) {
  const { colors } = useTheme();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('followup');
  const [cadence, setCadence] = useState('all');
  const [sort, setSort] = useState('next');
  const [page, setPage] = useState(1);
  const [openingChat, setOpeningChat] = useState(false);
  const [chatNotice, setChatNotice] = useState('');
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function openChat(customer) {
    setOpeningChat(true);
    setChatNotice('');
    try {
      const conversations = await conversationsAPI.getByPhone(customer.phone);
      if (!mounted.current) return;
      const id = latestConversationId(conversations);
      if (id == null) setChatNotice(`${customer.name} todavía no tiene un chat con mensajes en el CRM.`);
      else onOpenConversation(id);
    } catch {
      if (mounted.current) setChatNotice('No se pudo abrir el chat. Intenta nuevamente.');
    } finally { if (mounted.current) setOpeningChat(false); }
  }

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api.get('/clientes/all', { params: { view: 'frequency' }, signal: controller.signal, timeout: 60000 })
      .then(response => {
        if (controller.signal.aborted) return;
        if (!response.data.success) throw new Error('No se pudo cargar la frecuencia de compra.');
        setData(response.data);
        setPage(1);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setData(null);
          setError('No se pudo cargar la frecuencia de compra. Intenta nuevamente.');
        }
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refresh]);
  useEffect(() => { setPage(1); }, [search, status, cadence, sort]);

  const customers = data?.customers || [];
  const filtered = useMemo(() => filterFrequencyCustomers(data?.customers || [], { search, status, cadence, sort }), [data, search, status, cadence, sort]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  const control = { padding: '9px 12px', borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.bgPanel, color: colors.textPrimary, fontSize: 13 };
  const cell = { padding: '14px 16px', borderBottom: `1px solid ${colors.border}`, textAlign: 'left', verticalAlign: 'top' };
  const muted = { color: colors.textSecondary, fontSize: 12, marginTop: 5 };

  return <section aria-label="Frecuencia de compra" style={{ flex: 1, overflow: 'auto', padding: '20px 24px', color: colors.textPrimary }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', flexWrap: 'wrap', gap: 12 }}>
      <div>
        <h2 style={{ fontSize: 20, margin: '0 0 6px' }}>A quién le toca comprar</h2>
        <p style={{ ...muted, margin: 0 }}>Prioriza el seguimiento según las compras de Shopify y los pedidos directos del CRM.</p>
        {data && <p style={muted}>Calculado al {data.asOf} · Hora de Chile</p>}
      </div>
      <button style={{ ...control, cursor: 'pointer', display: 'flex', gap: 7, alignItems: 'center' }} disabled={loading} onClick={() => setRefresh(value => value + 1)}>
        <RefreshCw size={14} /> {loading ? 'Actualizando…' : 'Actualizar'}
      </button>
    </div>
    {loading ? <p role="status" style={{ padding: 30 }}>Calculando frecuencia de compra…</p> : error ? <div role="alert" style={{ padding: 24 }}>
      <p>{error}</p><button style={control} onClick={() => setRefresh(value => value + 1)}>Reintentar</button>
    </div> : <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, margin: '16px 0' }}>
        {[
          { key: 'followup', label: 'Para seguimiento', count: customers.filter(customer => !customer.optedOut && ['overdue', 'due'].includes(customer.status)).length },
          { key: 'all', label: 'Clientes', count: customers.length },
          ...['overdue', 'due', 'insufficient'].map(key => ({ key, label: statusLabels[key], count: customers.filter(customer => customer.status === key).length })),
        ].map(card => <button key={card.key} onClick={() => setStatus(card.key)} aria-pressed={status === card.key} style={{ ...control, textAlign: 'left', padding: 16, cursor: 'pointer', borderColor: status === card.key ? colors.green : colors.border }}>
          <strong style={{ display: 'block', fontSize: 25 }}>{card.count}</strong><span style={muted}>{card.label}</span>
        </button>)}
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <label style={{ ...control, display: 'flex', alignItems: 'center', gap: 8 }}><Search size={15} />
          <input aria-label="Buscar cliente por nombre o teléfono" placeholder="Nombre o teléfono" value={search} onChange={event => setSearch(event.target.value)} style={{ border: 0, background: 'transparent', color: colors.textPrimary, minWidth: 160 }} />
        </label>
        <select aria-label="Estado de próxima compra" value={status} onChange={event => setStatus(event.target.value)} style={control}>
          <option value="all">Todos los estados</option>{Object.entries(statusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <select aria-label="Intervalo de compra" value={cadence} onChange={event => setCadence(event.target.value)} style={control}>
          <option value="all">Todas las frecuencias</option>{Object.entries(cadenceLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <select aria-label="Ordenar clientes" value={sort} onChange={event => setSort(event.target.value)} style={control}>
          <option value="next">Próxima compra estimada</option><option value="last">Compra más reciente</option><option value="name">Nombre</option>
        </select>
      </div>
      <p style={{ ...muted, lineHeight: 1.6 }}>Para seguimiento incluye fechas estimadas vencidas o dentro de los próximos 3 días y excluye contactos dados de baja. Frecuencia = intervalo mediano entre los últimos 12 días distintos de compra, usando pedidos pagados o entregados del historial del CRM. Excluye borradores, cancelaciones y reembolsos totales. La fecha es orientativa; una sola fecha de compra no permite estimarla.</p>
      {chatNotice && <p role="status">{chatNotice}</p>}
      {!filtered.length ? <p style={{ padding: '35px 0' }}>{customers.length ? status === 'followup' && !search && cadence === 'all' ? 'No hay clientes pendientes de seguimiento según su frecuencia. Puedes consultar Todos los estados para revisar el historial.' : 'No hay clientes que coincidan con estos filtros.' : 'Todavía no hay clientes con teléfono ni compras registradas para mostrar.'}</p> : <>
        <div style={{ overflowX: 'auto', border: `1px solid ${colors.border}`, borderRadius: 10 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 800 }}>
            <thead><tr style={{ background: colors.bgPanel }}>{['Cliente', 'Compras', 'Última compra', 'Cada cuánto compra', 'Próxima compra estimada', 'Estado', ''].map(label => <th key={label} scope="col" style={{ ...cell, whiteSpace: 'nowrap' }}>{label}</th>)}</tr></thead>
            <tbody>{filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE).map(customer => <tr key={customer.phone}>
              <td style={cell}><strong>{customer.name}</strong><div style={muted}>{customer.phone}</div>{customer.optedOut && <div style={muted}>Dado de baja · No contactar</div>}</td>
              <td style={cell}>{customer.purchaseCount}<div style={muted}>{customer.purchaseDays} días distintos</div></td>
              <td style={cell}>{customer.lastPurchase || 'Sin compras'}{customer.daysSincePurchase != null && <div style={muted}>Hace {customer.daysSincePurchase} días</div>}</td>
              <td style={cell}>
                {customer.intervalDays == null ? 'Sin frecuencia suficiente' : <strong>Cada ~{customer.intervalDays.toLocaleString('es-CL')} días</strong>}
                <div style={muted}>{customer.regularity === 'regular' ? 'Patrón regular' : customer.regularity === 'variable' ? 'Patrón variable' : 'Historial limitado'}</div>
                {customer.recentDates.length > 0 && <details style={muted}><summary style={{ cursor: 'pointer' }}>Ver fechas usadas ({customer.sampleDays})</summary><div style={{ lineHeight: 1.7, maxWidth: 180 }}>{customer.recentDates.join(' · ')}</div></details>}
              </td>
              <td style={cell}>{customer.nextPurchase || 'Sin estimación'}{customer.daysUntilNext != null && <div style={muted}>{customer.daysUntilNext < 0 ? `Hace ${-customer.daysUntilNext} días` : customer.daysUntilNext === 0 ? 'Hoy' : `En ${customer.daysUntilNext} días`}</div>}</td>
              <td style={cell}><span style={{ color: customer.status === 'overdue' ? colors.warning : colors.textSecondary }}>{statusLabels[customer.status]}</span></td>
              <td style={cell}>{onOpenConversation && <button aria-label={`Abrir chat de ${customer.name}`} title="Abrir chat" disabled={openingChat} style={{ ...control, cursor: 'pointer' }} onClick={() => openChat(customer)}><MessageSquare size={16} /></button>}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14, flexWrap: 'wrap' }}>
          <span style={muted}>{filtered.length} clientes · Página {currentPage} de {pages}</span>
          <button style={control} disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>Anterior</button>
          <button style={control} disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>Siguiente</button>
        </div>
      </>}
    </>}
  </section>;
}
