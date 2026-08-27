/**
 * DashboardPanel — Dashboard de victorias (Hooked: variable reward)
 *
 * Muestra al dueño de la tienda lo que el bot hizo por él esta semana:
 * ingresos, pedidos, conversaciones manejadas, feed de victorias recientes.
 */

import { useState, useEffect, useRef } from 'react';
import {
  TrendingUp, Package, MessageSquare, Bot,
  RefreshCw, ShoppingBag, Zap, ChevronRight,
} from 'lucide-react';
import { dashboardAPI } from '../utils/api.js';
import { useTheme } from '../theme.js';

/* ── Animación de número contando hacia arriba ── */
function useCountUp(target, duration = 1200) {
  const [value, setValue] = useState(0);
  const raf = useRef(null);
  useEffect(() => {
    if (!target) { setValue(0); return; }
    const start    = performance.now();
    const from     = 0;
    const to       = target;
    const animate  = (now) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(Math.round(from + (to - from) * eased));
      if (progress < 1) raf.current = requestAnimationFrame(animate);
    };
    raf.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(raf.current);
  }, [target, duration]);
  return value;
}

/* ── Formatear CLP ── */
const clp = (n) => `$${Number(n).toLocaleString('es-CL')}`;

/* ── Tiempo relativo ── */
function timeAgo(dateStr) {
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 60)       return 'hace un momento';
  if (diff < 3600)     return `hace ${Math.floor(diff / 60)} min`;
  if (diff < 86400)    return `hace ${Math.floor(diff / 3600)}h`;
  if (diff < 172800)   return 'ayer';
  return `hace ${Math.floor(diff / 86400)} días`;
}

/* ── Mini barra del sparkline ── */
function Bar({ value, max, color, colors }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px', flex: 1 }}>
      <div style={{ width: '100%', height: '48px', display: 'flex', alignItems: 'flex-end' }}>
        <div style={{
          width: '100%', borderRadius: '4px 4px 0 0',
          height: `${Math.max(pct, value > 0 ? 8 : 2)}%`,
          backgroundColor: value > 0 ? color : colors.border,
          transition: 'height 0.5s ease',
          minHeight: '2px',
        }} />
      </div>
    </div>
  );
}

/* ── Delta % vs semana anterior ── */
function Delta({ current, prev, colors }) {
  if (!prev || prev === 0) return null;
  const pct = Math.round(((current - prev) / prev) * 100);
  if (pct === 0) return null;
  const up = pct > 0;
  return (
    <span style={{
      fontSize: '11px', fontWeight: 700, marginLeft: '6px',
      color: up ? colors.green : colors.red,
      backgroundColor: up ? `${colors.green}18` : `${colors.red}18`,
      padding: '2px 6px', borderRadius: '6px',
    }}>
      {up ? '↑' : '↓'}{Math.abs(pct)}% vs sem. ant.
    </span>
  );
}

/* ── Barra del sparkline con tooltip ── */
function SparklineBar({ d, dayLabel, isToday, maxActivity, colors, isDark }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px', position: 'relative' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {/* Tooltip */}
      {hover && (d.bot > 0 || d.inbound > 0) && (
        <div style={{
          position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)',
          backgroundColor: colors.bgPanel, border: `1px solid ${colors.border}`,
          borderRadius: '7px', padding: '6px 10px', zIndex: 100,
          boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
          whiteSpace: 'nowrap', pointerEvents: 'none', marginBottom: '4px',
          fontSize: '11px', color: colors.textSecondary, lineHeight: 1.6,
          textAlign: 'center',
        }}>
          <div style={{ color: colors.green, fontWeight: 700 }}>🤖 {d.bot} bot</div>
          <div>👤 {d.inbound} cliente</div>
        </div>
      )}
      {/* Barras apiladas */}
      <div style={{ height: '56px', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: '1px' }}>
        <div style={{
          width: '100%', borderRadius: '3px',
          height: `${maxActivity > 0 ? Math.max((d.inbound / maxActivity) * 28, d.inbound > 0 ? 4 : 0) : 0}px`,
          backgroundColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)',
          transition: 'height 0.5s ease',
        }} />
        <div style={{
          width: '100%', borderRadius: '3px',
          height: `${maxActivity > 0 ? Math.max((d.bot / maxActivity) * 28, d.bot > 0 ? 4 : 0) : 0}px`,
          backgroundColor: d.bot > 0 ? (hover ? colors.greenLight : colors.green) : 'transparent',
          transition: 'height 0.5s ease, background-color 0.15s',
        }} />
      </div>
      <div style={{ textAlign: 'center', fontSize: '10px', color: isToday ? colors.green : colors.textMuted, fontWeight: isToday ? 700 : 400 }}>
        {dayLabel}
      </div>
    </div>
  );
}

/* ── Badge de estado de pedido ── */
function StatusBadge({ status, colors }) {
  const map = {
    paid:    { label: 'Pagado',    bg: `${colors.green}22`,   color: colors.green },
    draft:   { label: 'Nuevo',     bg: `${colors.purple}22`,  color: colors.purple },
    sent:    { label: 'Nuevo',     bg: `${colors.purple}22`,  color: colors.purple },
    pending: { label: 'Pendiente', bg: `${colors.yellow}22`,  color: colors.yellow },
    cancelled:{ label: 'Cancelado', bg: '#2d1a1a',            color: colors.red },
  };
  const s = map[status] || map.draft;
  return (
    <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 7px', borderRadius: '20px',
      backgroundColor: s.bg, color: s.color, border: `1px solid ${s.color}44`, flexShrink: 0 }}>
      {s.label}
    </span>
  );
}

export default function DashboardPanel({ onChangeView }) {
  const { colors, isDark } = useTheme();
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState('');

  const load = async () => {
    setLoading(true); setError('');
    try {
      const d = await dashboardAPI.getWins();
      setData(d);
    } catch (e) {
      setError('Error cargando métricas');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  /* ── Número héroe animado ── */
  const heroTodayRevenue = useCountUp(data?.today?.revenue  || 0, 1400);
  const heroWeekRevenue  = useCountUp(data?.week?.revenue   || 0, 1200);
  const heroBotMsgs      = useCountUp(data?.week?.botMessages || 0, 900);
  const heroNewConvs     = useCountUp(data?.week?.newConversations || 0, 700);

  /* ── Máximo para el sparkline de ventas ── */
  const maxRevenue = data
    ? Math.max(...(data.dailySales || []).map(d => d.revenue), 1)
    : 1;

  const DAY_LABELS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

  /* ── Estilos base ── */
  const card = {
    backgroundColor: colors.bgPanel,
    borderRadius: '14px',
    border: `1px solid ${colors.border}`,
    overflow: 'hidden',
  };

  /* ── Fecha de inicio de semana ── */
  const weekStart = (() => {
    const d = new Date();
    d.setDate(d.getDate() - d.getDay() + (d.getDay() === 0 ? -6 : 1)); // lunes
    return d.toLocaleDateString('es-CL', { day: 'numeric', month: 'short' });
  })();

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100vh',
      backgroundColor: colors.bgApp, overflow: 'hidden' }}>

      {/* ── Header ── */}
      <div style={{ padding: '14px 24px', backgroundColor: colors.bgPanel,
        borderBottom: `1px solid ${colors.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Zap size={18} color={colors.yellow} />
          <span style={{ color: colors.textPrimary, fontSize: '16px', fontWeight: 700 }}>
            Resumen
          </span>
          <span style={{ color: colors.textMuted, fontSize: '12px' }}>
            {new Date().toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' })}
          </span>
        </div>
        <button onClick={load}
          style={{ background: 'none', border: 'none', color: colors.textSecondary,
            cursor: 'pointer', padding: '6px', borderRadius: '8px', display: 'flex',
            transition: 'background 0.15s' }}
          onMouseEnter={e => e.currentTarget.style.background = colors.borderStrong}
          onMouseLeave={e => e.currentTarget.style.background = 'none'}>
          <RefreshCw size={15} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
        {error ? (
          <div style={{ textAlign: 'center', padding: '60px', color: colors.textSecondary }}>
            {error}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '860px' }}>

            {/* ── Hero: ventas del día ── */}
            <div style={{ ...card, background: isDark
              ? `linear-gradient(135deg, ${colors.bgPanel} 0%, #0d2d1a 100%)`
              : `linear-gradient(135deg, ${colors.bgPanel} 0%, #e8f5ee 100%)` }}>
              <div style={{ padding: '28px 28px 24px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontSize: '12px', fontWeight: 600, textTransform: 'uppercase',
                      letterSpacing: '0.8px', color: colors.textMuted, marginBottom: '8px' }}>
                      📦 Ventas de hoy
                    </div>
                    <div style={{ fontSize: loading ? '32px' : '48px', fontWeight: 800,
                      color: colors.green, lineHeight: 1, letterSpacing: '-1px', transition: 'font-size 0.3s' }}>
                      {loading ? '—' : clp(heroTodayRevenue)}
                    </div>
                    <div style={{ fontSize: '13px', color: colors.textSecondary, marginTop: '8px', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px' }}>
                      {loading ? '' : `${data?.today?.orders || 0} pedido${(data?.today?.orders || 0) !== 1 ? 's' : ''} hoy (bot + Shopify)`}
                    </div>
                  </div>
                  {!loading && (
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontSize: '11px', color: colors.textMuted, marginBottom: '4px' }}>Esta semana</div>
                      <div style={{ fontSize: '20px', fontWeight: 700, color: colors.textSecondary }}>
                        {clp(heroWeekRevenue)}
                      </div>
                      <div style={{ fontSize: '11px', color: colors.textMuted, marginTop: '2px' }}>
                        {data?.week?.orders || 0} pedido{(data?.week?.orders || 0) !== 1 ? 's' : ''}
                        <Delta current={data?.week?.revenue || 0} prev={data?.lastWeek?.revenue || 0} colors={colors} />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* ── Sparkline: ventas por día (últimos 7) ── */}
            {!loading && data?.dailySales && (
              <div style={card}>
                <div style={{ padding: '16px 20px 0', display: 'flex', alignItems: 'center',
                  justifyContent: 'space-between' }}>
                  <span style={{ fontSize: '13px', fontWeight: 600, color: colors.textPrimary }}>
                    Ventas últimos 7 días
                  </span>
                  <span style={{ fontSize: '11px', color: colors.textMuted }}>Bot + Shopify</span>
                </div>
                <div style={{ padding: '12px 20px 16px' }}>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-end' }}>
                    {data.dailySales.map((d, i) => {
                      const date = new Date(d.date);
                      const dayLabel = DAY_LABELS[date.getDay()];
                      const isToday = i === data.dailySales.length - 1;
                      const pct = maxRevenue > 0 ? (d.revenue / maxRevenue) * 100 : 0;
                      return (
                        <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px', position: 'relative' }}
                          title={`${dayLabel}: ${clp(d.revenue)} (${d.orders} pedidos)`}>
                          <div style={{ height: '56px', display: 'flex', alignItems: 'flex-end' }}>
                            <div style={{
                              width: '100%', borderRadius: '3px 3px 0 0',
                              height: `${Math.max(pct, d.revenue > 0 ? 8 : 2)}%`,
                              backgroundColor: isToday ? colors.green : (d.revenue > 0 ? `${colors.green}88` : colors.border),
                              transition: 'height 0.5s ease',
                              minHeight: '2px',
                            }} />
                          </div>
                          <div style={{ textAlign: 'center', fontSize: '10px',
                            color: isToday ? colors.green : colors.textMuted,
                            fontWeight: isToday ? 700 : 400 }}>
                            {dayLabel}
                          </div>
                          {d.revenue > 0 && (
                            <div style={{ textAlign: 'center', fontSize: '9px', color: colors.textSecondary }}>
                              {clp(d.revenue)}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* ── 2 stat cards: bot + clientes ── */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px' }}>
              {[
                {
                  icon: <Bot size={18} color={colors.green} />,
                  label: 'Mensajes del bot',
                  value: loading ? '—' : heroBotMsgs,
                  sub:   loading ? '' : `${data?.week?.clientMessages || 0} recibidos de clientes`,
                  accent: colors.green,
                  delta: { curr: data?.week?.botMessages || 0, prev: data?.lastWeek?.botMessages || 0 },
                },
                {
                  icon: <MessageSquare size={18} color={colors.yellow} />,
                  label: 'Nuevos clientes',
                  value: loading ? '—' : heroNewConvs,
                  sub:   'conversaciones iniciadas esta semana',
                  accent: colors.yellow,
                  delta: { curr: data?.week?.newConversations || 0, prev: data?.lastWeek?.newConversations || 0 },
                },
              ].map((s, i) => (
                <div key={i} style={{ ...card, padding: '18px 20px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                    <div style={{ width: '32px', height: '32px', borderRadius: '8px',
                      backgroundColor: `${s.accent}18`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {s.icon}
                    </div>
                    <span style={{ fontSize: '12px', color: colors.textSecondary, fontWeight: 500 }}>{s.label}</span>
                  </div>
                  <div style={{ fontSize: '32px', fontWeight: 800, color: colors.textPrimary, lineHeight: 1 }}>{s.value}</div>
                  <div style={{ fontSize: '11px', color: colors.textMuted, marginTop: '6px', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px' }}>
                    {s.sub}
                    {!loading && <Delta current={s.delta.curr} prev={s.delta.prev} colors={colors} />}
                  </div>
                </div>
              ))}
            </div>

            {/* ── Feed de victorias recientes ── */}
            <div style={card}>
              <div style={{ padding: '14px 20px', borderBottom: `1px solid ${colors.border}`,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <ShoppingBag size={15} color={colors.purple} />
                  <span style={{ fontSize: '13px', fontWeight: 600, color: colors.textPrimary }}>
                    Últimos pedidos
                  </span>
                </div>
                <button onClick={() => onChangeView?.('orders')}
                  style={{ background: 'none', border: 'none', cursor: 'pointer',
                    color: colors.textMuted, fontSize: '11px', display: 'flex',
                    alignItems: 'center', gap: '3px', padding: 0 }}
                  onMouseEnter={e => e.currentTarget.style.color = colors.textPrimary}
                  onMouseLeave={e => e.currentTarget.style.color = colors.textMuted}>
                  Ver todos <ChevronRight size={12} />
                </button>
              </div>

              {loading ? (
                <div style={{ padding: '24px', textAlign: 'center', color: colors.textMuted, fontSize: '13px' }}>
                  Cargando...
                </div>
              ) : !data?.recentOrders?.length ? (
                <div style={{ padding: '32px 20px', textAlign: 'center' }}>
                  <Package size={32} style={{ color: colors.textMuted, opacity: 0.3, margin: '0 auto 12px' }} />
                  <div style={{ color: colors.textSecondary, fontSize: '14px', fontWeight: 500 }}>
                    Aún no hay pedidos
                  </div>
                  <div style={{ color: colors.textMuted, fontSize: '12px', marginTop: '4px' }}>
                    Tu primera venta está a un mensaje de distancia
                  </div>
                  <button onClick={() => onChangeView?.('reengagement')}
                    style={{ marginTop: '14px', padding: '8px 18px', borderRadius: '8px',
                      backgroundColor: `${colors.green}18`, color: colors.green,
                      border: `1px solid ${colors.green}44`, cursor: 'pointer',
                      fontSize: '12px', fontWeight: 600 }}>
                    Enviar re-enganche →
                  </button>
                </div>
              ) : (
                <div>
                  {data.recentOrders.map((order, i) => (
                    <div key={order.id}
                      style={{ padding: '13px 20px', display: 'flex', alignItems: 'center',
                        gap: '12px', borderBottom: i < data.recentOrders.length - 1
                          ? `1px solid ${colors.border}` : 'none' }}>
                      {/* Ícono */}
                      <div style={{ width: '34px', height: '34px', borderRadius: '10px',
                        backgroundColor: `${colors.purple}18`, display: 'flex',
                        alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <Package size={16} color={colors.purple} />
                      </div>
                      {/* Info */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ fontSize: '13px', fontWeight: 600, color: colors.textPrimary,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {order.customerName}
                          </span>
                          <StatusBadge status={order.status} colors={colors} />
                          <span style={{
                            display: 'flex', alignItems: 'center', gap: '3px',
                            fontSize: '10px', fontWeight: 700, padding: '2px 6px', borderRadius: '20px',
                            backgroundColor: order.source === 'bot' ? `${colors.green}18` : '#0d2929',
                            color: order.source === 'bot' ? colors.green : '#4db6ac',
                            border: `1px solid ${order.source === 'bot' ? colors.green : '#4db6ac'}33`,
                            flexShrink: 0,
                          }}>
                            {order.source === 'bot' ? <><Bot size={9} /> Bot</> : '🛍️ Shopify'}
                          </span>
                        </div>
                        <div style={{ fontSize: '11px', color: colors.textMuted, marginTop: '2px' }}>
                          {timeAgo(order.createdAt)}
                        </div>
                      </div>
                      {/* Monto */}
                      <div style={{ fontSize: '15px', fontWeight: 700, color: colors.green, flexShrink: 0 }}>
                        {clp(order.totalPrice)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── CTA si no hay actividad ── */}
            {!loading && data?.week?.botMessages === 0 && data?.week?.revenue === 0 && (
              <div style={{ ...card, padding: '20px', display: 'flex', alignItems: 'center',
                gap: '16px', backgroundColor: `${colors.yellow}0d`,
                border: `1px solid ${colors.yellow}33` }}>
                <TrendingUp size={24} color={colors.yellow} style={{ flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '14px', fontWeight: 600, color: colors.textPrimary, marginBottom: '2px' }}>
                    Semana tranquila
                  </div>
                  <div style={{ fontSize: '12px', color: colors.textSecondary }}>
                    Usa el re-enganche para activar clientes que no han comprado recientemente.
                  </div>
                </div>
                <button onClick={() => onChangeView?.('reengagement')}
                  style={{ padding: '9px 16px', borderRadius: '9px', backgroundColor: colors.yellow,
                    color: '#1a1a1a', border: 'none', cursor: 'pointer',
                    fontSize: '12px', fontWeight: 700, flexShrink: 0, whiteSpace: 'nowrap' }}>
                  Re-enganchar →
                </button>
              </div>
            )}

          </div>
        )}
      </div>
    </div>
  );
}
