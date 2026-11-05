import { useEffect, useMemo, useState } from 'react';
import { api } from '../utils/api.js';

const shortDate = value => value ? value.split('-').reverse().join('/') : '—';
const days = value => value == null ? '—' : Number(value).toLocaleString('es-CL') + ' d';

function phoneKey(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return /^9\d{8}$/.test(digits) ? '56' + digits : digits;
}

export function useEggRepurchase(enabled) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let loading = false;
    async function refresh() {
      if (loading || document.hidden) return;
      loading = true;
      try {
        const response = await api.get('/clientes/egg-repurchase');
        if (active) { setData(response.data); setError(''); }
      } catch {
        if (active) setError('No se pudo actualizar la recompra.');
      } finally { loading = false; }
    }
    refresh();
    const timer = setInterval(refresh, 15 * 60 * 1000);
    document.addEventListener('visibilitychange', refresh);
    return () => { active = false; clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [enabled]);
  const byPhone = useMemo(() => {
    const map = new Map((data?.profiles || []).map(p => [p.phone, p]));
    for (const [alias, phone] of Object.entries(data?.aliases || {})) map.set(alias, map.get(phone));
    return map;
  }, [data]);
  return { data, error, find: phone => byPhone.get(phoneKey(phone)) };
}

function status(p) {
  if (p.optOut) return 'Baja comercial';
  if (p.hasOrder) return 'Pedido reciente o en curso';
  if (p.recentOutreach) return 'Campaña en últimas 48 h';
  if (p.purchaseDays < 3) return 'Historial limitado';
  if (p.irregular) return 'Intervalo variable';
  return p.due ? 'En fecha' : 'Fuera de su ventana';
}

export function EggPurchaseDetail({ report, phone, colors }) {
  const p = report.find(phone);
  return (
    <div style={{ color: colors.textPrimary, fontSize: 13, maxWidth: 340 }}>
      <strong>Recompra de huevos</strong>
      <div>{report.error || (!report.data ? 'Calculando…' : !p ? 'Sin compras de huevos verificadas.' :
        p.orders + ' pedidos en ' + p.purchaseDays + ' días distintos · Última compra ' + shortDate(p.lastDate))}</div>
      {p && <div style={{ color: colors.textSecondary }}>Intervalo habitual {days(p.interval)} · Han pasado {days(p.elapsed)} · Próxima estimada {shortDate(p.expected)} · {status(p)}</div>}
    </div>
  );
}

export function EggRepurchaseList({ report, search, colors }) {
  const [all, setAll] = useState(false);
  const { data, error } = report;
  const normalize = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const query = normalize(search.trim());
  const profiles = (data?.profiles || []).filter(p => (all || p.due) && (!query || normalize(p.name).includes(query) || p.phone.includes(query)));
  const cell = { padding: '9px 12px', borderBottom: '1px solid ' + colors.border, textAlign: 'left' };
  return (
    <section style={{ overflow: 'auto', padding: 16, color: colors.textPrimary }}>
      <label>Mostrar <select value={all ? 'all' : 'due'} onChange={e => setAll(e.target.value === 'all')}>
        <option value="due">En fecha de recompra</option><option value="all">Todos los compradores de huevos</option>
      </select></label>
      {data && <p style={{ color: colors.textSecondary }}>{profiles.length} clientes · Al {shortDate(data.day)} · Mediana de los últimos cinco intervalos disponibles entre días de compra.</p>}
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p>Calculando la frecuencia de compra…</p>}
      {data && (profiles.length ? <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
        <thead><tr>{['Cliente', 'Pedidos', 'Días de compra', 'Última compra', 'Intervalo', 'Días desde la compra', 'Próxima estimada', 'Último formato', 'Situación'].map(label => <th key={label} scope="col" style={cell}>{label}</th>)}</tr></thead>
        <tbody>{profiles.map(p => <tr key={p.phone}>
          <td style={cell}>{p.name}<div style={{ color: colors.textSecondary }}>{p.phone}</div></td>
          {[p.orders, p.purchaseDays, shortDate(p.lastDate), days(p.interval), p.elapsed, shortDate(p.expected), p.lastProduct, status(p)].map((value,i) => <td key={i} style={cell}>{value}</td>)}
        </tr>)}</tbody>
      </table> : <p>Sin clientes para esta selección.</p>)}
    </section>
  );
}
