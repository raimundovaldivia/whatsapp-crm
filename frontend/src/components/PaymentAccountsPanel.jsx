import { useCallback, useEffect, useMemo, useState } from 'react';
import { Building2, CalendarDays, CheckCircle2, ChevronDown, CircleDollarSign, RefreshCw, UserRound, WalletCards } from 'lucide-react';
import { paymentProofsAPI } from '../utils/api.js';
import { useTheme } from '../theme.js';
import './PaymentAccountsPanel.css';
import { collectionOrders } from '../utils/account-collection.mjs';

const CLP = value => `$${Math.round(Number(value) || 0).toLocaleString('es-CL')}`;
const todayMonth = () => new Date().toLocaleDateString('en-CA', { year:'numeric', month:'2-digit', timeZone:'America/Santiago' }).slice(0, 7);
const fmtDate = value => value ? new Date(value).toLocaleDateString('es-CL', { day:'2-digit', month:'short', year:'numeric', timeZone:'America/Santiago' }) : '—';

function evidenceLabel(order) {
  const evidence = order?.evidence;
  if (order?.payment_method === 'efectivo') return { text:'Efectivo registrado', color:'#22c55e' };
  if (order?.payment_method === 'mixto' && !evidence?.bank_movement_id && evidence?.voucher_status !== 'verified') {
    return { text:'Mixto · transferencia pendiente', color:'#f59e0b' };
  }
  if (evidence?.bank_movement_id && evidence?.voucher_id) return { text:'Voucher + cartola', color:'#22c55e' };
  if (evidence?.bank_movement_id) return { text:'Verificado en cartola', color:'#38bdf8' };
  if (evidence?.voucher_status === 'verified') return { text:'Voucher verificado', color:'#22c55e' };
  if (evidence?.voucher_status === 'pre_verified') return { text:'Voucher por revisar', color:'#60a5fa' };
  if (evidence?.voucher_status === 'pending') return { text:'Voucher pendiente', color:'#f59e0b' };
  return { text:'Sin respaldo de pago', color:'#94a3b8' };
}

export default function PaymentAccountsPanel({ onOpenProof }) {
  const { colors } = useTheme();
  const [month, setMonth] = useState(todayMonth());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [onlyDebtors, setOnlyDebtors] = useState(false);
  const [query, setQuery] = useState('');
  const [view, setView] = useState('accounts');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setData(await paymentProofsAPI.getAccounts(month)); }
    catch (err) { setError(err.response?.data?.error || err.message); }
    finally { setLoading(false); }
  }, [month]);
  useEffect(() => { load(); }, [load]);

  const accounts = useMemo(() => (data?.accounts || []).filter(account => {
    if (onlyDebtors && Number(account.closing_balance) <= 0) return false;
    const q = query.toLowerCase().trim();
    return !q || [account.customer_name, account.customer_phone].some(v => String(v || '').toLowerCase().includes(q));
  }), [data, onlyDebtors, query]);

  const orders = useMemo(() => collectionOrders(data?.accounts || [], month, { query, onlyDebtors, from, to }), [data, month, query, onlyDebtors, from, to]);
  const groups = view === 'dates' ? Object.entries(orders.reduce((result, order) => {
    (result[order.date] ||= []).push(order); return result;
  }, {})) : [['', orders]];
  const inputStyle = { background: colors.bgPanel, color: colors.textPrimary, border: `1px solid ${colors.border}`, borderRadius: 8, padding: '7px 10px' };

  const card = (label, value, color, hint) => (
    <div style={{ backgroundColor:colors.bgPanel, border:`1px solid ${colors.border}`, borderRadius:'12px', padding:'13px 15px' }}>
      <div style={{ fontSize:'10px', textTransform:'uppercase', letterSpacing:'.45px', color:colors.textMuted }}>{label}</div>
      <div style={{ fontSize:'21px', fontWeight:800, color, marginTop:'4px' }}>{value}</div>
      {hint && <div style={{ fontSize:'10px', color:colors.textMuted, marginTop:'3px' }}>{hint}</div>}
    </div>
  );

  return (
    <div className="payment-accounts" style={{ flex:1, overflowY:'auto', padding:'16px 24px', backgroundColor:colors.bgApp }}>
      <div className="payment-accounts__toolbar" style={{ display:'flex', gap:'10px', alignItems:'center', flexWrap:'wrap', marginBottom:'14px' }}>
        <div style={{ display:'flex', alignItems:'center', gap:'8px', color:colors.textPrimary, fontWeight:700 }}><WalletCards size={18} color={colors.green} /> Cuenta corriente</div>
        <input type="month" min="2026-09" max={todayMonth()} value={month} onChange={e => { if (e.target.value) setMonth(e.target.value); }}
          style={{ backgroundColor:colors.bgPanel, color:colors.textPrimary, border:`1px solid ${colors.border}`, borderRadius:'8px', padding:'7px 10px' }} />
        <input className="payment-accounts__search" value={query} onChange={e => setQuery(e.target.value)} placeholder={view === 'accounts' ? "Buscar persona, empresa o teléfono…" : "Buscar pedido, cliente o teléfono…"}
          style={{ minWidth:'240px', flex:'0 1 320px', backgroundColor:colors.bgPanel, color:colors.textPrimary, border:`1px solid ${colors.border}`, borderRadius:'8px', padding:'8px 11px' }} />
        <label style={{ display:'flex', alignItems:'center', gap:'6px', fontSize:'12px', color:colors.textSecondary, cursor:'pointer' }}>
          <input type="checkbox" checked={onlyDebtors} onChange={e => setOnlyDebtors(e.target.checked)} /> Solo con deuda
        </label>
        <button onClick={load} style={{ marginLeft:'auto', border:`1px solid ${colors.border}`, backgroundColor:colors.bgPanel, color:colors.textSecondary, borderRadius:'8px', padding:'7px 9px', cursor:'pointer', display:'flex' }}><RefreshCw size={14} /></button>
      </div>

      <div style={{ fontSize:'11px', color:colors.textMuted, marginBottom:'12px', display:'flex', alignItems:'center', gap:'6px' }}>
        <CalendarDays size={13} /> Saldo inicial establecido en $0 al 1 de septiembre de 2026. Cada cierre pendiente pasa como saldo inicial del mes siguiente.
      </div>

      {data?.summary && <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(160px,1fr))', gap:'9px', marginBottom:'15px' }}>
        {card('Total pedidos del mes', CLP(data.summary.order_total), colors.info, `${data.summary.orders} pedidos creados`) }
        {card('Por cobrar al cierre', CLP(data.summary.receivable), colors.amber, `${data.summary.debtors} cuentas con deuda`)}
        {card('Pedidos entregados', CLP(data.summary.charges), colors.textPrimary, `${data.summary.charged_orders} pedidos cargados`) }
        {card('Efectivo recibido', CLP(data.summary.cash_payments), colors.success, 'Registrado al entregar')}
        {card('Transferencias respaldadas', CLP(data.summary.transfer_payments), colors.teal, 'Voucher, cartola o ambos')}
        {card('Cuentas activas', data.summary.customers, colors.infoSoft || '#60a5fa', 'Personas y empresas')}
      </div>}

      {data?.summary && <div style={{ fontSize:'10px', color:colors.textMuted, margin:'-7px 0 13px' }}>
        Total pedidos usa la fecha de creación. La cuenta corriente registra el cargo completo de cada entrega y separa el pago en efectivo de la transferencia.
      </div>}

      <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center', marginBottom:14 }}>
        {[['accounts','Por cuentas'],['orders','Por pedidos'],['dates','Por fechas']].map(([key,label]) =>
          <button key={key} aria-pressed={view === key} onClick={() => setView(key)} style={{ ...inputStyle, cursor:'pointer', color:view === key ? colors.green : colors.textSecondary, borderColor:view === key ? colors.green : colors.border }}>{label}</button>)}
        {view !== 'accounts' && <>
          <label style={{ color:colors.textSecondary, fontSize:12 }}>Cargo desde <input aria-label="Cargo desde" type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} style={inputStyle} /></label>
          <label style={{ color:colors.textSecondary, fontSize:12 }}>Hasta <input aria-label="Cargo hasta" type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} style={inputStyle} /></label>
          {(from || to) && <button style={inputStyle} onClick={() => { setFrom(''); setTo(''); }}>Limpiar fechas</button>}
        </>}
      </div>
      {view !== 'accounts' && !loading && <div style={{ color:colors.textSecondary, fontSize:12, marginBottom:12 }}>
        {orders.length} pedidos · Pendiente al cierre: <strong style={{ color:colors.amber }}>{CLP(orders.reduce((sum,o) => sum + o.closing_due,0))}</strong>
        <div style={{ marginTop:5 }}>Incluye pedidos de meses anteriores. Fechas según el cargo; ordenados del más antiguo al más reciente. Los indicadores superiores corresponden al mes completo.</div>
      </div>}
      {error && <div style={{ color:colors.dangerSoft, padding:'10px', border:`1px solid ${colors.dangerSoft}55`, borderRadius:'8px' }}>{error}</div>}
      {loading ? <div style={{ color:colors.textMuted, padding:'35px', textAlign:'center' }}>Calculando cuentas…</div> : view !== 'accounts' ? (orders.length === 0 ? <div style={{ color:colors.textMuted, padding:35 }}>No hay pedidos para estos filtros.</div> : groups.map(([date, rows]) => <section key={date || 'orders'} style={{ marginBottom:16 }} >
        {date && <h3 style={{ color:colors.textPrimary, fontSize:14 }}>{fmtDate(date + 'T12:00:00Z')} · {rows.length} pedidos · Pendiente {CLP(rows.reduce((sum,o) => sum + o.closing_due,0))}</h3>}
        <div style={{ overflowX:'auto', border:`1px solid ${colors.border}`, borderRadius:10 }}><table className="payment-accounts__orders" style={{ width:'100%', borderCollapse:'collapse', color:colors.textPrimary, background:colors.bgPanel }}>
          <thead><tr>{['Cliente / teléfono','Pedido','Fecha del cargo','Total','Pagado al cierre','Pendiente al cierre','Respaldo'].map(label => <th key={label}>{label}</th>)}</tr></thead>
          <tbody>{rows.map(order => { const ev = evidenceLabel(order); return <tr key={`${order.source}:${order.id}`} style={{ borderTop:`1px solid ${colors.border}` }}>
            <td><strong>{order.customer_name}</strong><div style={{ color:colors.textMuted, fontSize:11 }}>{order.customer_phone || 'Sin teléfono'}</div></td>
            <td>{order.label}<div style={{ color:colors.textMuted, fontSize:10 }}>{order.source === 'bot' ? 'CRM' : 'Shopify'}</div></td>
            <td>{fmtDate(order.charge_date)}</td><td>{CLP(order.amount)}</td><td>{CLP(order.closing_paid)}</td>
            <td style={{ color:order.closing_due > 0 ? colors.amber : colors.success, fontWeight:800 }}>{CLP(order.closing_due)}</td>
            <td><span style={{ color:ev.color }}>{ev.text}</span>{order.evidence?.voucher_id && onOpenProof && <button style={{ ...inputStyle, marginLeft:8, cursor:'pointer' }} onClick={() => onOpenProof(order.evidence.voucher_id)}>Ver voucher</button>}</td>
          </tr>; })}</tbody>
        </table></div>
      </section>)) : accounts.length === 0 ? (
        <div style={{ color:colors.textMuted, padding:'35px', textAlign:'center' }}>No hay cuentas para este período y filtro.</div>
      ) : <div style={{ display:'flex', flexDirection:'column', gap:'8px' }}>
        {accounts.map(account => {
          const owing = Number(account.closing_balance) > 0;
          return <details key={account.key} style={{ backgroundColor:colors.bgPanel, border:`1px solid ${owing ? colors.amberStrong + '75' : colors.border}`, borderRadius:'12px', overflow:'hidden' }}>
            <summary className="payment-account__summary" style={{ listStyle:'none', cursor:'pointer', padding:'12px 14px', display:'grid', gridTemplateColumns:'minmax(220px,1.5fr) repeat(4,minmax(95px,.6fr)) 22px', gap:'10px', alignItems:'center' }}>
              <div style={{ display:'flex', gap:'9px', alignItems:'center', minWidth:0 }}>
                {account.client_type === 'empresa' ? <Building2 size={17} color="#93c5fd" /> : <UserRound size={17} color={colors.textMuted} />}
                <div style={{ minWidth:0 }}><div style={{ color:colors.textPrimary, fontSize:'13px', fontWeight:800, overflow:'hidden', textOverflow:'ellipsis' }}>{account.customer_name}</div><div style={{ color:colors.textMuted, fontSize:'10px' }}>{account.customer_phone || 'Sin teléfono'} · {account.client_type === 'empresa' ? 'Empresa' : 'Persona'}</div></div>
              </div>
              <div className="payment-account__metric"><small style={{ color:colors.textMuted }}>Saldo anterior</small><div style={{ color:colors.textSecondary, fontWeight:700 }}>{CLP(account.opening_balance)}</div></div>
              <div className="payment-account__metric"><small style={{ color:colors.textMuted }}>Cargos</small><div style={{ color:colors.textPrimary, fontWeight:700 }}>{CLP(account.charges)}</div></div>
              <div className="payment-account__metric"><small style={{ color:colors.textMuted }}>Pagos</small><div style={{ color:colors.success, fontWeight:700 }}>−{CLP(account.payments)}</div></div>
              <div className="payment-account__metric"><small style={{ color:colors.textMuted }}>Saldo final</small><div style={{ color:owing ? colors.amber : colors.success, fontSize:'15px', fontWeight:900 }}>{CLP(account.closing_balance)}</div></div>
              <ChevronDown size={15} color={colors.textMuted} />
            </summary>
            <div style={{ borderTop:`1px solid ${colors.border}` }}>
              {account.orders.map(order => {
                const ev = evidenceLabel(order);
                return <div key={`${order.source}:${order.id}`} style={{ display:'flex', alignItems:'center', gap:'10px', padding:'10px 14px', borderBottom:`1px solid ${colors.border}`, flexWrap:'wrap' }}>
                  <CircleDollarSign size={16} color={order.paid ? colors.success : colors.amber} />
                  <div style={{ flex:'1 1 240px' }}><strong style={{ color:colors.textPrimary, fontSize:'12px' }}>{order.label}</strong><div style={{ color:colors.textMuted, fontSize:'10px' }}>Cargo {fmtDate(order.charge_date)}{order.payment_date ? ` · pago ${fmtDate(order.payment_date)}` : ''}{order.cash_amount > 0 ? ` · efectivo ${CLP(order.cash_amount)}` : ''}{order.transfer_amount > 0 ? ` · transferencia ${CLP(order.transfer_amount)}` : ''}</div></div>
                  <span style={{ fontSize:'10px', color:ev.color, border:`1px solid ${ev.color}55`, borderRadius:'999px', padding:'3px 7px', display:'flex', gap:'4px', alignItems:'center' }}>{order.paid && <CheckCircle2 size={11} />}{ev.text}{order.evidence?.score != null ? ` · ${order.evidence.score}/100` : ''}</span>
                  {order.evidence?.voucher_id && onOpenProof && <button onClick={() => onOpenProof(order.evidence.voucher_id)} style={{ border:`1px solid ${colors.border}`, background:'none', color:colors.textSecondary, borderRadius:'6px', padding:'4px 7px', cursor:'pointer', fontSize:'10px' }}>Ver voucher</button>}
                  <strong style={{ color:order.balance > 0 ? colors.amber : colors.success, minWidth:'105px', textAlign:'right' }}>{order.balance > 0 ? 'Saldo' : 'Pagado'} {CLP(order.balance > 0 ? order.balance : order.amount)}</strong>
                </div>;
              })}
            </div>
          </details>;
        })}
      </div>}
    </div>
  );
}
