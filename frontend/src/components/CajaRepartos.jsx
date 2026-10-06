import { useEffect, useState } from 'react';
import { api } from '../utils/api.js';

const day = date => date.toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' });
const clp = value => `$${Math.round(value).toLocaleString('es-CL')}`;
const shift = (value, days) => { const date = new Date(value + 'T12:00:00'); date.setDate(date.getDate() + days); return day(date); };
export default function CajaRepartos({ colors, onShowExpenses }) {
  const today = day(new Date());
  const [range, setRange] = useState({ from: today, to: today });
  const [draft, setDraft] = useState(range);
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [values, setValues] = useState({ opening: '', outside: '', withdrawn: '', counted: '' });
  useEffect(() => {
    let active = true;
    setLoading(true); setReport(null); setError('');
    api.get('/delivery/cash-register', { params: range }).then(({ data }) => {
      if (active) setReport(data);
    }).catch(err => { if (active) setError(err.response?.data?.error || 'No se pudo cargar la caja.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [range, refresh]);
  function apply(next) {
    if (!next.from || !next.to || next.from > next.to) { setError('Selecciona fechas válidas, desde la menor hasta la mayor.'); return; }
    setDraft(next); setRange(next);
    setValues({ opening: '', outside: '', withdrawn: '', counted: '' });
  }
  const numbers = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Number(value || 0)]));
  const invalid = Object.values(numbers).some(value => !Number.isSafeInteger(value) || value < 0)
    || (report && numbers.outside > report.expenses);
  const expenseCash = report ? report.expenses - numbers.outside : 0;
  const expected = report ? numbers.opening + report.cash - expenseCash - numbers.withdrawn : 0;
  const difference = numbers.counted - expected;
  function download() {
    if (!report || invalid) return;
    const rows = [
      ['Caja de reparto', range.from, range.to], ['Saldo inicial', numbers.opening],
      ['Efectivo cobrado', report.cash], ['Gastos rendidos', report.expenses],
      ['Gastos fuera de caja', numbers.outside], ['Retiros', numbers.withdrawn],
      ['Efectivo esperado', expected], ['Efectivo contado', values.counted === '' ? 'Sin contar' : numbers.counted],
      ['Diferencia', values.counted === '' ? 'Sin contar' : difference],
      ['Entregas con pago por revisar', report.unresolved.length], [],
      ['Día', 'Efectivo cobrado', 'Gastos rendidos', 'Diferencia antes de ajustes'],
      ...report.byDay.map(row => [row.day, row.cash, row.expenses, row.cash - row.expenses]),
    ];
    const csv = rows.map(row => row.map(value => '"' + String(value).replaceAll('"', '""') + '"').join(';')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a'); link.href = url; link.download = `caja_${range.from}_${range.to}.csv`;
    document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const box = { padding: 16, border: `1px solid ${colors.border}`, borderRadius: 12, background: colors.bgCard };
  const input = { padding: '9px 10px', border: `1px solid ${colors.border}`, borderRadius: 8, background: colors.bgInput, color: colors.textPrimary, colorScheme: 'dark', minWidth: 0 };
  const button = { ...input, cursor: 'pointer' };
  const card = (label, amount, accent = colors.textPrimary) => <div style={box}><div style={{ color: colors.textSecondary, fontSize: 12 }}>{label}</div><strong style={{ display: 'block', fontSize: 24, marginTop: 6, color: accent }}>{invalid ? '—' : clp(amount)}</strong></div>;
  return <div style={{ height: '100%', overflowY: 'auto', padding: 20, boxSizing: 'border-box', color: colors.textPrimary }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
      <div><h3 style={{ margin: 0 }}>Caja de reparto</h3><p style={{ color: colors.textSecondary, margin: '6px 0', fontSize: 13 }}>Compara lo cobrado en efectivo, los gastos y el dinero contado.</p></div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button style={button} onClick={() => apply({ from: today, to: today })}>Hoy</button>
        <button style={button} onClick={() => apply({ from: shift(today, -6), to: today })}>7 días</button>
        <button style={button} onClick={() => apply({ from: today.slice(0,8) + '01', to: today })}>Este mes</button>
      </div>
    </div>
    <div style={{ ...box, display: 'flex', alignItems: 'end', flexWrap: 'wrap', gap: 12, marginBottom: 14 }}>
      {['from','to'].map(key => <label key={key} style={{ display: 'grid', gap: 5, fontSize: 12 }}>{key === 'from' ? 'Desde' : 'Hasta'}<input type="date" style={input} value={draft[key]} onChange={event => setDraft({ ...draft, [key]: event.target.value })}/></label>)}
      <button style={{ ...button, background: colors.green, color: '#fff' }} disabled={loading} onClick={() => apply(draft)}>Aplicar filtro</button>
      <button style={button} disabled={loading} onClick={() => setRefresh(n => n + 1)}>Actualizar</button>
      <button style={button} onClick={onShowExpenses}>Ver gastos</button>
      <button style={button} disabled={!report || loading || invalid} onClick={download}>Descargar caja</button>
    </div>
    {error && <p role="alert" style={{ color: colors.red }}>{error}</p>}
    {loading && <p>Cargando caja…</p>}
    {report && <>
      <p style={{ color: colors.textSecondary, fontSize: 12 }}>Período aplicado: {range.from} a {range.to}. Solo cobros de entregas registradas; las transferencias no suman efectivo.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
        {card('Efectivo cobrado', report.cash, colors.green)}
        {card(`Gastos rendidos (${report.expenseCount})`, report.expenses)}
        {card('Gastos descontados de caja', expenseCash)}
        {card('Efectivo esperado', expected, colors.green)}
      </div>
      {report.unresolved.length > 0 && <p role="status" style={{ color: colors.yellow }}>Saldo provisional: {report.unresolved.length} entrega(s) sin medio de pago o monto de efectivo definido. Revisa sus pagos en Despachos.</p>}
      {report.receipts.some(row => row.approximateDate) && <p style={{ color: colors.textSecondary, fontSize: 12 }}>Algunas entregas antiguas usan la fecha de cierre de la ruta porque no tienen hora de entrega registrada.</p>}
      <div style={{ ...box, marginTop: 14 }}>
        <h4 style={{ margin: '0 0 12px' }}>Arqueo de caja</h4>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 12 }}>
          {[['opening','Saldo inicial del período'],['outside','Gastos pagados fuera de caja'],['withdrawn','Efectivo retirado o entregado'],['counted','Efectivo contado físicamente']].map(([key,label]) => <label key={key} style={{ display: 'grid', gap: 6, fontSize: 12 }}>{label}<input type="number" min="0" step="1" placeholder={key === 'counted' ? 'Ingresa lo que contaste' : '0'} style={input} value={values[key]} onChange={event => setValues({ ...values, [key]: event.target.value })}/></label>)}
        </div>
        <p style={{ color: colors.textSecondary, fontSize: 12 }}>Saldo inicial + efectivo cobrado − gastos de caja − retiros = efectivo esperado. Si dejas «gastos pagados fuera de caja» en cero, se descuentan todos los gastos rendidos.</p>
        {invalid && <p role="alert" style={{ color: colors.red }}>Usa pesos enteros positivos o cero. Los gastos fuera de caja no pueden superar el total de gastos.</p>}
        {!invalid && values.counted !== '' && <strong style={{ color: difference === 0 ? colors.green : colors.yellow, fontSize: 20 }}>{difference === 0 ? 'La caja cuadra' : `${difference > 0 ? 'Sobra' : 'Falta'} ${clp(Math.abs(difference))}`}</strong>}
        <p style={{ color: colors.textMuted, fontSize: 12 }}>Este arqueo es un cálculo de consulta: los montos ingresados no se guardan y se limpian al cambiar el período.</p>
      </div>
      <div style={{ ...box, marginTop: 14, overflowX: 'auto' }}>
        <h4 style={{ marginTop: 0 }}>Efectivo y gastos por día</h4>
        <table style={{ width: '100%', textAlign: 'right', borderCollapse: 'collapse', fontSize: 13 }}><thead><tr><th style={{ textAlign: 'left' }}>Día</th><th>Efectivo cobrado</th><th>Gastos rendidos</th><th>Diferencia</th></tr></thead><tbody>
          {report.byDay.map(row => <tr key={row.day}><td style={{ textAlign: 'left', padding: '10px 0' }}>{row.day}</td><td>{clp(row.cash)}</td><td>{clp(row.expenses)}</td><td>{clp(row.cash - row.expenses)}</td></tr>)}
        </tbody></table>
        <p style={{ color: colors.textMuted, fontSize: 12 }}>Detalle antes de los ajustes manuales del arqueo.</p>
      </div>
      <div style={{ ...box, marginTop: 14 }}><h4 style={{ marginTop: 0 }}>Cobros en efectivo ({report.receipts.length})</h4>
        {!report.receipts.length && <p>No hay cobros en efectivo registrados en este período.</p>}
        {report.receipts.map(row => <div key={row.key} style={{ padding: '10px 0', borderBottom: `1px solid ${colors.border}`, display: 'flex', justifyContent: 'space-between', gap: 12 }}><div>{row.customer} · {row.label}<div style={{ color: colors.textSecondary, fontSize: 12 }}>{row.day} · {row.driver}</div></div><strong>{clp(row.cash)}</strong></div>)}
        {report.unresolved.length > 0 && <p style={{ color: colors.yellow, fontSize: 12 }}>Por revisar: {report.unresolved.map(row => row.label).join(', ')}</p>}
      </div>
    </>}
  </div>;
}
