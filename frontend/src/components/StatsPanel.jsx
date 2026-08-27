/**
 * StatsPanel — Estadísticas de ventas de la empresa
 * Usa los mismos datos que OrdersPanel (shopify_orders cargados en frontend)
 * para evitar doble conteo y mantenerse consistente.
 */

import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, DollarSign, ShoppingBag, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { ordersAPI, api } from '../utils/api.js';
import { useTheme } from '../theme.js';

const clp = (n) => `$${Number(n || 0).toLocaleString('es-CL')}`;

// Solo suma shopify_orders, excluye voided/refunded (igual que OrdersPanel)
function sumarValidos(orders) {
  return orders.reduce((sum, o) => {
    if (o.source === 'bot') return sum;
    const fs = (o.financialStatus || '').toUpperCase();
    if (fs === 'VOIDED' || fs === 'REFUNDED') return sum;
    return sum + (Number(o.total) || 0);
  }, 0);
}

// Normalizar shopify order (igual que OrdersPanel)
function normalizeShopify(o) {
  return {
    source: 'shopify',
    date: o.shopify_created_at ? new Date(o.shopify_created_at) : new Date(0),
    total: Number(o.total_price || 0),
    financialStatus: (o.financial_status || '').toUpperCase(),
    fulfillmentStatus: (o.fulfillment_status || '').toUpperCase(),
    items: Array.isArray(o.items) ? o.items : [],
  };
}

// Agrupar por día local (sin conversión UTC)
function groupByDay(orders) {
  const map = {};
  orders.forEach(o => {
    const d = o.date;
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    if (!map[key]) map[key] = { revenue: 0, count: 0 };
    const fs = o.financialStatus;
    if (fs !== 'VOIDED' && fs !== 'REFUNDED') {
      map[key].revenue += o.total;
      map[key].count++;
    }
  });
  return map;
}

// Generar rango de días (hacia atrás desde hoy)
function dayRange(days) {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Santiago' }));
  const result = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    result.push({ key, label: d.toLocaleDateString('es-CL', { day: 'numeric', month: 'short' }) });
  }
  return result;
}

function Trend({ current, prev }) {
  if (!prev) return null;
  const pct = prev === 0 ? 100 : Math.round(((current - prev) / prev) * 100);
  const up = pct > 0;
  const flat = pct === 0;
  return (
    <span style={{ fontSize: '11px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '2px',
      color: flat ? '#888' : up ? '#4ade80' : '#f87171' }}>
      {flat ? <Minus size={11} /> : up ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
      {flat ? '0%' : `${up ? '+' : ''}${pct}%`}
    </span>
  );
}

export default function StatsPanel() {
  const { colors } = useTheme();
  const [shopifyOrders, setShopifyOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [chartDays, setChartDays] = useState(30);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/orders/shopify').catch(() => ({ data: { orders: [] } }));
      setShopifyOrders((res.data?.orders || []).map(normalizeShopify));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.textSecondary }}>
        <RefreshCw size={20} style={{ animation: 'spin 1s linear infinite' }} />
      </div>
    );
  }

  // Períodos en hora local Chile
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Santiago' }));
  const todayKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay() + (now.getDay() === 0 ? -6 : 1)); // lunes
  startOfWeek.setHours(0,0,0,0);

  const startOfLastWeek = new Date(startOfWeek);
  startOfLastWeek.setDate(startOfLastWeek.getDate() - 7);

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

  const inRange = (o, from, to) => o.date >= from && (!to || o.date <= to);

  const todayOrders    = shopifyOrders.filter(o => {
    const d = o.date;
    const k = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    return k === todayKey;
  });
  const weekOrders     = shopifyOrders.filter(o => inRange(o, startOfWeek));
  const lastWeekOrders = shopifyOrders.filter(o => inRange(o, startOfLastWeek, new Date(startOfWeek.getTime() - 1)));
  const monthOrders    = shopifyOrders.filter(o => inRange(o, startOfMonth));
  const lastMonthOrders= shopifyOrders.filter(o => inRange(o, startOfLastMonth, endOfLastMonth));

  const ventasHoy      = sumarValidos(todayOrders);
  const pedidosHoy     = todayOrders.filter(o => o.financialStatus !== 'VOIDED' && o.financialStatus !== 'REFUNDED').length;
  const ventasSemana   = sumarValidos(weekOrders);
  const pedidosSemana  = weekOrders.filter(o => o.financialStatus !== 'VOIDED' && o.financialStatus !== 'REFUNDED').length;
  const ventasUltSem   = sumarValidos(lastWeekOrders);
  const ventasMes      = sumarValidos(monthOrders);
  const pedidosMes     = monthOrders.filter(o => o.financialStatus !== 'VOIDED' && o.financialStatus !== 'REFUNDED').length;
  const ventasUltMes   = sumarValidos(lastMonthOrders);

  // Ticket promedio del mes
  const ticketMes = pedidosMes > 0 ? Math.round(ventasMes / pedidosMes) : 0;

  // Gráfico de barras
  const days = dayRange(chartDays);
  const dayMap = groupByDay(shopifyOrders);
  const maxRevenue = Math.max(...days.map(d => dayMap[d.key]?.revenue || 0), 1);

  // Distribución por estado financiero
  const statusCount = {};
  shopifyOrders.filter(o => inRange(o, startOfMonth)).forEach(o => {
    const s = o.financialStatus || 'UNKNOWN';
    statusCount[s] = (statusCount[s] || 0) + 1;
  });

  const statusStyles = {
    PAID:               { label: 'Pagado',      color: '#4ade80' },
    PENDING:            { label: 'Pendiente',   color: '#facc15' },
    REFUNDED:           { label: 'Reembolsado', color: '#94a3b8' },
    PARTIALLY_REFUNDED: { label: 'Rem. parcial',color: '#94a3b8' },
    VOIDED:             { label: 'Anulado',     color: '#f87171' },
    AUTHORIZED:         { label: 'Autorizado',  color: '#4db6ac' },
  };

  const card = (icon, label, value, sub, prev, current) => (
    <div style={{ backgroundColor: colors.bgPanel, borderRadius: '12px', padding: '16px 18px', border: `1px solid ${colors.border}`, display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        {icon}
        <span style={{ fontSize: '11px', color: colors.textSecondary }}>{label}</span>
      </div>
      <div style={{ fontSize: '22px', fontWeight: 700, color: colors.textPrimary }}>{value}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ fontSize: '11px', color: colors.textSecondary }}>{sub}</span>
        <Trend current={current} prev={prev} />
      </div>
    </div>
  );

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', backgroundColor: colors.bg }}>
      {/* Header */}
      <div style={{ padding: '16px 24px', borderBottom: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <div>
          <div style={{ fontSize: '16px', fontWeight: 700, color: colors.textPrimary }}>Estadísticas</div>
          <div style={{ fontSize: '11px', color: colors.textSecondary }}>
            {now.toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
          </div>
        </div>
        <button onClick={load} style={{ background: 'none', border: 'none', color: colors.textSecondary, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
          <RefreshCw size={14} /> Actualizar
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>

        {/* Cards resumen */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
          {card(<DollarSign size={16} color={colors.green} />, 'Ventas hoy', clp(ventasHoy), `${pedidosHoy} pedidos`, null, null)}
          {card(<DollarSign size={16} color='#a78bfa' />, 'Esta semana', clp(ventasSemana), `${pedidosSemana} pedidos`, ventasUltSem, ventasSemana)}
          {card(<DollarSign size={16} color='#4db6ac' />, 'Este mes', clp(ventasMes), `${pedidosMes} pedidos`, ventasUltMes, ventasMes)}
          {card(<ShoppingBag size={16} color={colors.yellow} />, 'Ticket promedio', clp(ticketMes), 'este mes', null, null)}
        </div>

        {/* Gráfico de barras */}
        <div style={{ backgroundColor: colors.bgPanel, borderRadius: '12px', padding: '18px', border: `1px solid ${colors.border}` }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: colors.textPrimary }}>Ventas por día</span>
            <div style={{ display: 'flex', gap: '6px' }}>
              {[7, 14, 30].map(d => (
                <button key={d} onClick={() => setChartDays(d)}
                  style={{ padding: '3px 10px', borderRadius: '20px', fontSize: '11px', cursor: 'pointer', border: `1px solid ${chartDays === d ? colors.green : colors.border}`, backgroundColor: chartDays === d ? `${colors.green}20` : 'transparent', color: chartDays === d ? colors.green : colors.textSecondary }}>
                  {d}d
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '3px', height: '120px' }}>
            {days.map(({ key, label }) => {
              const rev = dayMap[key]?.revenue || 0;
              const pct = maxRevenue > 0 ? (rev / maxRevenue) * 100 : 0;
              const isToday = key === todayKey;
              return (
                <div key={key} title={`${label}: ${clp(rev)}`}
                  style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', height: '100%', justifyContent: 'flex-end' }}>
                  <div style={{
                    width: '100%', borderRadius: '3px 3px 0 0',
                    height: `${Math.max(pct, rev > 0 ? 4 : 1)}%`,
                    backgroundColor: isToday ? colors.green : `${colors.green}66`,
                    transition: 'height 0.3s ease',
                  }} />
                  {(chartDays <= 14 || key.endsWith('-01') || key.endsWith('-08') || key.endsWith('-15') || key.endsWith('-22')) && (
                    <span style={{ fontSize: '9px', color: colors.textSecondary, whiteSpace: 'nowrap', transform: 'rotate(-45deg)', transformOrigin: 'center', marginTop: '2px' }}>
                      {label}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Fila inferior: comparativa semanas + distribución estados */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>

          {/* Comparativa semana actual vs anterior */}
          <div style={{ backgroundColor: colors.bgPanel, borderRadius: '12px', padding: '18px', border: `1px solid ${colors.border}` }}>
            <div style={{ fontSize: '13px', fontWeight: 600, color: colors.textPrimary, marginBottom: '14px' }}>Semana actual vs anterior</div>
            {[
              { label: 'Esta semana',  value: ventasSemana, pedidos: pedidosSemana },
              { label: 'Sem. pasada', value: ventasUltSem,  pedidos: lastWeekOrders.filter(o => o.financialStatus !== 'VOIDED' && o.financialStatus !== 'REFUNDED').length },
            ].map(({ label, value, pedidos }) => {
              const maxVal = Math.max(ventasSemana, ventasUltSem, 1);
              const pct = (value / maxVal) * 100;
              return (
                <div key={label} style={{ marginBottom: '12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <span style={{ fontSize: '12px', color: colors.textSecondary }}>{label}</span>
                    <span style={{ fontSize: '12px', fontWeight: 600, color: colors.textPrimary }}>{clp(value)} <span style={{ color: colors.textSecondary, fontWeight: 400 }}>({pedidos} ped.)</span></span>
                  </div>
                  <div style={{ height: '6px', borderRadius: '4px', backgroundColor: colors.bgHover }}>
                    <div style={{ height: '100%', borderRadius: '4px', width: `${pct}%`, backgroundColor: label.includes('pasada') ? `${colors.green}55` : colors.green, transition: 'width 0.4s ease' }} />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Distribución de estados este mes */}
          <div style={{ backgroundColor: colors.bgPanel, borderRadius: '12px', padding: '18px', border: `1px solid ${colors.border}` }}>
            <div style={{ fontSize: '13px', fontWeight: 600, color: colors.textPrimary, marginBottom: '14px' }}>Estado de pedidos (este mes)</div>
            {Object.entries(statusCount).sort((a,b) => b[1]-a[1]).map(([status, count]) => {
              const total = Object.values(statusCount).reduce((s,n) => s+n, 0);
              const pct = total > 0 ? Math.round((count / total) * 100) : 0;
              const st = statusStyles[status] || { label: status, color: '#94a3b8' };
              return (
                <div key={status} style={{ marginBottom: '10px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <span style={{ fontSize: '12px', color: colors.textSecondary }}>{st.label}</span>
                    <span style={{ fontSize: '12px', fontWeight: 600, color: colors.textPrimary }}>{count} <span style={{ color: colors.textSecondary, fontWeight: 400 }}>({pct}%)</span></span>
                  </div>
                  <div style={{ height: '6px', borderRadius: '4px', backgroundColor: colors.bgHover }}>
                    <div style={{ height: '100%', borderRadius: '4px', width: `${pct}%`, backgroundColor: st.color, transition: 'width 0.4s ease' }} />
                  </div>
                </div>
              );
            })}
            {Object.keys(statusCount).length === 0 && (
              <div style={{ color: colors.textSecondary, fontSize: '12px' }}>Sin datos este mes</div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
