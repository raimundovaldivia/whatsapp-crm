import { useState, useEffect, useCallback } from 'react';
import { formatDateTime } from '../utils/dates.js';
import {
  ShoppingBag, RefreshCw, ExternalLink, Send, RotateCcw,
  CheckCircle, Clock, XCircle, Package, DollarSign, Bot, Store,
} from 'lucide-react';
import { ordersAPI, api } from '../utils/api.js';

// ─── Configuración de estados ─────────────────────────────────────
const BOT_STATUS = {
  draft:     { label: 'Borrador',  color: '#8696a0', bg: '#2a3942' },
  sent:      { label: 'Pendiente', color: '#f0b429', bg: '#2e2100' },
  paid:      { label: 'Pagado',    color: '#00a884', bg: '#0d2e25' },
  cancelled: { label: 'Cancelado', color: '#e57373', bg: '#2d1a1a' },
  failed:    { label: 'Fallido',   color: '#e57373', bg: '#2d1a1a' },
};

const SHOPIFY_FINANCIAL = {
  PAID:             { label: 'Pagado',        color: '#00a884', bg: '#0d2e25' },
  PENDING:          { label: 'Pendiente',     color: '#f0b429', bg: '#2e2100' },
  REFUNDED:         { label: 'Reembolsado',   color: '#8696a0', bg: '#2a3942' },
  PARTIALLY_REFUNDED: { label: 'Rem. parcial', color: '#8696a0', bg: '#2a3942' },
  VOIDED:           { label: 'Anulado',       color: '#e57373', bg: '#2d1a1a' },
  AUTHORIZED:       { label: 'Autorizado',    color: '#4db6ac', bg: '#0d2929' },
};

const SHOPIFY_FULFILLMENT = {
  FULFILLED:         { label: 'Enviado',      color: '#00a884' },
  UNFULFILLED:       { label: 'Sin enviar',   color: '#f0b429' },
  PARTIAL:           { label: 'Parcial',      color: '#f0b429' },
  RESTOCKED:         { label: 'Devuelto',     color: '#8696a0' },
  IN_PROGRESS:       { label: 'En proceso',   color: '#4db6ac' },
  SCHEDULED:         { label: 'Programado',   color: '#8696a0' },
};

// ─── Componente principal ─────────────────────────────────────────
export default function OrdersPanel({ onSelectConversation, onOrderPaid }) {
  const [tab, setTab] = useState('bot'); // 'bot' | 'shopify'

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100vh', backgroundColor: '#0b141a', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding: '14px 24px', backgroundColor: '#202c33',
        borderBottom: '1px solid #2a3942',
        display: 'flex', alignItems: 'center', gap: '16px',
      }}>
        <ShoppingBag size={20} color="#00a884" />
        <h1 style={{ color: '#e9edef', fontSize: '17px', fontWeight: 600 }}>Pedidos</h1>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: '4px', marginLeft: '8px', backgroundColor: '#111b21', borderRadius: '10px', padding: '4px' }}>
          {[
            { key: 'bot',     label: 'Del Bot',  icon: <Bot size={14} /> },
            { key: 'shopify', label: 'Shopify',  icon: <Store size={14} /> },
          ].map(({ key, label, icon }) => (
            <button key={key} onClick={() => setTab(key)}
              style={{
                display: 'flex', alignItems: 'center', gap: '6px',
                padding: '6px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 500,
                backgroundColor: tab === key ? '#00a884' : 'transparent',
                color: tab === key ? 'white' : '#8696a0',
                transition: 'all 0.15s',
              }}>
              {icon} {label}
            </button>
          ))}
        </div>
      </div>

      {/* Contenido según tab */}
      {tab === 'bot'
        ? <BotOrdersTab onSelectConversation={onSelectConversation} onOrderPaid={onOrderPaid} />
        : <ShopifyOrdersTab />
      }
    </div>
  );
}

// ─── Tab: Pedidos del Bot ─────────────────────────────────────────
function BotOrdersTab({ onSelectConversation, onOrderPaid }) {
  const [orders, setOrders]   = useState([]);
  const [stats, setStats]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter]   = useState('all');
  const [toast, setToast]     = useState(null);
  const [syncing, setSyncing] = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ordersData, statsData] = await Promise.all([ordersAPI.getAll(), ordersAPI.getStats()]);
      setOrders(ordersData);
      setStats(statsData);
    } catch { showToast('Error cargando pedidos', 'error'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleStatusChange = async (orderId, newStatus) => {
    try {
      const updated = await ordersAPI.setStatus(orderId, newStatus);
      setOrders(prev => prev.map(o => o.id === orderId ? { ...o, status: updated.status } : o));
      if (newStatus === 'paid') { onOrderPaid?.(); setStats(s => ({ ...s, paid: s.paid + 1, pending: Math.max(0, s.pending - 1) })); }
      showToast('Estado actualizado');
    } catch { showToast('Error actualizando estado', 'error'); }
  };

  const handleResendLink = async (orderId) => {
    try {
      await ordersAPI.resendLink(orderId);
      showToast('Link de pago reenviado ✅');
    } catch (err) { showToast(err.response?.data?.error || 'Error reenviando link', 'error'); }
  };

  const handleSyncShopify = async (orderId) => {
    setSyncing(orderId);
    try {
      const result = await ordersAPI.syncShopify(orderId);
      setOrders(prev => prev.map(o => o.id === orderId ? { ...o, status: result.localStatus } : o));
      showToast(`Shopify: ${result.shopifyStatus} → ${result.localStatus}`);
    } catch (err) { showToast(err.response?.data?.error || 'Error sincronizando', 'error'); }
    finally { setSyncing(null); }
  };

  const filtered = filter === 'all' ? orders : orders.filter(o => o.status === filter);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>

        {/* Stats */}
        {stats && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
            {[
              { icon: <Package size={18} color="#8696a0" />,     label: 'Total',      value: stats.total,   color: '#e9edef' },
              { icon: <Clock size={18} color="#f0b429" />,       label: 'Pendientes', value: stats.pending, color: '#f0b429' },
              { icon: <CheckCircle size={18} color="#00a884" />, label: 'Pagados',    value: stats.paid,    color: '#00a884' },
              { icon: <DollarSign size={18} color="#00a884" />,  label: 'Ingresos',   value: `$${Number(stats.revenue || 0).toLocaleString('es-CL')}`, color: '#00a884' },
            ].map(({ icon, label, value, color }) => (
              <div key={label} style={{ backgroundColor: '#202c33', borderRadius: '12px', padding: '16px', border: '1px solid #2a3942' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>{icon}<span style={{ fontSize: '12px', color: '#8696a0' }}>{label}</span></div>
                <div style={{ fontSize: '22px', fontWeight: 700, color }}>{value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Filtros */}
        <div style={{ display: 'flex', gap: '8px' }}>
          {[
            { key: 'all', label: 'Todas' },
            { key: 'sent', label: 'Pendientes' },
            { key: 'paid', label: 'Pagadas' },
            { key: 'cancelled', label: 'Canceladas' },
          ].map(({ key, label }) => (
            <button key={key} onClick={() => setFilter(key)}
              style={{
                padding: '6px 14px', borderRadius: '20px', fontSize: '13px', fontWeight: 500,
                backgroundColor: filter === key ? '#00a884' : '#202c33',
                color: filter === key ? 'white' : '#8696a0',
                border: `1px solid ${filter === key ? '#00a884' : '#2a3942'}`,
              }}>
              {label}
            </button>
          ))}
        </div>

        {/* Lista */}
        {loading ? (
          <EmptyMsg icon={<Package size={40} />} text="Cargando pedidos..." />
        ) : filtered.length === 0 ? (
          <EmptyMsg icon={<Bot size={40} />} text="Sin pedidos del bot aún" sub="Los pedidos aparecen cuando el agente IA cierra una venta" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {filtered.map(order => (
              <BotOrderCard key={order.id} order={order}
                onStatusChange={handleStatusChange}
                onResendLink={handleResendLink}
                onSyncShopify={handleSyncShopify}
                onGoToConversation={onSelectConversation}
                syncing={syncing === order.id}
              />
            ))}
          </div>
        )}
      </div>

      {toast && <Toast toast={toast} />}
    </div>
  );
}

// ─── Tab: Órdenes de Shopify ──────────────────────────────────────
function ShopifyOrdersTab() {
  const [orders, setOrders]     = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [filter, setFilter]     = useState('any');
  const [hasMore, setHasMore]   = useState(false);
  const [cursor, setCursor]     = useState(null);

  const load = useCallback(async (reset = true) => {
    if (reset) { setLoading(true); setError(null); setOrders([]); setCursor(null); }
    try {
      const params = { status: filter, limit: 50 };
      if (!reset && cursor) params.cursor = cursor;
      const res = await api.get('/orders/shopify', { params });
      const data = res.data;
      if (!data.success) throw new Error(data.error);
      setOrders(prev => reset ? data.orders : [...prev, ...data.orders]);
      setHasMore(data.hasNextPage);
      setCursor(data.endCursor);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }, [filter, cursor]);

  useEffect(() => { load(true); }, [filter]);

  const financialColors = {
    PAID: '#00a884', PENDING: '#f0b429', REFUNDED: '#8696a0',
    PARTIALLY_REFUNDED: '#8696a0', VOIDED: '#e57373', AUTHORIZED: '#4db6ac',
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Filtros */}
      <div style={{ padding: '12px 24px', display: 'flex', gap: '8px', borderBottom: '1px solid #2a3942', backgroundColor: '#111b21', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {[
            { key: 'any',    label: 'Todas' },
            { key: 'open',   label: 'Abiertas' },
            { key: 'closed', label: 'Cerradas' },
            { key: 'cancelled', label: 'Canceladas' },
          ].map(({ key, label }) => (
            <button key={key} onClick={() => setFilter(key)}
              style={{
                padding: '5px 12px', borderRadius: '20px', fontSize: '13px', fontWeight: 500,
                backgroundColor: filter === key ? '#00a884' : '#202c33',
                color: filter === key ? 'white' : '#8696a0',
                border: `1px solid ${filter === key ? '#00a884' : '#2a3942'}`,
              }}>
              {label}
            </button>
          ))}
        </div>
        <button onClick={() => load(true)}
          style={{ background: 'none', color: '#8696a0', padding: '6px', borderRadius: '50%', display: 'flex' }}
          onMouseEnter={e => e.currentTarget.style.background = '#374045'}
          onMouseLeave={e => e.currentTarget.style.background = 'none'}>
          <RefreshCw size={16} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {loading ? (
          <EmptyMsg icon={<Store size={40} />} text="Cargando órdenes de Shopify..." />
        ) : error ? (
          <EmptyMsg icon={<XCircle size={40} />} text="Error cargando órdenes" sub={error} color="#e57373" />
        ) : orders.length === 0 ? (
          <EmptyMsg icon={<Store size={40} />} text="Sin órdenes en Shopify" sub="Asegúrate de que la app raigentic esté instalada y la sesión activa" />
        ) : (
          <>
            {/* Cabecera tabla */}
            <div style={{
              display: 'grid', gridTemplateColumns: '100px 1fr 160px 120px 110px 110px',
              gap: '12px', padding: '8px 16px',
              fontSize: '11px', color: '#8696a0', textTransform: 'uppercase', letterSpacing: '0.5px',
            }}>
              <span>Orden</span><span>Cliente</span><span>Productos</span>
              <span>Total</span><span>Pago</span><span>Envío</span>
            </div>

            {orders.map(order => <ShopifyOrderRow key={order.id} order={order} />)}

            {hasMore && (
              <button onClick={() => load(false)}
                style={{
                  margin: '8px auto', padding: '10px 24px', borderRadius: '20px',
                  backgroundColor: '#202c33', color: '#8696a0', fontSize: '13px',
                  border: '1px solid #2a3942',
                }}>
                Cargar más órdenes
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Fila de orden Shopify ────────────────────────────────────────
function ShopifyOrderRow({ order }) {
  const [expanded, setExpanded] = useState(false);

  const financial    = SHOPIFY_FINANCIAL[order.financialStatus]    || { label: order.financialStatus,    color: '#8696a0', bg: '#2a3942' };
  const fulfillment  = SHOPIFY_FULFILLMENT[order.fulfillmentStatus] || { label: order.fulfillmentStatus,  color: '#8696a0' };
  const customerName = order.customer?.name || 'Cliente desconocido';
  const itemsSummary = order.lineItems?.map(i => `${i.title} ×${i.quantity}`).join(', ') || '—';

  return (
    <div style={{
      backgroundColor: '#202c33', borderRadius: '12px',
      border: '1px solid #2a3942', overflow: 'hidden',
    }}
      onMouseEnter={e => e.currentTarget.style.borderColor = '#374045'}
      onMouseLeave={e => e.currentTarget.style.borderColor = '#2a3942'}
    >
      {/* Fila compacta */}
      <div onClick={() => setExpanded(!expanded)} style={{
        display: 'grid', gridTemplateColumns: '100px 1fr 160px 120px 110px 110px',
        gap: '12px', padding: '12px 16px', cursor: 'pointer', alignItems: 'center',
      }}>
        {/* Número orden */}
        <div style={{ fontWeight: 700, color: '#e9edef', fontSize: '14px' }}>{order.name}</div>

        {/* Cliente */}
        <div>
          <div style={{ color: '#e9edef', fontSize: '13px' }}>{customerName}</div>
          {order.customer?.phone && <div style={{ color: '#8696a0', fontSize: '12px' }}>{order.customer.phone}</div>}
        </div>

        {/* Productos */}
        <div style={{ color: '#8696a0', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {itemsSummary}
        </div>

        {/* Total */}
        <div style={{ color: '#00a884', fontWeight: 700, fontSize: '14px' }}>
          ${Number(order.totalPrice).toLocaleString('es-CL')}
          <span style={{ color: '#8696a0', fontSize: '11px', fontWeight: 400, marginLeft: '4px' }}>{order.currency}</span>
        </div>

        {/* Estado pago */}
        <div style={{
          backgroundColor: financial.bg || '#2a3942',
          color: financial.color,
          borderRadius: '8px', padding: '3px 8px',
          fontSize: '11px', fontWeight: 600,
          border: `1px solid ${financial.color}33`,
          textAlign: 'center',
        }}>
          {financial.label}
        </div>

        {/* Estado envío */}
        <div style={{ color: fulfillment.color, fontSize: '12px', fontWeight: 500 }}>
          {fulfillment.label}
        </div>
      </div>

      {/* Detalle expandido */}
      {expanded && (
        <div style={{ borderTop: '1px solid #2a3942', padding: '14px 16px', display: 'flex', gap: '24px' }}>
          {/* Items */}
          <div style={{ flex: 1 }}>
            <div style={{ color: '#8696a0', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>Productos</div>
            {order.lineItems?.map((item, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #1f2c33', fontSize: '13px' }}>
                <span style={{ color: '#e9edef' }}>{item.title} ×{item.quantity}</span>
                {item.price && <span style={{ color: '#8696a0' }}>${Number(item.price * item.quantity).toLocaleString('es-CL')}</span>}
              </div>
            ))}
          </div>

          {/* Info */}
          <div style={{ minWidth: '200px' }}>
            <div style={{ color: '#8696a0', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>Detalles</div>
            <div style={{ fontSize: '12px', color: '#8696a0', lineHeight: '1.8' }}>
              <div>📅 {formatDateTime(order.createdAt)}</div>
              {order.customer?.email && <div>✉️ {order.customer.email}</div>}
              {order.shippingAddress && (
                <div>📍 {order.shippingAddress.city}, {order.shippingAddress.country}</div>
              )}
              <div style={{ color: '#4db6ac' }}>🛍️ Canal: {order.channel}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Card pedido del Bot ──────────────────────────────────────────
function BotOrderCard({ order, onStatusChange, onResendLink, onSyncShopify, onGoToConversation, syncing }) {
  const [expanded, setExpanded] = useState(false);
  const status = BOT_STATUS[order.status] || BOT_STATUS.draft;
  const items  = Array.isArray(order.items) ? order.items : [];
  const addr   = order.shipping_address || {};

  return (
    <div style={{ backgroundColor: '#202c33', borderRadius: '12px', border: '1px solid #2a3942', overflow: 'hidden' }}
      onMouseEnter={e => e.currentTarget.style.borderColor = '#374045'}
      onMouseLeave={e => e.currentTarget.style.borderColor = '#2a3942'}
    >
      <div onClick={() => setExpanded(!expanded)} style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: '14px', cursor: 'pointer' }}>
        {/* Badge estado */}
        <div style={{
          backgroundColor: status.bg, color: status.color,
          borderRadius: '20px', padding: '4px 10px',
          fontSize: '12px', fontWeight: 500, flexShrink: 0,
          border: `1px solid ${status.color}33`,
          display: 'flex', alignItems: 'center', gap: '4px',
        }}>
          <Bot size={11} /> {status.label}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: '#e9edef', fontSize: '14px', fontWeight: 500 }}>{order.customer_name || order.contact_name}</div>
          <div style={{ color: '#8696a0', fontSize: '12px', marginTop: '2px' }}>{order.phone_number} · {formatDateTime(order.created_at)}</div>
        </div>

        <div style={{ color: '#8696a0', fontSize: '13px', textAlign: 'right', flexShrink: 0 }}>
          {items.map(i => `${i.name || i.product_name} ×${i.quantity}`).join(', ').substring(0, 40) || '—'}
        </div>

        <div style={{ color: '#00a884', fontSize: '16px', fontWeight: 700, flexShrink: 0, minWidth: '80px', textAlign: 'right' }}>
          {order.total_price ? `$${Number(order.total_price).toLocaleString('es-CL')}` : '—'}
        </div>

        <div style={{ color: '#8696a0', fontSize: '11px' }}>{expanded ? '▲' : '▼'}</div>
      </div>

      {expanded && (
        <div style={{ borderTop: '1px solid #2a3942', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <div>
              <div style={{ color: '#8696a0', fontSize: '11px', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Productos</div>
              {items.length > 0 ? items.map((item, i) => (
                <div key={i} style={{ color: '#e9edef', fontSize: '13px', display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #1f2c33' }}>
                  <span>{item.name || item.product_name}</span>
                  <span style={{ color: '#8696a0' }}>× {item.quantity}</span>
                </div>
              )) : <div style={{ color: '#8696a0', fontSize: '13px' }}>Sin detalle</div>}
            </div>
            <div>
              <div style={{ color: '#8696a0', fontSize: '11px', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Envío</div>
              <div style={{ color: '#e9edef', fontSize: '13px', lineHeight: '1.7' }}>
                {addr.address || addr.address1 || '—'}<br />
                {addr.city}{addr.zip ? ` · CP ${addr.zip}` : ''}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {order.invoice_url && (
              <a href={order.invoice_url} target="_blank" rel="noreferrer"
                style={{ display: 'flex', alignItems: 'center', gap: '5px', backgroundColor: '#0d2e25', color: '#00a884', padding: '7px 12px', borderRadius: '8px', fontSize: '13px', textDecoration: 'none', border: '1px solid #00a88433' }}>
                <ExternalLink size={13} /> Ver en Shopify
              </a>
            )}
            {order.invoice_url && order.status === 'sent' && (
              <button onClick={() => onResendLink(order.id)}
                style={{ display: 'flex', alignItems: 'center', gap: '5px', backgroundColor: '#2a3942', color: '#e9edef', padding: '7px 12px', borderRadius: '8px', fontSize: '13px' }}>
                <Send size={13} /> Reenviar link
              </button>
            )}
            {order.shopify_draft_id && (
              <button onClick={() => onSyncShopify(order.id)} disabled={syncing}
                style={{ display: 'flex', alignItems: 'center', gap: '5px', backgroundColor: '#2a3942', color: '#8696a0', padding: '7px 12px', borderRadius: '8px', fontSize: '13px', opacity: syncing ? 0.6 : 1 }}>
                <RotateCcw size={13} style={{ animation: syncing ? 'spin 1s linear infinite' : 'none' }} />
                {syncing ? 'Sincronizando...' : 'Sincronizar estado'}
              </button>
            )}
            {order.status === 'sent' && (
              <button onClick={() => onStatusChange(order.id, 'paid')}
                style={{ display: 'flex', alignItems: 'center', gap: '5px', backgroundColor: '#0d2e25', color: '#00a884', padding: '7px 12px', borderRadius: '8px', fontSize: '13px', border: '1px solid #00a88433' }}>
                <CheckCircle size={13} /> Marcar pagado
              </button>
            )}
            {!['cancelled', 'paid'].includes(order.status) && (
              <button onClick={() => onStatusChange(order.id, 'cancelled')}
                style={{ display: 'flex', alignItems: 'center', gap: '5px', backgroundColor: '#2d1a1a', color: '#e57373', padding: '7px 12px', borderRadius: '8px', fontSize: '13px', border: '1px solid #5c262633' }}>
                <XCircle size={13} /> Cancelar
              </button>
            )}
            <button onClick={() => onGoToConversation?.(order.conversation_id)}
              style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '5px', backgroundColor: '#2a3942', color: '#8696a0', padding: '7px 12px', borderRadius: '8px', fontSize: '13px' }}>
              Ver conversación →
            </button>
          </div>
        </div>
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────
function EmptyMsg({ icon, text, sub, color = '#8696a0' }) {
  return (
    <div style={{ textAlign: 'center', padding: '60px', color }}>
      <div style={{ marginBottom: '12px', opacity: 0.3 }}>{icon}</div>
      <div style={{ fontSize: '15px', fontWeight: 500 }}>{text}</div>
      {sub && <div style={{ fontSize: '13px', marginTop: '6px', opacity: 0.6 }}>{sub}</div>}
    </div>
  );
}

function Toast({ toast }) {
  return (
    <div style={{
      position: 'fixed', bottom: '24px', right: '24px', zIndex: 1000,
      backgroundColor: toast.type === 'error' ? '#2d1a1a' : '#0d2e25',
      border: `1px solid ${toast.type === 'error' ? '#5c2626' : '#00a884'}`,
      color: toast.type === 'error' ? '#e57373' : '#00a884',
      padding: '12px 18px', borderRadius: '10px', fontSize: '13px', fontWeight: 500,
      boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
    }}>
      {toast.msg}
    </div>
  );
}
