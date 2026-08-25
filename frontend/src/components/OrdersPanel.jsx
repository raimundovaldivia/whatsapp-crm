import { useState, useEffect, useCallback } from 'react';
import { formatDateTime } from '../utils/dates.js';
import {
  ShoppingBag, RefreshCw, ExternalLink, Send, RotateCcw,
  CheckCircle, Clock, XCircle, Package, DollarSign, Bot, Store, Calendar,
} from 'lucide-react';
import { ordersAPI, api } from '../utils/api.js';
import { useTheme } from '../theme.js';

// ─── Normalización ────────────────────────────────────────────────
function normalizeBotOrder(o) {
  return {
    _key:         `bot-${o.id}`,
    source:       'bot',
    rawId:        o.id,
    customerName: o.customer_name || o.contact_name || 'Cliente',
    phone:        o.phone_number || '—',
    date:         new Date(o.created_at),
    total:        Number(o.total_price || 0),
    botStatus:    o.status,
    items:        (Array.isArray(o.items) ? o.items : []).map(i => ({ title: i.name || i.product_name, quantity: i.quantity, price: i.price })),
    raw:          o,
  };
}

function normalizeShopifyOrder(o) {
  // Formato DB: columnas snake_case, items ya como array parseado
  const items = Array.isArray(o.items)
    ? o.items.map(i => ({ title: i.name || i.title, quantity: i.quantity, price: i.price }))
    : [];
  return {
    _key:             `shopify-${o.shopify_order_id || o.id}`,
    source:           'shopify',
    rawId:            o.shopify_order_id || o.id,
    dbId:             o.id,
    customerName:     o.customer_name || 'Cliente desconocido',
    phone:            o.customer_phone || '—',
    date:             o.shopify_created_at ? new Date(o.shopify_created_at) : new Date(0),
    total:            Number(o.total_price || 0),
    shopifyName:      o.shopify_name,
    financialStatus:  (o.financial_status || '').toUpperCase(),
    fulfillmentStatus:(o.fulfillment_status || '').toUpperCase(),
    items,
    raw:              o,
  };
}

// ─── Filtros de fecha ─────────────────────────────────────────────
function filterByDate(orders, dateFilter) {
  if (dateFilter === 'all') return orders;
  const now = new Date();
  const cutoffs = {
    today: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
    week:  new Date(now - 7  * 24 * 60 * 60 * 1000),
    month: new Date(now - 30 * 24 * 60 * 60 * 1000),
  };
  const cutoff = cutoffs[dateFilter];
  return cutoff ? orders.filter(o => o.date >= cutoff) : orders;
}

function filterBySource(orders, sourceFilter) {
  if (sourceFilter === 'all') return orders;
  return orders.filter(o => o.source === sourceFilter);
}

// ─── Estados CRM unificados ──────────────────────────────────────
const CRM_STATUSES = [
  { key: 'nuevo',         label: 'Nuevo',          color: '#a78bfa', bg: '#1e1030' },
  { key: 'por_despachar', label: 'Por despachar',  color: '#fb923c', bg: '#2e1500' },
  { key: 'en_camino',     label: 'En camino',      color: '#38bdf8', bg: '#0c2030' },
  { key: 'entregado',     label: 'Entregado',      color: '#4ade80', bg: '#0a2015' },
  { key: 'paid',          label: 'Pagado',          color: '#22c55e', bg: '#052010' },
  { key: 'cancelled',     label: 'Cancelado',      color: '#f87171', bg: '#2d1a1a' },
];

function getCrmStatusStyle(status) {
  return CRM_STATUSES.find(s => s.key === status)
    || { label: status || 'Nuevo', color: '#a78bfa', bg: '#1e1030' };
}

// ─── Estado bot → label/color ─────────────────────────────────────
function getBotStatusStyle(status, colors) {
  const crm = getCrmStatusStyle(status);
  return {
    draft:            { label: 'Borrador',       color: colors.textSecondary, bg: colors.bgHover },
    sent:             { label: 'Nuevo',          color: '#a78bfa', bg: '#1e1030' },
    payment_received: { label: 'Pago recibido',  color: '#38bdf8', bg: '#0c2030' },
    nuevo:            crm,
    por_despachar:    crm,
    en_camino:        crm,
    entregado:        crm,
    paid:             { label: 'Pagado',         color: '#22c55e', bg: '#052010' },
    cancelled:        { label: 'Cancelado',      color: '#f87171', bg: '#2d1a1a' },
    failed:           { label: 'Fallido',        color: '#f87171', bg: '#2d1a1a' },
  }[status] || { label: status, color: colors.textSecondary, bg: colors.bgHover };
}

function getShopifyFinancialStyle(status, colors) {
  return {
    PAID:               { label: 'Pagado',        color: colors.green,         bg: colors.bgAccent },
    PENDING:            { label: 'Pendiente',     color: colors.yellow,        bg: '#2e2100' },
    REFUNDED:           { label: 'Reembolsado',   color: colors.textSecondary, bg: colors.bgHover },
    PARTIALLY_REFUNDED: { label: 'Rem. parcial',  color: colors.textSecondary, bg: colors.bgHover },
    VOIDED:             { label: 'Anulado',       color: colors.red,           bg: '#2d1a1a' },
    AUTHORIZED:         { label: 'Autorizado',    color: '#4db6ac',            bg: '#0d2929' },
  }[status] || { label: status || '—', color: colors.textSecondary, bg: colors.bgHover };
}

function getShopifyFulfillmentStyle(status, colors) {
  return {
    FULFILLED:   { label: 'Enviado',    color: colors.green },
    UNFULFILLED: { label: 'Sin enviar', color: colors.yellow },
    PARTIAL:     { label: 'Parcial',    color: colors.yellow },
    RESTOCKED:   { label: 'Devuelto',   color: colors.textSecondary },
    IN_PROGRESS: { label: 'En proceso', color: '#4db6ac' },
  }[status] || { label: status || '—', color: colors.textSecondary };
}

// ─── Componente principal ─────────────────────────────────────────
export default function OrdersPanel({ onSelectConversation, onOrderPaid }) {
  const { colors } = useTheme();
  const [botOrders,     setBotOrders]     = useState([]);
  const [shopifyOrders, setShopifyOrders] = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [stats,         setStats]         = useState(null);
  const [toast,         setToast]         = useState(null);
  const [syncing,       setSyncing]       = useState(null);
  const [syncingAll,    setSyncingAll]    = useState(false);
  const [lastSync,      setLastSync]      = useState(null);

  // Selección masiva
  const [selected,       setSelected]      = useState(new Set()); // Set de _key
  const [bulkStatus,     setBulkStatus]    = useState('');
  const [applyingBulk,   setApplyingBulk]  = useState(false);

  // Filtros
  const [dateFilter,   setDateFilter]   = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [page,         setPage]         = useState(1);
  const PAGE_SIZE = 50;

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [botData, statsData, shopifyRes] = await Promise.all([
        ordersAPI.getAll(),
        ordersAPI.getStats(),
        api.get('/orders/shopify').catch(() => ({ data: { orders: [], lastSync: null } })),
      ]);
      setBotOrders(botData || []);
      setStats(statsData);
      setShopifyOrders(shopifyRes.data?.orders || []);
      if (shopifyRes.data?.lastSync) setLastSync(new Date(shopifyRes.data.lastSync));
    } catch {
      showToast('Error cargando pedidos', 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSyncAll = async () => {
    setSyncingAll(true);
    try {
      const res = await api.post('/orders/shopify/sync');
      showToast(`✅ Sincronizadas ${res.data.synced} órdenes de Shopify`);
      await load();
    } catch (err) {
      showToast(err.response?.data?.error || 'Error sincronizando con Shopify', 'error');
    } finally {
      setSyncingAll(false);
    }
  };

  useEffect(() => { load(); }, [load]);

  // Normalizar y mezclar
  const allNormalized = [
    ...botOrders.map(normalizeBotOrder),
    ...shopifyOrders.map(normalizeShopifyOrder),
  ].sort((a, b) => b.date - a.date);

  // Aplicar filtros
  let filtered = filterByDate(allNormalized, dateFilter);
  filtered = filterBySource(filtered, sourceFilter);
  if (statusFilter !== 'all') {
    filtered = filtered.filter(o => {
      if (o.source === 'bot') return o.botStatus === statusFilter;
      if (o.source === 'shopify') {
        if (statusFilter === 'paid')      return o.financialStatus === 'PAID';
        if (statusFilter === 'pending')   return o.financialStatus === 'PENDING';
        if (statusFilter === 'cancelled') return ['VOIDED','REFUNDED'].includes(o.financialStatus);
      }
      return true;
    });
  }

  const totalPages  = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated   = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Reset página + selección si el filtro cambia
  const setDateFilterR   = v => { setDateFilter(v);   setPage(1); setSelected(new Set()); };
  const setSourceFilterR = v => { setSourceFilter(v); setPage(1); setSelected(new Set()); };
  const setStatusFilterR = v => { setStatusFilter(v); setPage(1); setSelected(new Set()); };

  // Selección
  const toggleSelect = key => setSelected(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });
  const selectAllPage  = () => setSelected(prev => { const next = new Set(prev); paginated.forEach(o => next.add(o._key)); return next; });
  const deselectAll    = () => setSelected(new Set());
  const allPageSelected = paginated.length > 0 && paginated.every(o => selected.has(o._key));

  // Aplicar cambio masivo
  const handleBulkApply = async () => {
    if (!bulkStatus || selected.size === 0) return;
    const selOrders = filtered.filter(o => selected.has(o._key));
    const botIds      = selOrders.filter(o => o.source === 'bot').map(o => o.rawId);
    const shopifyIds  = selOrders.filter(o => o.source === 'shopify').map(o => String(o.rawId));
    setApplyingBulk(true);
    try {
      const res = await api.patch('/orders/bulk-status', { status: bulkStatus, botIds, shopifyIds });
      showToast(`✅ ${res.data.updated} órdenes actualizadas a "${CRM_STATUSES.find(s=>s.key===bulkStatus)?.label || bulkStatus}"`);
      setSelected(new Set());
      setBulkStatus('');
      await load();
    } catch (err) {
      showToast(err.response?.data?.error || 'Error al actualizar', 'error');
    } finally {
      setApplyingBulk(false);
    }
  };

  const handleStatusChange = async (orderId, newStatus) => {
    try {
      const updated = await ordersAPI.setStatus(orderId, newStatus);
      setBotOrders(prev => prev.map(o => o.id === orderId ? { ...o, status: updated.status } : o));
      if (newStatus === 'paid') onOrderPaid?.();
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
      setBotOrders(prev => prev.map(o => o.id === orderId ? { ...o, status: result.localStatus } : o));
      showToast(`Shopify: ${result.shopifyStatus} → ${result.localStatus}`);
    } catch (err) { showToast(err.response?.data?.error || 'Error sincronizando', 'error'); }
    finally { setSyncing(null); }
  };

  // Solo sumar órdenes efectivamente pagadas
  const totalRevenue = filtered
    .filter(o => o.source === 'bot'
      ? ['paid', 'payment_received'].includes(o.botStatus)
      : o.financialStatus === 'PAID')
    .reduce((s, o) => s + o.total, 0);

  // Sin despachar (más útil que "pending pago" para tienda COD)
  const totalUnfulfilled = filtered.filter(o =>
    o.source === 'bot'
      ? ['draft', 'sent', 'payment_received'].includes(o.botStatus)
      : !['FULFILLED', 'RESTOCKED'].includes(o.fulfillmentStatus)
  ).length;

  const totalPaid = filtered.filter(o =>
    o.source === 'bot'
      ? ['paid', 'payment_received'].includes(o.botStatus)
      : o.financialStatus === 'PAID'
  ).length;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100vh', backgroundColor: colors.bgApp, overflow: 'hidden' }}>

      {/* Header */}
      <div style={{ padding: '14px 24px', backgroundColor: colors.bgPanel, borderBottom: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', gap: '12px' }}>
        <ShoppingBag size={20} color={colors.green} />
        <h1 style={{ color: colors.textPrimary, fontSize: '17px', fontWeight: 600, flex: 1 }}>Pedidos</h1>
        {lastSync && (
          <span style={{ fontSize: '11px', color: colors.textSecondary }}>
            Shopify: {lastSync.toLocaleString('es-CL', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })}
          </span>
        )}
        <button onClick={handleSyncAll} disabled={syncingAll}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', backgroundColor: syncingAll ? colors.bgHover : '#0d2929', color: '#4db6ac', padding: '6px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 500, border: '1px solid #1a4040', cursor: syncingAll ? 'not-allowed' : 'pointer', opacity: syncingAll ? 0.7 : 1 }}>
          <RefreshCw size={12} style={{ animation: syncingAll ? 'spin 1s linear infinite' : 'none' }} />
          {syncingAll ? 'Sincronizando...' : 'Sync Shopify'}
        </button>
        <button onClick={load} style={{ background: 'none', color: colors.textSecondary, padding: '6px', borderRadius: '50%', display: 'flex', border: 'none', cursor: 'pointer' }}>
          <RefreshCw size={15} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>

        {/* Stats */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
          {[
            { icon: <Package size={18} color={colors.textSecondary} />, label: 'En vista',        value: filtered.length,                                     color: colors.textPrimary },
            { icon: <Clock size={18} color={colors.yellow} />,          label: 'Sin despachar',  value: totalUnfulfilled,                                        color: colors.yellow },
            { icon: <CheckCircle size={18} color={colors.green} />,     label: 'Pagados',        value: totalPaid,                                               color: colors.green },
            { icon: <DollarSign size={18} color={colors.green} />,      label: 'Total pagado',   value: `$${totalRevenue.toLocaleString('es-CL')}`,              color: colors.green },
          ].map(({ icon, label, value, color }) => (
            <div key={label} style={{ backgroundColor: colors.bgPanel, borderRadius: '12px', padding: '14px 16px', border: `1px solid ${colors.border}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>{icon}<span style={{ fontSize: '11px', color: colors.textSecondary }}>{label}</span></div>
              <div style={{ fontSize: '20px', fontWeight: 700, color }}>{value}</div>
            </div>
          ))}
        </div>

        {/* Filtros */}
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
          {/* Fecha */}
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <Calendar size={13} color={colors.textSecondary} />
            {[
              { key: 'all',   label: 'Todo' },
              { key: 'today', label: 'Hoy' },
              { key: 'week',  label: '7 días' },
              { key: 'month', label: '30 días' },
            ].map(({ key, label }) => (
              <button key={key} onClick={() => setDateFilterR(key)}
                style={{ padding: '5px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: 500, border: `1px solid ${dateFilter === key ? colors.green : colors.border}`, backgroundColor: dateFilter === key ? colors.green : colors.bgPanel, color: dateFilter === key ? 'white' : colors.textSecondary, cursor: 'pointer' }}>
                {label}
              </button>
            ))}
          </div>

          <div style={{ width: 1, height: 20, backgroundColor: colors.border }} />

          {/* Fuente */}
          {[
            { key: 'all',     label: 'Todos',   icon: null },
            { key: 'bot',     label: '🤖 Bot',   icon: null },
            { key: 'shopify', label: '🛍️ Shopify', icon: null },
          ].map(({ key, label }) => (
            <button key={key} onClick={() => setSourceFilterR(key)}
              style={{ padding: '5px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: 500, border: `1px solid ${sourceFilter === key ? '#4db6ac' : colors.border}`, backgroundColor: sourceFilter === key ? '#0d2929' : colors.bgPanel, color: sourceFilter === key ? '#4db6ac' : colors.textSecondary, cursor: 'pointer' }}>
              {label}
            </button>
          ))}

          <div style={{ width: 1, height: 20, backgroundColor: colors.border }} />

          {/* Estado */}
          {[
            { key: 'all',       label: 'Todos' },
            { key: 'pending',   label: 'Pendientes' },
            { key: 'paid',      label: 'Pagados' },
            { key: 'cancelled', label: 'Cancelados' },
          ].map(({ key, label }) => (
            <button key={key} onClick={() => setStatusFilterR(key)}
              style={{ padding: '5px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: 500, border: `1px solid ${statusFilter === key ? colors.yellow : colors.border}`, backgroundColor: statusFilter === key ? '#2e2100' : colors.bgPanel, color: statusFilter === key ? colors.yellow : colors.textSecondary, cursor: 'pointer' }}>
              {label}
            </button>
          ))}
        </div>

        {/* Barra de selección masiva */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <button onClick={allPageSelected ? deselectAll : selectAllPage}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 14px', borderRadius: '8px', border: `1px solid ${colors.border}`, backgroundColor: allPageSelected ? colors.green : colors.bgPanel, color: allPageSelected ? 'white' : colors.textSecondary, cursor: 'pointer', fontSize: '12px', fontWeight: 500 }}>
            <span style={{ width: 14, height: 14, borderRadius: 3, border: `2px solid ${allPageSelected ? 'white' : colors.border}`, backgroundColor: allPageSelected ? 'white' : 'transparent', display: 'inline-block', flexShrink: 0 }} />
            {allPageSelected ? 'Deseleccionar página' : 'Seleccionar página'}
          </button>

          {selected.size > 0 && (
            <>
              <span style={{ fontSize: '12px', color: colors.textSecondary }}>{selected.size} seleccionada{selected.size !== 1 ? 's' : ''}</span>
              <button onClick={deselectAll} style={{ background: 'none', border: 'none', color: colors.textSecondary, cursor: 'pointer', fontSize: '12px', textDecoration: 'underline' }}>Limpiar</button>
              <div style={{ width: 1, height: 20, backgroundColor: colors.border }} />
              <select value={bulkStatus} onChange={e => setBulkStatus(e.target.value)}
                style={{ padding: '6px 10px', borderRadius: '8px', border: `1px solid ${colors.border}`, backgroundColor: colors.bgHover, color: colors.textPrimary, fontSize: '12px', cursor: 'pointer' }}>
                <option value=''>Cambiar estado a…</option>
                {CRM_STATUSES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
              <button onClick={handleBulkApply} disabled={!bulkStatus || applyingBulk}
                style={{ padding: '6px 16px', borderRadius: '8px', border: 'none', backgroundColor: bulkStatus ? colors.green : colors.bgHover, color: bulkStatus ? 'white' : colors.textSecondary, cursor: bulkStatus ? 'pointer' : 'not-allowed', fontSize: '12px', fontWeight: 600, opacity: applyingBulk ? 0.7 : 1 }}>
                {applyingBulk ? 'Aplicando...' : 'Aplicar'}
              </button>
            </>
          )}
        </div>

        {/* Lista unificada */}
        {loading ? (
          <EmptyMsg icon={<Package size={40} />} text="Cargando pedidos..." />
        ) : filtered.length === 0 ? (
          <EmptyMsg icon={<ShoppingBag size={40} />} text="Sin pedidos en este rango" sub="Prueba cambiando los filtros de fecha o fuente" />
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {paginated.map(order => (
                order.source === 'bot'
                  ? <BotOrderCard key={order._key} order={order.raw}
                      onStatusChange={handleStatusChange}
                      onResendLink={handleResendLink}
                      onSyncShopify={handleSyncShopify}
                      onGoToConversation={onSelectConversation}
                      syncing={syncing === order.rawId}
                      selected={selected.has(order._key)}
                      onToggleSelect={() => toggleSelect(order._key)}
                    />
                  : <ShopifyOrderCard key={order._key} order={order}
                      selected={selected.has(order._key)}
                      onToggleSelect={() => toggleSelect(order._key)}
                    />
              ))}
            </div>

            {/* Paginación */}
            {totalPages > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', padding: '16px 0' }}>
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                  style={{ padding: '6px 16px', borderRadius: '8px', border: `1px solid ${colors.border}`, backgroundColor: colors.bgPanel, color: page === 1 ? colors.textSecondary : colors.textPrimary, cursor: page === 1 ? 'not-allowed' : 'pointer', fontSize: '13px' }}>
                  ← Anterior
                </button>
                <span style={{ fontSize: '13px', color: colors.textSecondary }}>
                  Página <strong style={{ color: colors.textPrimary }}>{page}</strong> de {totalPages}
                  <span style={{ marginLeft: '8px', opacity: 0.6 }}>({filtered.length} total)</span>
                </span>
                <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                  style={{ padding: '6px 16px', borderRadius: '8px', border: `1px solid ${colors.border}`, backgroundColor: colors.bgPanel, color: page === totalPages ? colors.textSecondary : colors.textPrimary, cursor: page === totalPages ? 'not-allowed' : 'pointer', fontSize: '13px' }}>
                  Siguiente →
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {toast && <Toast toast={toast} />}
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ─── Checkbox reutilizable ────────────────────────────────────────
function SelectBox({ checked, onChange, colors }) {
  return (
    <div onClick={e => { e.stopPropagation(); onChange(); }}
      style={{ width: 16, height: 16, borderRadius: 4, border: `2px solid ${checked ? colors.green : colors.border}`, backgroundColor: checked ? colors.green : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, cursor: 'pointer', transition: 'all .15s' }}>
      {checked && <span style={{ color: 'white', fontSize: 10, fontWeight: 700, lineHeight: 1 }}>✓</span>}
    </div>
  );
}

// ─── Card pedido Bot ──────────────────────────────────────────────
function BotOrderCard({ order, onStatusChange, onResendLink, onSyncShopify, onGoToConversation, syncing, selected, onToggleSelect }) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const status = getBotStatusStyle(order.status, colors);
  const items  = Array.isArray(order.items) ? order.items : [];
  const addr   = order.shipping_address || {};

  return (
    <div style={{ backgroundColor: colors.bgPanel, borderRadius: '12px', border: `2px solid ${selected ? colors.green : colors.border}`, overflow: 'hidden', transition: 'border-color .15s' }}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.borderColor = colors.borderStrong; }}
      onMouseLeave={e => { if (!selected) e.currentTarget.style.borderColor = colors.border; }}>

      <div onClick={() => setExpanded(!expanded)} style={{ padding: '13px 18px', display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer' }}>
        <SelectBox checked={!!selected} onChange={onToggleSelect} colors={colors} />

        {/* Badge fuente — Bot */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '3px 8px', borderRadius: '6px', backgroundColor: '#0d1f0d', border: '1px solid #1a3d1a', fontSize: '11px', fontWeight: 600, color: colors.green, flexShrink: 0 }}>
          <Bot size={10} /> Bot
        </div>

        {/* Badge estado */}
        <div style={{ backgroundColor: status.bg, color: status.color, borderRadius: '20px', padding: '3px 10px', fontSize: '11px', fontWeight: 500, border: `1px solid ${status.color}33`, flexShrink: 0 }}>
          {status.label}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: colors.textPrimary, fontSize: '14px', fontWeight: 500 }}>{order.customer_name || order.contact_name}</div>
          <div style={{ color: colors.textSecondary, fontSize: '12px', marginTop: '1px' }}>{order.phone_number} · {formatDateTime(order.created_at)}</div>
        </div>

        <div style={{ color: colors.textSecondary, fontSize: '12px', textAlign: 'right', flexShrink: 0, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {items.map(i => `${i.name || i.product_name} ×${i.quantity}`).join(', ') || '—'}
        </div>

        <div style={{ color: colors.green, fontSize: '15px', fontWeight: 700, flexShrink: 0, minWidth: '80px', textAlign: 'right' }}>
          {order.total_price ? `$${Number(order.total_price).toLocaleString('es-CL')}` : '—'}
        </div>

        <div style={{ color: colors.textSecondary, fontSize: '11px' }}>{expanded ? '▲' : '▼'}</div>
      </div>

      {expanded && (
        <div style={{ borderTop: `1px solid ${colors.border}`, padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <div>
              <div style={{ color: colors.textSecondary, fontSize: '11px', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Productos</div>
              {items.length > 0 ? items.map((item, i) => (
                <div key={i} style={{ color: colors.textPrimary, fontSize: '13px', display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: `1px solid ${colors.bgSub}` }}>
                  <span>{item.name || item.product_name}</span>
                  <span style={{ color: colors.textSecondary }}>× {item.quantity}</span>
                </div>
              )) : <div style={{ color: colors.textSecondary, fontSize: '13px' }}>Sin detalle</div>}
            </div>
            <div>
              <div style={{ color: colors.textSecondary, fontSize: '11px', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Envío</div>
              <div style={{ color: colors.textPrimary, fontSize: '13px', lineHeight: '1.7' }}>
                {addr.address || addr.address1 || '—'}<br />
                {addr.city}{addr.zip ? ` · CP ${addr.zip}` : ''}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {order.invoice_url && (
              <a href={order.invoice_url} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: '5px', backgroundColor: colors.bgAccent, color: colors.green, padding: '7px 12px', borderRadius: '8px', fontSize: '12px', textDecoration: 'none', border: `1px solid ${colors.green}33` }}>
                <ExternalLink size={12} /> Ver en Shopify
              </a>
            )}
            {order.invoice_url && order.status === 'sent' && (
              <button onClick={() => onResendLink(order.id)} style={{ display: 'flex', alignItems: 'center', gap: '5px', backgroundColor: colors.bgHover, color: colors.textPrimary, padding: '7px 12px', borderRadius: '8px', fontSize: '12px', border: 'none', cursor: 'pointer' }}>
                <Send size={12} /> Reenviar link
              </button>
            )}
            {order.shopify_draft_id && (
              <button onClick={() => onSyncShopify(order.id)} disabled={syncing} style={{ display: 'flex', alignItems: 'center', gap: '5px', backgroundColor: colors.bgHover, color: colors.textSecondary, padding: '7px 12px', borderRadius: '8px', fontSize: '12px', border: 'none', cursor: 'pointer', opacity: syncing ? 0.6 : 1 }}>
                <RotateCcw size={12} style={{ animation: syncing ? 'spin 1s linear infinite' : 'none' }} />
                {syncing ? 'Sincronizando...' : 'Sincronizar'}
              </button>
            )}
            {order.status === 'sent' && (
              <button onClick={() => onStatusChange(order.id, 'paid')} style={{ display: 'flex', alignItems: 'center', gap: '5px', backgroundColor: colors.bgAccent, color: colors.green, padding: '7px 12px', borderRadius: '8px', fontSize: '12px', border: `1px solid ${colors.green}33`, cursor: 'pointer' }}>
                <CheckCircle size={12} /> Marcar pagado
              </button>
            )}
            {!['cancelled', 'paid'].includes(order.status) && (
              <button onClick={() => onStatusChange(order.id, 'cancelled')} style={{ display: 'flex', alignItems: 'center', gap: '5px', backgroundColor: '#2d1a1a', color: colors.red, padding: '7px 12px', borderRadius: '8px', fontSize: '12px', border: '1px solid #5c262633', cursor: 'pointer' }}>
                <XCircle size={12} /> Cancelar
              </button>
            )}
            <button onClick={() => onGoToConversation?.(order.conversation_id)} style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '5px', backgroundColor: colors.bgHover, color: colors.textSecondary, padding: '7px 12px', borderRadius: '8px', fontSize: '12px', border: 'none', cursor: 'pointer' }}>
              Ver conversación →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Card pedido Shopify ──────────────────────────────────────────
function ShopifyOrderCard({ order, selected, onToggleSelect }) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const crmStyle    = getCrmStatusStyle(order.raw?.crm_status || 'nuevo');
  const financial   = getShopifyFinancialStyle(order.financialStatus, colors);
  const fulfillment = getShopifyFulfillmentStyle(order.fulfillmentStatus, colors);

  return (
    <div style={{ backgroundColor: colors.bgPanel, borderRadius: '12px', border: `2px solid ${selected ? colors.green : colors.border}`, overflow: 'hidden', transition: 'border-color .15s' }}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.borderColor = colors.borderStrong; }}
      onMouseLeave={e => { if (!selected) e.currentTarget.style.borderColor = colors.border; }}>

      <div onClick={() => setExpanded(!expanded)} style={{ padding: '13px 18px', display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer' }}>
        <SelectBox checked={!!selected} onChange={onToggleSelect} colors={colors} />

        {/* Badge fuente — Shopify */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '3px 8px', borderRadius: '6px', backgroundColor: '#0d2020', border: '1px solid #1a3d3d', fontSize: '11px', fontWeight: 600, color: '#4db6ac', flexShrink: 0 }}>
          <Store size={10} /> Shopify
        </div>

        {/* Badge estado CRM */}
        <div style={{ backgroundColor: crmStyle.bg, color: crmStyle.color, borderRadius: '20px', padding: '3px 10px', fontSize: '11px', fontWeight: 500, border: `1px solid ${crmStyle.color}44`, flexShrink: 0 }}>
          {crmStyle.label}
        </div>

        {/* Badge estado pago Shopify */}
        <div style={{ backgroundColor: financial.bg, color: financial.color, borderRadius: '20px', padding: '3px 10px', fontSize: '11px', fontWeight: 500, border: `1px solid ${financial.color}33`, flexShrink: 0 }}>
          {financial.label}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: colors.textPrimary, fontSize: '14px', fontWeight: 500 }}>{order.customerName}</div>
          <div style={{ color: colors.textSecondary, fontSize: '12px', marginTop: '1px' }}>
            {order.shopifyName} · {formatDateTime(order.date)}
            {order.phone !== '—' && ` · ${order.phone}`}
          </div>
        </div>

        <div style={{ color: colors.textSecondary, fontSize: '12px', textAlign: 'right', flexShrink: 0, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {order.items.map(i => `${i.title} ×${i.quantity}`).join(', ') || '—'}
        </div>

        <div style={{ color: colors.green, fontSize: '15px', fontWeight: 700, flexShrink: 0, minWidth: '80px', textAlign: 'right' }}>
          ${order.total.toLocaleString('es-CL')}
        </div>

        <div style={{ color: colors.textSecondary, fontSize: '11px', flexShrink: 0 }}>
          {fulfillment.label && <span style={{ color: fulfillment.color, fontSize: '11px' }}>{fulfillment.label}</span>}
        </div>

        <div style={{ color: colors.textSecondary, fontSize: '11px' }}>{expanded ? '▲' : '▼'}</div>
      </div>

      {expanded && (
        <div style={{ borderTop: `1px solid ${colors.border}`, padding: '14px 18px', display: 'flex', gap: '24px' }}>
          <div style={{ flex: 1 }}>
            <div style={{ color: colors.textSecondary, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>Productos</div>
            {order.items.map((item, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: `1px solid ${colors.bgSub}`, fontSize: '13px' }}>
                <span style={{ color: colors.textPrimary }}>{item.title} ×{item.quantity}</span>
                {item.price && <span style={{ color: colors.textSecondary }}>${Number(item.price * item.quantity).toLocaleString('es-CL')}</span>}
              </div>
            ))}
          </div>
          <div style={{ minWidth: '180px' }}>
            <div style={{ color: colors.textSecondary, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>Detalles</div>
            <div style={{ fontSize: '12px', color: colors.textSecondary, lineHeight: '1.8' }}>
              <div>📅 {formatDateTime(order.date)}</div>
              {order.raw?.customer_email && <div>✉️ {order.raw.customer_email}</div>}
              {order.raw?.customer_phone && <div>📞 {order.raw.customer_phone}</div>}
              {order.raw?.shipping_city  && <div>📍 {order.raw.shipping_city}</div>}
              <div style={{ color: '#4db6ac' }}>🛍️ Canal: Shopify</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────
function EmptyMsg({ icon, text, sub, color }) {
  const { colors } = useTheme();
  return (
    <div style={{ textAlign: 'center', padding: '60px', color: color || colors.textSecondary }}>
      <div style={{ marginBottom: '12px', opacity: 0.3 }}>{icon}</div>
      <div style={{ fontSize: '15px', fontWeight: 500 }}>{text}</div>
      {sub && <div style={{ fontSize: '13px', marginTop: '6px', opacity: 0.6 }}>{sub}</div>}
    </div>
  );
}

function Toast({ toast }) {
  const { colors } = useTheme();
  return (
    <div style={{
      position: 'fixed', bottom: '24px', right: '24px', zIndex: 1000,
      backgroundColor: toast.type === 'error' ? '#2d1a1a' : colors.bgAccent,
      border: `1px solid ${toast.type === 'error' ? '#5c2626' : colors.green}`,
      color: toast.type === 'error' ? colors.red : colors.green,
      padding: '12px 18px', borderRadius: '10px', fontSize: '13px', fontWeight: 500,
      boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
    }}>
      {toast.msg}
    </div>
  );
}
