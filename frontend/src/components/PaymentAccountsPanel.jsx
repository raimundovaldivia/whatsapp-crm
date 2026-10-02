import { useCallback, useEffect, useMemo, useState } from 'react';
import { Building2, CalendarDays, CheckCircle2, ChevronDown, CircleDollarSign, RefreshCw, UserRound, WalletCards } from 'lucide-react';
import { paymentProofsAPI } from '../utils/api.js';
import { useTheme } from '../theme.js';
import './PaymentAccountsPanel.css';

const CLP = value => `$${Math.round(Number(value) || 0).toLocaleString('es-CL')}`;
const todayMonth = () => new Date().toLocaleDateString('en-CA', { year:'numeric', month:'2-digit', timeZone:'America/Santiago' }).slice(0, 7);
const fmtDate = value => value ? new Date(value).toLocaleDateString('es-CL', { day:'2-digit', month:'short', year:'numeric', timeZone:'America/Santiago' }) : '—';

function evidenceLabel(evidence) {
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
        <input type="month" min="2026-09" max={todayMonth()} value={month} onChange={e => setMonth(e.target.value)}
          style={{ backgroundColor:colors.bgPanel, color:colors.textPrimary, border:`1px solid ${colors.border}`, borderRadius:'8px', padding:'7px 10px' }} />
        <input className="payment-accounts__search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Buscar persona, empresa o teléfono…"
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
        {card('Por cobrar al cierre', CLP(data.summary.receivable), colors.amber, `${data.summary.debtors} cuentas con deuda`)}
        {card('Cargos del mes', CLP(data.summary.charges), colors.textPrimary, 'Pedidos entregados por transferencia')}
        {card('Pagos del mes', CLP(data.summary.payments), colors.success, 'Voucher, cartola o ambos')}
        {card('Cuentas activas', data.summary.customers, colors.infoSoft || '#60a5fa', 'Personas y empresas')}
      </div>}

      {error && <div style={{ color:colors.dangerSoft, padding:'10px', border:`1px solid ${colors.dangerSoft}55`, borderRadius:'8px' }}>{error}</div>}
      {loading ? <div style={{ color:colors.textMuted, padding:'35px', textAlign:'center' }}>Calculando cuentas…</div> : accounts.length === 0 ? (
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
                const ev = evidenceLabel(order.evidence);
                return <div key={`${order.source}:${order.id}`} style={{ display:'flex', alignItems:'center', gap:'10px', padding:'10px 14px', borderBottom:`1px solid ${colors.border}`, flexWrap:'wrap' }}>
                  <CircleDollarSign size={16} color={order.paid ? colors.success : colors.amber} />
                  <div style={{ flex:'1 1 240px' }}><strong style={{ color:colors.textPrimary, fontSize:'12px' }}>{order.label}</strong><div style={{ color:colors.textMuted, fontSize:'10px' }}>Cargo {fmtDate(order.charge_date)}{order.payment_date ? ` · pago ${fmtDate(order.payment_date)}` : ''}</div></div>
                  <span style={{ fontSize:'10px', color:ev.color, border:`1px solid ${ev.color}55`, borderRadius:'999px', padding:'3px 7px', display:'flex', gap:'4px', alignItems:'center' }}>{order.paid && <CheckCircle2 size={11} />}{ev.text}{order.evidence?.score != null ? ` · ${order.evidence.score}/100` : ''}</span>
                  {order.evidence?.voucher_id && onOpenProof && <button onClick={() => onOpenProof(order.evidence.voucher_id)} style={{ border:`1px solid ${colors.border}`, background:'none', color:colors.textSecondary, borderRadius:'6px', padding:'4px 7px', cursor:'pointer', fontSize:'10px' }}>Ver voucher</button>}
                  <strong style={{ color:order.paid ? colors.success : colors.amber, minWidth:'88px', textAlign:'right' }}>{order.paid ? 'Pagado' : 'Debe'} {CLP(order.amount)}</strong>
                </div>;
              })}
            </div>
          </details>;
        })}
      </div>}
    </div>
  );
}
