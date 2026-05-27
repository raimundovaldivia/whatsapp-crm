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

/* ── Badge de estado de pedido ── */
function StatusBadge({ status, colors }) {
  const map = {
    paid:    { label: 'Pagado',    bg: `${colors.green}22`,   color: colors.green },
    draft:   { label: 'Borrador',  bg: `${colors.yellow}22`,  color: colors.yellow },
    sent:    { label: 'Enviado',   bg: `${colors.purple}22`,  color: colors.purple },
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
  const heroRevenue    = useCountUp(data?.week?.revenue    || 0, 1400);
  const heroBotMsgs    = useCountUp(data?.week?.botMessages || 0, 900);
  const heroOrders     = useCountUp(data?.week?.orders      || 0, 800);
  const heroNewConvs   = useCountUp(data?.week?.newConversations || 0, 700);

  /* ── Máximo para el sparkline ── */
  const maxActivity = data
    ? Math.max(...(data.activityByDay || []).map(d => d.inbound + d.bot), 1)
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
            Esta semana
          </span>
          <span style={{ color: colors.textMuted, fontSize: '12px' }}>
            desde el {weekStart}
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

            {/* ── Número héroe: ingresos ── */}
            <div style={{ ...card, background: isDark
              ? `linear-gradient(135deg, ${colors.bgPanel} 0%, #0d2d1a 100%)`
              : `linear-gradient(135deg, ${colors.bgPanel} 0%, #e8f5ee 100%)` }}>
              <div style={{ padding: '28px 28px 24px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontSize: '12px', fontWeight: 600, textTransform: 'uppercase',
                      letterSpacing: '0.8px', color: colors.textMuted, marginBottom: '8px' }}>
                      💰 Ingresos generados por el bot
                    </div>
                    <div style={{ fontSize: loading ? '32px' : '48px', fontWeight: 800,
                      color: colors.green, lineHeight: 1, letterSpacing: '-1px', transition: 'font-size 0.3s' }}>
                      {loading ? '—' : clp(heroRevenue)}
                    </div>
                    <div style={{ fontSize: '13px', color: colors.textSecondary, marginTop: '8px' }}>
                      {loading ? '' : data?.week?.revenue > 0
                        ? 'El bot trabajó por ti esta semana 🤖'
                        : 'Aún sin ventas esta semana — ¡el re-enganche puede cambiar eso!'}
                    </div>
                  </div>
                  {!loading && data?.allTime?.revenue > 0 && (
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontSize: '11px', color: colors.textMuted, marginBottom: '4px' }}>Total histórico</div>
                      <div style={{ fontSize: '20px', fontWeight: 700, color: colors.textSecondary }}>
                        {clp(data.allTime.revenue)}
                      </div>
                      <div style={{ fontSize: '11px', color: colors.textMuted, marginTop: '2px' }}>
                        {data.allTime.orders} pedido{data.allTime.orders !== 1 ? 's' : ''}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* ── 3 stat cards ── */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
              {[
                {
                  icon: <Bot size={18} color={colors.green} />,
                  label: 'Mensajes del bot',
                  value: loading ? '—' : heroBotMsgs,
                  sub:   loading ? '' : `${data?.week?.clientMessages || 0} recibidos de clientes`,
                  accent: colors.green,
                },
                {
                  icon: <Package size={18} color={colors.purple} />,
                  label: 'Pedidos creados',
                  value: loading ? '—' : heroOrders,
                  sub:   loading ? '' : data?.allTime?.orders
                    ? `${data.allTime.orders} en total`
                    : 'esta semana',
                  accent: colors.purple,
                },
                {
                  icon: <MessageSquare size={18} color={colors.yellow} />,
                  label: 'Nuevos clientes',
                  value: loading ? '—' : heroNewConvs,
                  sub:   'conversaciones iniciadas',
                  accent: colors.yellow,
                },
              ].map((s, i) => (
                <div key={i} style={{ ...card, padding: '18px 20px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                    <div style={{ width: '32px', height: '32px', borderRadius: '8px',
                      backgroundColor: `${s.accent}18`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {s.icon}
                    </div>
                    <span style={{ fontSize: '12px', color: colors.textSecondary, fontWeight: 500 }}>
                      {s.label}
                    </span>
                  </div>
                  <div style={{ fontSize: '32px', fontWeight: 800, color: colors.textPrimary, lineHeight: 1 }}>
                    {s.value}
                  </div>
                  <div style={{ fontSize: '11px', color: colors.textMuted, marginTop: '6px' }}>{s.sub}</div>
                </div>
              ))}
            </div>

            {/* ── Sparkline: actividad 7 días ── */}
            {!loading && data?.activityByDay && (
              <div style={card}>
                <div style={{ padding: '16px 20px 0', display: 'flex', alignItems: 'center',
                  justifyContent: 'space-between' }}>
                  <span style={{ fontSize: '13px', fontWeight: 600, color: colors.textPrimary }}>
                    Actividad últimos 7 días
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '14px', fontSize: '11px', color: colors.textMuted }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <span style={{ width: '8px', height: '8px', borderRadius: '2px', backgroundColor: colors.green, display: 'inline-block' }} />
                      Bot respondió
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <span style={{ width: '8px', height: '8px', borderRadius: '2px', backgroundColor: colors.textMuted, display: 'inline-block', opacity: 0.4 }} />
                      Cliente escribió
                    </span>
                  </div>
                </div>
                <div style={{ padding: '12px 20px 16px' }}>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-end' }}>
                    {data.activityByDay.map((d, i) => {
                      const date = new Date(d.date);
                      const dayLabel = DAY_LABELS[date.getDay()];
                      const isToday = i === data.activityByDay.length - 1;
                      return (
                        <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          {/* Barras apiladas: inbound (gris) + bot (verde) */}
                          <div style={{ height: '56px', display: 'flex', flexDirection: 'column',
                            justifyContent: 'flex-end', gap: '1px' }}>
                            {/* inbound */}
                            <div style={{
                              width: '100%', borderRadius: '3px',
                              height: `${maxActivity > 0 ? Math.max((d.inbound / maxActivity) * 28, d.inbound > 0 ? 4 : 0) : 0}px`,
                              backgroundColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)',
                              transition: 'height 0.5s ease',
                            }} />
                            {/* bot */}
                            <div style={{
                              width: '100%', borderRadius: '3px',
                              height: `${maxActivity > 0 ? Math.max((d.bot / maxActivity) * 28, d.bot > 0 ? 4 : 0) : 0}px`,
                              backgroundColor: d.bot > 0 ? colors.green : 'transparent',
                              transition: 'height 0.5s ease',
                            }} />
                          </div>
                          <div style={{ textAlign: 'center', fontSize: '10px',
                            color: isToday ? colors.green : colors.textMuted,
                            fontWeight: isToday ? 700 : 400 }}>
                            {dayLabel}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

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
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{ fontSize: '13px', fontWeight: 600, color: colors.textPrimary,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {order.customerName}
                          </span>
                          <StatusBadge status={order.status} colors={colors} />
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
            {!loading && data?.week?.botMessages === 0 && data?.week?.orders === 0 && (
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
