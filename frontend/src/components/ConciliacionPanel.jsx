/**
 * ConciliacionPanel — Cartola del banco ↔ pedidos sin pagar.
 *
 * 1. Subes el PDF de la cartola Santander (diario, se puede repetir: no duplica).
 * 2. Cada abono pendiente muestra los pedidos que calzan (monto exacto, fecha,
 *    parecido del nombre) con una confianza: alta / media / baja.
 * 3. Confirmas con un clic → el pedido queda pagado con la referencia del abono.
 *    Nada se marca sin tu confirmación. Se puede revertir.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../utils/api.js';
import { Upload, RotateCcw, Check, X, Search, Undo2, FileText } from 'lucide-react';

const CLP = n => `$${Math.round(Number(n) || 0).toLocaleString('es-CL')}`;
const fmtDate = d => d ? new Date(String(d).slice(0, 10) + 'T12:00:00').toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—';
const CONF = {
  alta:  { label: 'Alta',  color: '#22c55e' },
  media: { label: 'Media', color: '#fbbf24' },
  baja:  { label: 'Baja',  color: '#94a3b8' },
};

export default function ConciliacionPanel({ colors }) {
  const [view, setView]         = useState('pending');   // pending | matched | ignored | statements
  const [rows, setRows]         = useState([]);
  const [stats, setStats]       = useState(null);
  const [statements, setStatements] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [notice, setNotice]     = useState('');
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId]     = useState(null);
  const [manualFor, setManualFor] = useState(null);      // movement id abierto para asignar a mano
  const [manualQ, setManualQ]   = useState('');
  const [manualOrders, setManualOrders] = useState([]);
  const [manualSel, setManualSel] = useState({});        // `${source}_${id}` → order
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [st, data] = await Promise.all([
        api.get('/reconciliation/stats'),
        view === 'pending'    ? api.get('/reconciliation/suggestions')
        : view === 'statements' ? api.get('/reconciliation/statements')
        : api.get(`/reconciliation/movements?status=${view}`),
      ]);
      setStats(st.data.stats);
      if (view === 'pending') setRows(data.data.movements || []);
      else if (view === 'statements') setStatements(data.data.statements || []);
      else setRows(data.data.movements || []);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally { setLoading(false); }
  }, [view]);

  useEffect(() => { load(); }, [load]);

  async function onFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    e.target.value = '';
    if (!/\.pdf$/i.test(f.name)) { setError('Sube el PDF de la cartola (Santander).'); return; }
    setUploading(true); setError(''); setNotice('');
    try {
      const base64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(f); });
      const r = await api.post('/reconciliation/upload', { filename: f.name, base64 });
      const p = r.data.parsed || {};
      setNotice(`Cartola ${p.kind === 'provisoria' ? 'provisoria' : 'histórica'} #${p.statementNumber || '?'} (${fmtDate(p.from)} → ${fmtDate(p.to)}): ${r.data.total} abonos leídos, ${r.data.inserted} nuevos${r.data.duplicates ? `, ${r.data.duplicates} ya estaban` : ''}. Cuadra con el banco: ${CLP(p.totals?.abonos)} ✓`);
      setView('pending');
      await load();
    } catch (err) {
      const d = err.response?.data;
      setError(d?.warnings?.length ? `${d.error}: ${d.warnings.join(' · ')}` : (d?.error || err.message));
    } finally { setUploading(false); }
  }

  async function confirm(movId, orders) {
    setBusyId(movId); setError('');
    try {
      await api.post(`/reconciliation/movements/${movId}/confirm`, { orders: orders.map(o => ({ source: o.source, id: o.id })) });
      setRows(prev => prev.filter(m => m.id !== movId));
      setStats(s => s ? { ...s, pending: s.pending - 1, matched: s.matched + 1 } : s);
      setManualFor(null);
    } catch (err) { setError(err.response?.data?.error || err.message); }
    finally { setBusyId(null); }
  }

  async function ignore(movId) {
    const note = window.prompt('¿Por qué se ignora este abono? (ej: no es de un cliente, devolución, préstamo)') ;
    if (note === null) return;
    setBusyId(movId);
    try {
      await api.post(`/reconciliation/movements/${movId}/ignore`, { note });
      setRows(prev => prev.filter(m => m.id !== movId));
      setStats(s => s ? { ...s, pending: s.pending - 1, ignored: s.ignored + 1 } : s);
    } catch (err) { setError(err.response?.data?.error || err.message); }
    finally { setBusyId(null); }
  }

  async function unmatch(movId) {
    if (!window.confirm('¿Revertir esta conciliación? Los pedidos vuelven a su estado anterior.')) return;
    setBusyId(movId);
    try { await api.post(`/reconciliation/movements/${movId}/unmatch`); await load(); }
    catch (err) { setError(err.response?.data?.error || err.message); }
    finally { setBusyId(null); }
  }

  async function confirmAllHigh() {
    const high = rows.filter(m => m.candidates?.[0]?.confidence === 'alta');
    if (!high.length) return;
    if (!window.confirm(`Confirmar ${high.length} abono(s) con confianza ALTA (monto exacto + nombre coincide)?`)) return;
    for (const m of high) await confirm(m.id, m.candidates[0].orders);
  }

  // búsqueda manual
  useEffect(() => {
    if (manualFor == null) return;
    const t = setTimeout(async () => {
      try { const r = await api.get(`/reconciliation/orders?q=${encodeURIComponent(manualQ)}`); setManualOrders(r.data.orders || []); } catch {}
    }, 250);
    return () => clearTimeout(t);
  }, [manualFor, manualQ]);

  const chip = (text, color) => <span style={{ fontSize: '11px', fontWeight: 600, color, backgroundColor: color + '18', border: `1px solid ${color}44`, borderRadius: '20px', padding: '2px 9px', whiteSpace: 'nowrap' }}>{text}</span>;
  const btn = (extra = {}) => ({ fontSize: '12px', padding: '6px 11px', borderRadius: '7px', border: `1px solid ${colors.border}`, backgroundColor: colors.bgCard, color: colors.textPrimary, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '5px', ...extra });

  const manualTotal = Object.values(manualSel).reduce((s, o) => s + (o.total || 0), 0);
  const highCount = rows.filter(m => m.candidates?.[0]?.confidence === 'alta').length;

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {/* Barra superior */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
        <input ref={fileRef} type="file" accept="application/pdf" onChange={onFile} style={{ display: 'none' }} />
        <button onClick={() => fileRef.current?.click()} disabled={uploading} style={btn({ backgroundColor: colors.green, color: '#fff', border: 'none', fontWeight: 600 })}>
          <Upload size={13} /> {uploading ? 'Leyendo cartola…' : 'Subir cartola (PDF Santander)'}
        </button>
        <div style={{ display: 'flex', gap: '4px', backgroundColor: colors.bgSecondary, borderRadius: '8px', padding: '3px' }}>
          {[['pending', `Por conciliar${stats ? ` (${stats.pending})` : ''}`], ['matched', `Conciliados${stats ? ` (${stats.matched})` : ''}`], ['ignored', `Ignorados${stats ? ` (${stats.ignored})` : ''}`], ['statements', 'Cartolas']].map(([k, l]) => (
            <button key={k} onClick={() => setView(k)} style={{ padding: '4px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 600, border: 'none', cursor: 'pointer', backgroundColor: view === k ? colors.bgPanel : 'transparent', color: view === k ? colors.textPrimary : colors.textMuted }}>{l}</button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        {view === 'pending' && highCount > 0 && (
          <button onClick={confirmAllHigh} style={btn({ color: colors.green, fontWeight: 600 })}><Check size={13} /> Confirmar {highCount} de confianza alta</button>
        )}
        <button onClick={load} style={btn()} title="Actualizar"><RotateCcw size={13} /></button>
      </div>

      {stats && view === 'pending' && (
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {chip(`${stats.pending} abonos por conciliar · ${CLP(stats.pending_amount)}`, '#fbbf24')}
          {chip(`${stats.matched} conciliados`, '#22c55e')}
        </div>
      )}
      {notice && <div style={{ fontSize: '12px', color: colors.green, backgroundColor: colors.green + '12', border: `1px solid ${colors.green}44`, borderRadius: '8px', padding: '8px 12px' }}>{notice}</div>}
      {error  && <div style={{ fontSize: '12px', color: '#f87171', backgroundColor: '#f8717112', border: '1px solid #f8717144', borderRadius: '8px', padding: '8px 12px' }}>{error}</div>}
      {loading && <div style={{ color: colors.textMuted, fontSize: '13px' }}>Cargando…</div>}

      {/* ── Cartolas subidas ── */}
      {!loading && view === 'statements' && (
        statements.length === 0 ? <div style={{ color: colors.textMuted, fontSize: '13px' }}>Todavía no has subido ninguna cartola.</div> :
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
          <thead><tr style={{ color: colors.textMuted, fontSize: '10.5px', textTransform: 'uppercase' }}>
            {['Subida', 'Tipo', 'N°', 'Período', 'Abonos banco', 'Movimientos', 'Nuevos', 'Archivo'].map(h => <th key={h} style={{ textAlign: 'left', padding: '8px', borderBottom: `1px solid ${colors.border}` }}>{h}</th>)}
          </tr></thead>
          <tbody>{statements.map(s => (
            <tr key={s.id} style={{ borderBottom: `1px solid ${colors.border}` }}>
              <td style={{ padding: '8px', color: colors.textSecondary }}>{new Date(s.created_at).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
              <td style={{ padding: '8px' }}>{s.kind}</td>
              <td style={{ padding: '8px' }}>{s.statement_number}</td>
              <td style={{ padding: '8px' }}>{fmtDate(s.period_from)} → {fmtDate(s.period_to)}</td>
              <td style={{ padding: '8px', fontVariantNumeric: 'tabular-nums' }}>{CLP(s.total_abonos)}</td>
              <td style={{ padding: '8px' }}>{s.movements_count}</td>
              <td style={{ padding: '8px', color: s.new_movements ? colors.green : colors.textMuted }}>{s.new_movements}</td>
              <td style={{ padding: '8px', color: colors.textMuted }}><FileText size={11} /> {s.filename}</td>
            </tr>
          ))}</tbody>
        </table>
      )}

      {/* ── Conciliados / ignorados ── */}
      {!loading && (view === 'matched' || view === 'ignored') && (
        rows.length === 0 ? <div style={{ color: colors.textMuted, fontSize: '13px' }}>Nada por aquí todavía.</div> :
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {rows.map(m => (
            <div key={m.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px', padding: '10px 14px', border: `1px solid ${colors.border}`, borderRadius: '10px', backgroundColor: colors.bgCard }}>
              <span style={{ color: colors.textSecondary, fontSize: '12px', minWidth: '58px' }}>{fmtDate(m.date)}</span>
              <span style={{ color: colors.textPrimary, fontWeight: 700, minWidth: '90px', fontVariantNumeric: 'tabular-nums' }}>{CLP(m.amount)}</span>
              <span style={{ color: colors.textPrimary, fontSize: '13px', flex: 1, minWidth: '160px' }}>{m.payer || m.description}</span>
              {view === 'matched' && (m.matched_orders || []).map(o => chip(`${o.source === 'bot' ? '#BOT-' + o.id : o.id} pagado`, '#22c55e'))}
              {view === 'ignored' && m.note && <span style={{ fontSize: '12px', color: colors.textMuted }}>📝 {m.note}</span>}
              <button onClick={() => unmatch(m.id)} disabled={busyId === m.id} style={btn({ color: colors.textSecondary })} title="Revertir"><Undo2 size={12} /> Revertir</button>
            </div>
          ))}
        </div>
      )}

      {/* ── Por conciliar ── */}
      {!loading && view === 'pending' && (
        rows.length === 0 ? (
          <div style={{ color: colors.textMuted, fontSize: '13px', padding: '30px 0', textAlign: 'center' }}>
            {stats?.matched ? 'Todo conciliado ✅ Sube la próxima cartola cuando quieras.' : 'Sube la cartola del banco para empezar.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {rows.map(m => {
              const top = m.candidates?.[0];
              const conf = top ? CONF[top.confidence] : null;
              const isManual = manualFor === m.id;
              return (
                <div key={m.id} style={{ border: `1px solid ${top?.confidence === 'alta' ? colors.green + '55' : colors.border}`, borderRadius: '10px', backgroundColor: colors.bgCard, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {/* Abono */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' }}>
                    <span style={{ color: colors.textSecondary, fontSize: '12px', minWidth: '58px' }}>{fmtDate(m.date)}</span>
                    <span style={{ color: colors.textPrimary, fontWeight: 800, fontSize: '15px', minWidth: '96px', fontVariantNumeric: 'tabular-nums' }}>{CLP(m.amount)}</span>
                    <span style={{ color: colors.textPrimary, fontSize: '13px', flex: 1, minWidth: '160px' }}>🏦 {m.payer || m.description}<span style={{ color: colors.textMuted, fontSize: '11px', marginLeft: '8px' }}>doc {m.doc_number}</span></span>
                    {conf ? chip(`Confianza ${conf.label}`, conf.color) : chip('Sin pedido que calce', '#94a3b8')}
                    <button onClick={() => { setManualFor(isManual ? null : m.id); setManualQ(m.payer || ''); setManualSel({}); }} style={btn()}><Search size={12} /> Asignar a mano</button>
                    <button onClick={() => ignore(m.id)} disabled={busyId === m.id} style={btn({ color: colors.textMuted })}><X size={12} /> Ignorar</button>
                  </div>

                  {/* Candidatos */}
                  {!isManual && (m.candidates || []).slice(0, 3).map((c, i) => {
                    const cc = CONF[c.confidence];
                    return (
                      <div key={i} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', padding: '8px 10px', borderRadius: '8px', backgroundColor: colors.bgApp, opacity: c.reused ? 0.6 : 1 }}>
                        <span style={{ color: cc.color, fontSize: '11px', fontWeight: 700, minWidth: '46px' }}>{cc.label} {c.score}</span>
                        <span style={{ flex: 1, fontSize: '13px', color: colors.textPrimary, minWidth: '200px' }}>
                          {c.orders.map((o, k) => (
                            <span key={k}>{k > 0 ? ' + ' : ''}<b>{o.label}</b> {o.customer_name} · {CLP(o.total)} · {fmtDate(o.created_at)} · <span style={{ color: colors.textMuted }}>{o.status}</span></span>
                          ))}
                          {c.similarity > 0 && <span style={{ color: colors.textMuted, fontSize: '11px', marginLeft: '8px' }}>nombre {c.similarity}%</span>}
                          {c.reused && <span style={{ color: '#fbbf24', fontSize: '11px', marginLeft: '8px' }}>ya sugerido para otro abono</span>}
                        </span>
                        <button onClick={() => confirm(m.id, c.orders)} disabled={busyId === m.id} style={btn({ backgroundColor: colors.green, color: '#fff', border: 'none', fontWeight: 600 })}>
                          <Check size={12} /> {busyId === m.id ? 'Guardando…' : 'Confirmar pago'}
                        </button>
                      </div>
                    );
                  })}

                  {/* Asignación manual */}
                  {isManual && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px', borderRadius: '8px', backgroundColor: colors.bgApp }}>
                      <input autoFocus value={manualQ} onChange={e => setManualQ(e.target.value)} placeholder="Buscar pedido por cliente, teléfono, número o monto…"
                        style={{ padding: '7px 10px', borderRadius: '7px', border: `1px solid ${colors.border}`, backgroundColor: colors.bgCard, color: colors.textPrimary, fontSize: '13px', outline: 'none' }} />
                      <div style={{ maxHeight: '220px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        {manualOrders.map(o => {
                          const k = `${o.source}_${o.id}`; const on = !!manualSel[k];
                          return (
                            <label key={k} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', color: colors.textPrimary, cursor: 'pointer', padding: '4px 6px', borderRadius: '6px', backgroundColor: on ? colors.green + '15' : 'transparent' }}>
                              <input type="checkbox" checked={on} onChange={() => setManualSel(s => { const n = { ...s }; if (on) delete n[k]; else n[k] = o; return n; })} />
                              <b>{o.label}</b> {o.customer_name} · {CLP(o.total)} · {fmtDate(o.created_at)} · <span style={{ color: colors.textMuted }}>{o.status}</span>
                            </label>
                          );
                        })}
                        {manualOrders.length === 0 && <span style={{ color: colors.textMuted, fontSize: '12px' }}>Sin pedidos sin pagar que coincidan.</span>}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{ fontSize: '12px', color: Math.abs(manualTotal - m.amount) <= 1 ? colors.green : '#fbbf24' }}>
                          Seleccionado: {CLP(manualTotal)} {Math.abs(manualTotal - m.amount) <= 1 ? '✓ calza' : `(abono ${CLP(m.amount)})`}
                        </span>
                        <div style={{ flex: 1 }} />
                        <button onClick={() => setManualFor(null)} style={btn()}>Cancelar</button>
                        <button disabled={!Object.keys(manualSel).length || busyId === m.id}
                          onClick={() => { if (Math.abs(manualTotal - m.amount) > 1 && !window.confirm(`El total seleccionado (${CLP(manualTotal)}) no coincide con el abono (${CLP(m.amount)}). ¿Marcar igual como pagados?`)) return; confirm(m.id, Object.values(manualSel)); }}
                          style={btn({ backgroundColor: colors.green, color: '#fff', border: 'none', fontWeight: 600 })}>
                          <Check size={12} /> Confirmar pago
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}
