import { useState, useEffect, useCallback, useRef } from 'react';
import { formatDateTime } from '../utils/dates.js';
import {
  ShoppingBag, RefreshCw, ExternalLink, Send, RotateCcw,
  CheckCircle, Clock, XCircle, Package, DollarSign, Bot, Store, Calendar, Download,
  Plus, Trash2, X, MessageSquare,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { ordersAPI, api, conversationsAPI } from '../utils/api.js';
import { useTheme } from '../theme.js';

// ─── Normalización ────────────────────────────────────────────────
function normalizeBotOrder(o) {
  return {
    _key:         `bot-${o.id}`,
    source:       'bot',
    rawId:        o.id,
    customerName: o.customer_name || o.contact_name || 'Cliente',
    phone:        o.customer_phone || o.phone_number || '—',
    date:         new Date(o.created_at),
    total:        Number(o.total_price || 0),
    botStatus:    o.status,
    items:        (Array.isArray(o.items) ? o.items : []).map(i => ({ title: i.title || i.name || i.product_name, quantity: i.quantity, price: i.price })),
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
    crmStatus:        o.crm_status || 'nuevo',
    items,
    raw:              o,
  };
}

// ─── Filtros de fecha ─────────────────────────────────────────────
function filterByDate(orders, dateFilter, customDate) {
  if (dateFilter === 'custom' && customDate) {
    // Filtrar por día exacto (hora local)
    return orders.filter(o => {
      const d = o.date;
      const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
      const key = `${y}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      return key === customDate;
    });
  }
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
    draft:            { label: 'Nuevo',          color: '#a78bfa', bg: '#1e1030' },
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

  // Nuevo pedido manual
  const [showNewOrder,   setShowNewOrder]  = useState(false);
  const [products,       setProducts]      = useState([]);

  // Selección masiva
  const [selected,       setSelected]      = useState(new Set()); // Set de _key
  const [bulkStatus,     setBulkStatus]    = useState('');
  const [applyingBulk,   setApplyingBulk]  = useState(false);

  // Drawer de conversación
  const [convDrawer,     setConvDrawer]     = useState(null); // { convId, name, phone }
  const [drawerMsgs,     setDrawerMsgs]     = useState([]);
  const [drawerLoading,  setDrawerLoading]  = useState(false);
  const drawerEndRef = useRef(null);

  const openConvDrawer = useCallback(async (convId, name, phone) => {
    if (!convId) return;
    setConvDrawer({ convId, name, phone });
    setDrawerMsgs([]);
    setDrawerLoading(true);
    try {
      const msgs = await conversationsAPI.getMessages(convId);
      setDrawerMsgs(msgs || []);
    } catch { setDrawerMsgs([]); }
    finally { setDrawerLoading(false); }
  }, []);

  useEffect(() => {
    if (drawerMsgs.length) drawerEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [drawerMsgs]);

  // Filtros
  const [dateFilter,   setDateFilter]   = useState('all');
  const [customDate,   setCustomDate]   = useState('');
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

  useEffect(() => {
    api.get('/products').then(r => setProducts(r.data?.products || [])).catch(() => {});
  }, []);

  // Normalizar y mezclar
  const allNormalized = [
    ...botOrders.map(normalizeBotOrder),
    ...shopifyOrders.map(normalizeShopifyOrder),
  ].sort((a, b) => b.date - a.date);

  // Aplicar filtros
  let filtered = filterByDate(allNormalized, dateFilter, customDate);
  filtered = filterBySource(filtered, sourceFilter);
  if (statusFilter !== 'all') {
    filtered = filtered.filter(o => {
      // Estado CRM unificado: bot usa botStatus, Shopify usa crmStatus
      const crmKey = o.source === 'bot' ? o.botStatus : o.crmStatus;
      // Mapeos legacy bot → CRM
      const legacyMap = { draft: 'nuevo', sent: 'nuevo', payment_received: 'paid' };
      const effective = legacyMap[crmKey] || crmKey;
      return effective === statusFilter;
    });
  }

  const totalPages  = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated   = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Helper para sumar ventas: solo shopify_orders, excluye voided/refunded
  // (los pedidos bot que pasaron por Shopify ya están en shopify_orders)
  const sumarValidos = (orders) => orders.reduce((sum, o) => {
    if (o.source === 'bot') return sum;
    if (['VOIDED', 'REFUNDED'].includes(o.financialStatus)) return sum;
    return sum + (o.total || 0);
  }, 0);

  // Ventas: si el filtro es "Todo", usar el total real del backend (DB completa)
  // Para otros filtros, calcular desde los pedidos cargados en frontend
  const ventasFiltradas = dateFilter === 'all'
    ? (stats?.ventasTotal ?? sumarValidos(filtered))
    : sumarValidos(filtered);

  // Ventas este mes: calculado desde allNormalized (todos los pedidos cargados)
  const now = new Date();
  const ventasMesFront = sumarValidos(
    allNormalized.filter(o => o.date.getFullYear() === now.getFullYear() && o.date.getMonth() === now.getMonth())
  );

  const dateFilterLabel = {
    all:    'Ventas total',
    today:  'Ventas hoy',
    week:   'Ventas 7 días',
    month:  'Ventas 30 días',
    custom: customDate ? `Ventas ${new Date(customDate + 'T12:00:00').toLocaleDateString('es-CL', { day: 'numeric', month: 'short' })}` : 'Ventas día',
  }[dateFilter] || 'Ventas';

  // Reset página + selección si el filtro cambia
  const setDateFilterR   = v => { setDateFilter(v); if (v !== 'custom') setCustomDate(''); setPage(1); setSelected(new Set()); };
  const setSourceFilterR = v => { setSourceFilter(v); setPage(1); setSelected(new Set()); };
  const setStatusFilterR = v => { setStatusFilter(v); setPage(1); setSelected(new Set()); };

  // Selección
  const toggleSelect = key => setSelected(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });
  const selectAll   = () => setSelected(new Set(filtered.map(o => o._key)));
  const deselectAll = () => setSelected(new Set());
  const allSelected = filtered.length > 0 && filtered.every(o => selected.has(o._key));

  const getSelOrders = () => filtered.filter(o => selected.has(o._key));

  // Aplicar cambio masivo de estado
  const handleBulkApply = async () => {
    if (!bulkStatus || selected.size === 0) return;
    const selOrders  = getSelOrders();
    const botIds     = selOrders.filter(o => o.source === 'bot').map(o => o.rawId);
    const shopifyIds = selOrders.filter(o => o.source === 'shopify').map(o => String(o.rawId));
    setApplyingBulk(true);
    try {
      const res = await api.patch('/orders/bulk-status', { status: bulkStatus, botIds, shopifyIds });
      showToast(`✅ ${res.data.updated} órdenes → "${CRM_STATUSES.find(s=>s.key===bulkStatus)?.label || bulkStatus}"`);
      setSelected(new Set()); setBulkStatus(''); await load();
    } catch (err) { showToast(err.response?.data?.error || 'Error al actualizar', 'error'); }
    finally { setApplyingBulk(false); }
  };

  // Anular masivo
  const handleBulkCancel = async () => {
    if (selected.size === 0) return;
    const selOrders  = getSelOrders();
    const botIds     = selOrders.filter(o => o.source === 'bot').map(o => o.rawId);
    const shopifyIds = selOrders.filter(o => o.source === 'shopify').map(o => String(o.rawId));
    setApplyingBulk(true);
    try {
      const res = await api.patch('/orders/bulk-status', { status: 'cancelled', botIds, shopifyIds });
      showToast(`🚫 ${res.data.updated} órdenes anuladas`);
      setSelected(new Set()); await load();
    } catch (err) { showToast(err.response?.data?.error || 'Error al anular', 'error'); }
    finally { setApplyingBulk(false); }
  };

  // Eliminar masivo
  const handleBulkDelete = async () => {
    if (selected.size === 0) return;
    if (!window.confirm(`¿Eliminar ${selected.size} pedido(s) permanentemente?`)) return;
    const selOrders  = getSelOrders();
    const botIds     = selOrders.filter(o => o.source === 'bot').map(o => o.rawId);
    const shopifyIds = selOrders.filter(o => o.source === 'shopify').map(o => String(o.rawId));
    setApplyingBulk(true);
    try {
      const res = await api.delete('/orders/bulk', { data: { botIds, shopifyIds } });
      showToast(`🗑️ ${res.data.deleted} órdenes eliminadas`);
      setSelected(new Set()); await load();
    } catch (err) { showToast(err.response?.data?.error || 'Error al eliminar', 'error'); }
    finally { setApplyingBulk(false); }
  };

  // ─── Export para despacho ─────────────────────────────────────────
  const handleExportXlsx = () => {
    const selOrders = getSelOrders();
    if (selOrders.length === 0) return;

    const HEADERS = [
      'Título* Requerido', 'Dirección completa* Requerida', 'Carga',
      'Hora inicial', 'Hora final', 'Tiempo de servicio', 'Notas',
      'Latitud', 'Longitud', 'ID de referencia', 'Habilidades requeridas',
      'Habilidades opcionales', 'Persona de contacto', 'Teléfono de contacto',
      'Hora inicial 2', 'Hora final 2', 'Carga 2', 'Carga 3', 'Prioridad',
      'SMS', 'Correo electrónico de contacto', 'Carga pick', 'Carga pick 2',
      'Carga pick 3', 'Fecha programada', 'Tipo de visita',
    ];

    const dataRows = selOrders.map(order => {
      const row = new Array(26).fill('');

      // Col A: Título — #IDNombre (sin espacio)
      const id = order.source === 'shopify'
        ? (order.shopifyName || `#${order.rawId}`)
        : `#${order.rawId}`;
      row[0] = `${id}${order.customerName}`;

      // Col B: Dirección completa
      const parseAddr = (raw) => {
        if (!raw) return {};
        if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return {}; } }
        return raw;
      };
      if (order.source === 'bot') {
        const addr = parseAddr(order.raw?.shipping_address);
        // Bot guarda: { address, city } o { address1, city, zip }
        row[1] = [addr.address || addr.address1, addr.city, addr.zip].filter(Boolean).join(', ');
      } else {
        const addr = parseAddr(order.raw?.shipping_address);
        row[1] = [addr.address1 || addr.address, addr.city, addr.zip].filter(Boolean).join(', ');
      }

      // Col G: Notas — items
      row[6] = (order.items || []).map(i => {
        const price = i.price ? ` - $${Number(i.price).toLocaleString('es-CL')}` : '';
        return `${i.quantity}x ${i.title || '?'}${price}`;
      }).join(', ');

      // Col N: Teléfono (fórmula =+56...)
      const phone = (order.phone || '').replace(/\D/g, '');
      const phoneClean = phone.replace(/^56/, '');
      if (phoneClean) row[13] = Number(phoneClean);

      return row;
    });

    const wsData = [HEADERS, ...dataRows];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Hoja 91');
    const fecha = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `despacho_${fecha}.xlsx`);
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

  const DONE_STATES = ['en_camino', 'entregado', 'paid', 'cancelled'];
  // Sin despachar = solo nuevo y por_despachar
  const totalUnfulfilled = filtered.filter(o => {
    const crmKey  = o.source === 'bot' ? o.botStatus : o.crmStatus;
    const legacyMap = { draft: 'nuevo', sent: 'nuevo', payment_received: 'paid' };
    const effective = legacyMap[crmKey] || crmKey;
    return ['nuevo', 'por_despachar'].includes(effective);
  }).length;

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
        <button onClick={() => setShowNewOrder(true)}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', backgroundColor: colors.green, color: 'white', padding: '6px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 600, border: 'none', cursor: 'pointer' }}>
          <Plus size={13} /> Nuevo pedido
        </button>
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
            { icon: <Package size={18} color={colors.textSecondary} />, label: 'En vista',        value: filtered.length,                                    color: colors.textPrimary },
            { icon: <Clock size={18} color={colors.yellow} />,          label: 'Sin despachar',   value: totalUnfulfilled,                                   color: colors.yellow },
            { icon: <DollarSign size={18} color={colors.green} />,      label: dateFilterLabel,   value: `$${ventasFiltradas.toLocaleString('es-CL')}`,      color: colors.green },
            { icon: <DollarSign size={18} color='#4db6ac' />,           label: 'Ventas este mes', value: `$${ventasMesFront.toLocaleString('es-CL')}`,       color: '#4db6ac' },
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
            <input
              type="date"
              value={customDate}
              onChange={e => {
                setCustomDate(e.target.value);
                setDateFilter('custom');
                setPage(1);
                setSelected(new Set());
              }}
              style={{ padding: '4px 8px', borderRadius: '8px', fontSize: '12px', border: `1px solid ${dateFilter === 'custom' ? colors.green : colors.border}`, backgroundColor: colors.bgPanel, color: dateFilter === 'custom' ? colors.green : colors.textSecondary, cursor: 'pointer', outline: 'none' }}
            />
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

          {/* Estado CRM */}
          {[{ key: 'all', label: 'Todos', color: colors.textSecondary, bg: colors.bgPanel },
            ...CRM_STATUSES.map(s => ({ key: s.key, label: s.label, color: s.color, bg: s.bg })),
          ].map(({ key, label, color, bg }) => (
            <button key={key} onClick={() => setStatusFilterR(key)}
              style={{ padding: '5px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: 500,
                border: `1px solid ${statusFilter === key ? color : colors.border}`,
                backgroundColor: statusFilter === key ? bg : colors.bgPanel,
                color: statusFilter === key ? color : colors.textSecondary, cursor: 'pointer' }}>
              {label}
            </button>
          ))}
        </div>

        {/* Barra de selección masiva */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <button onClick={allSelected ? deselectAll : selectAll}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 14px', borderRadius: '8px', border: `1px solid ${allSelected ? colors.green : colors.border}`, backgroundColor: allSelected ? colors.green : colors.bgPanel, color: allSelected ? 'white' : colors.textSecondary, cursor: 'pointer', fontSize: '12px', fontWeight: 500 }}>
            <span style={{ width: 14, height: 14, borderRadius: 3, border: `2px solid ${allSelected ? 'white' : colors.border}`, backgroundColor: allSelected ? 'white' : 'transparent', display: 'inline-block', flexShrink: 0 }} />
            {allSelected ? `Deseleccionar todos (${filtered.length})` : `Seleccionar todos (${filtered.length})`}
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

              <div style={{ width: 1, height: 20, backgroundColor: colors.border }} />

              <button onClick={handleBulkCancel} disabled={applyingBulk}
                style={{ padding: '6px 14px', borderRadius: '8px', border: '1px solid #fb923c44', backgroundColor: '#2e1500', color: '#fb923c', cursor: 'pointer', fontSize: '12px', fontWeight: 500, opacity: applyingBulk ? 0.7 : 1 }}>
                🚫 Anular
              </button>

              <button onClick={handleBulkDelete} disabled={applyingBulk}
                style={{ padding: '6px 14px', borderRadius: '8px', border: '1px solid #f8717144', backgroundColor: '#2d1a1a', color: '#f87171', cursor: 'pointer', fontSize: '12px', fontWeight: 500, opacity: applyingBulk ? 0.7 : 1 }}>
                🗑️ Eliminar
              </button>

              <div style={{ width: 1, height: 20, backgroundColor: colors.border }} />

              <button onClick={handleExportXlsx}
                style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 14px', borderRadius: '8px', border: '1px solid #22c55e44', backgroundColor: '#052010', color: '#4ade80', cursor: 'pointer', fontSize: '12px', fontWeight: 500 }}>
                <Download size={12} /> Exportar despacho
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
                      onGoToConversation={(convId) => openConvDrawer(convId, order.raw?.customer_name || order.raw?.contact_name, order.raw?.customer_phone || order.raw?.phone_number)}
                      syncing={syncing === order.rawId}
                      selected={selected.has(order._key)}
                      onToggleSelect={() => toggleSelect(order._key)}
                      products={products}
                      onItemsUpdated={load}
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

      {showNewOrder && (
        <NewOrderModal
          colors={colors}
          products={products}
          onClose={() => setShowNewOrder(false)}
          onSaved={() => { setShowNewOrder(false); load(); showToast('✅ Pedido creado'); }}
        />
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>

    {/* ── Drawer lateral de conversación ── */}
    {convDrawer && (
      <div style={{ position: 'fixed', inset: 0, zIndex: 500, display: 'flex', pointerEvents: 'none' }}>
        {/* Overlay semitransparente */}
        <div onClick={() => setConvDrawer(null)}
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', pointerEvents: 'all' }} />

        {/* Panel */}
        <div style={{ width: '420px', maxWidth: '92vw', backgroundColor: colors.bgPanel, borderLeft: `1px solid ${colors.border}`, display: 'flex', flexDirection: 'column', pointerEvents: 'all', boxShadow: '-8px 0 32px rgba(0,0,0,0.4)' }}>
          {/* Header */}
          <div style={{ padding: '14px 18px', borderBottom: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', gap: '10px' }}>
            <MessageSquare size={16} color={colors.green} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: colors.textPrimary, fontWeight: 700, fontSize: '14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {convDrawer.name || convDrawer.phone}
              </div>
              <div style={{ color: colors.textSecondary, fontSize: '11px' }}>{convDrawer.phone}</div>
            </div>
            <button onClick={() => setConvDrawer(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.textSecondary, padding: '4px' }}>
              <X size={18} />
            </button>
          </div>

          {/* Mensajes */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {drawerLoading ? (
              <div style={{ textAlign: 'center', padding: '40px', color: colors.textSecondary }}>Cargando...</div>
            ) : drawerMsgs.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px', color: colors.textSecondary }}>Sin mensajes</div>
            ) : drawerMsgs.map((msg, i) => {
              const isOut = msg.direction === 'outbound';
              return (
                <div key={i} style={{ display: 'flex', justifyContent: isOut ? 'flex-end' : 'flex-start' }}>
                  <div style={{ maxWidth: '80%', backgroundColor: isOut ? colors.green + '22' : colors.bgSub, border: `1px solid ${isOut ? colors.green + '44' : colors.border}`, borderRadius: isOut ? '12px 12px 2px 12px' : '12px 12px 12px 2px', padding: '8px 12px' }}>
                    <div style={{ color: colors.textPrimary, fontSize: '13px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{msg.content}</div>
                    <div style={{ color: colors.textSecondary, fontSize: '10px', marginTop: '4px', textAlign: isOut ? 'right' : 'left' }}>
                      {formatDateTime(msg.created_at)}
                    </div>
                  </div>
                </div>
              );
            })}
            <div ref={drawerEndRef} />
          </div>
        </div>
      </div>
    )}
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
function BotOrderCard({ order, onStatusChange, onResendLink, onSyncShopify, onGoToConversation, syncing, selected, onToggleSelect, products = [], onItemsUpdated }) {
  const { colors } = useTheme();
  const [expanded,  setExpanded]  = useState(false);
  const [editMode,  setEditMode]  = useState(false);
  const [editItems, setEditItems] = useState([]);
  const [saving,    setSaving]    = useState(false);
  const [editErr,   setEditErr]   = useState('');

  const status = getBotStatusStyle(order.status, colors);
  const items  = Array.isArray(order.items) ? order.items : [];
  const addr   = order.shipping_address || {};

  const startEdit = (e) => {
    e.stopPropagation();
    setEditItems(items.map(i => ({ name: i.name || i.title || i.product_name || '', quantity: Number(i.quantity) || 1, price: Number(i.price) || 0 })));
    setEditErr('');
    setEditMode(true);
  };

  const cancelEdit = () => { setEditMode(false); setEditErr(''); };

  const setItemField = (idx, field, val) =>
    setEditItems(prev => prev.map((it, i) => i === idx ? { ...it, [field]: val } : it));

  const removeItem = (idx) => setEditItems(prev => prev.filter((_, i) => i !== idx));

  const addItem = () => setEditItems(prev => [...prev, { name: '', quantity: 1, price: 0 }]);

  const selectProduct = (idx, productId) => {
    if (!productId) { setItemField(idx, 'name', ''); setItemField(idx, 'price', 0); return; }
    const p = products.find(p => String(p.id) === productId);
    if (p) setEditItems(prev => prev.map((it, i) => i === idx ? { ...it, name: p.title, price: Number(p.price) || 0 } : it));
  };

  const saveItems = async () => {
    if (editItems.some(i => !i.name.trim())) { setEditErr('Completa el nombre de todos los items'); return; }
    setSaving(true); setEditErr('');
    try {
      await api.patch(`/orders/${order.id}/items`, { items: editItems });
      setEditMode(false);
      onItemsUpdated?.();
    } catch (err) {
      setEditErr(err?.response?.data?.error || 'Error al guardar');
    } finally { setSaving(false); }
  };

  const editTotal = editItems.reduce((s, i) => s + (Number(i.price) * Number(i.quantity)), 0);

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

        {/* Badge financiero — Pendiente para draft/sent */}
        {(order.status === 'draft' || order.status === 'sent') && (
          <div style={{ backgroundColor: '#2e2100', color: colors.yellow, borderRadius: '20px', padding: '3px 10px', fontSize: '11px', fontWeight: 500, border: `1px solid ${colors.yellow}33`, flexShrink: 0 }}>
            Pendiente
          </div>
        )}

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: colors.textPrimary, fontSize: '14px', fontWeight: 500 }}>{order.customer_name || order.contact_name}</div>
          <div style={{ color: colors.textSecondary, fontSize: '12px', marginTop: '1px' }}>{order.customer_phone || order.phone_number || '—'} · {formatDateTime(order.created_at)}</div>
        </div>

        <div style={{ color: colors.textSecondary, fontSize: '12px', textAlign: 'right', flexShrink: 0, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {items.map(i => `${i.name || i.title || i.product_name || '?'} ×${i.quantity}`).join(', ') || '—'}
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
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                <div style={{ color: colors.textSecondary, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Productos</div>
                {!editMode && !['cancelled','paid'].includes(order.status) && (
                  <button onClick={startEdit} style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'none', border: `1px solid ${colors.border}`, color: colors.textSecondary, borderRadius: '6px', padding: '2px 8px', fontSize: '11px', cursor: 'pointer' }}>
                    ✏️ Editar
                  </button>
                )}
              </div>

              {editMode ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {editItems.map((item, idx) => (
                    <div key={idx} style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '8px', borderRadius: '8px', border: `1px solid ${colors.border}`, backgroundColor: colors.bgSub }}>
                      {/* Selector de producto */}
                      {products.length > 0 && (
                        <select onChange={e => selectProduct(idx, e.target.value)}
                          style={{ backgroundColor: colors.bgPanel, color: colors.textSecondary, border: `1px solid ${colors.border}`, borderRadius: '6px', padding: '4px 6px', fontSize: '11px' }}>
                          <option value="">— Elegir producto —</option>
                          {products.map(p => <option key={p.id} value={String(p.id)}>{p.title}</option>)}
                        </select>
                      )}
                      {/* Nombre */}
                      <input value={item.name} onChange={e => setItemField(idx, 'name', e.target.value)} placeholder="Nombre del producto"
                        style={{ backgroundColor: colors.bgPanel, color: colors.textPrimary, border: `1px solid ${colors.border}`, borderRadius: '6px', padding: '4px 8px', fontSize: '12px' }} />
                      {/* Cantidad y precio */}
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                        <button onClick={() => setItemField(idx, 'quantity', Math.max(1, item.quantity - 1))}
                          style={{ width: 26, height: 26, borderRadius: '6px', border: `1px solid ${colors.border}`, backgroundColor: colors.bgPanel, color: colors.textPrimary, cursor: 'pointer', fontSize: '14px', lineHeight: 1 }}>−</button>
                        <span style={{ color: colors.textPrimary, fontSize: '13px', minWidth: '24px', textAlign: 'center' }}>{item.quantity}</span>
                        <button onClick={() => setItemField(idx, 'quantity', item.quantity + 1)}
                          style={{ width: 26, height: 26, borderRadius: '6px', border: `1px solid ${colors.border}`, backgroundColor: colors.bgPanel, color: colors.textPrimary, cursor: 'pointer', fontSize: '14px', lineHeight: 1 }}>+</button>
                        <span style={{ color: colors.textSecondary, fontSize: '12px', marginLeft: '4px' }}>Precio:</span>
                        <input type="number" value={item.price} onChange={e => setItemField(idx, 'price', Number(e.target.value))} min="0"
                          style={{ width: '80px', backgroundColor: colors.bgPanel, color: colors.textPrimary, border: `1px solid ${colors.border}`, borderRadius: '6px', padding: '4px 6px', fontSize: '12px' }} />
                        <button onClick={() => removeItem(idx)}
                          style={{ marginLeft: 'auto', background: 'none', border: 'none', color: colors.red, cursor: 'pointer', padding: '2px' }}>
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  ))}

                  {/* Agregar item */}
                  <button onClick={addItem} style={{ display: 'flex', alignItems: 'center', gap: '5px', background: 'none', border: `1px dashed ${colors.border}`, color: colors.textSecondary, borderRadius: '8px', padding: '6px 10px', fontSize: '12px', cursor: 'pointer' }}>
                    <Plus size={12} /> Agregar producto
                  </button>

                  {/* Total en edición */}
                  <div style={{ color: colors.green, fontSize: '13px', fontWeight: 600, textAlign: 'right' }}>
                    Total: ${editTotal.toLocaleString('es-CL')}
                  </div>

                  {editErr && <div style={{ color: colors.red, fontSize: '12px' }}>{editErr}</div>}

                  {/* Botones guardar/cancelar */}
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button onClick={saveItems} disabled={saving} style={{ flex: 1, padding: '7px', borderRadius: '8px', border: 'none', backgroundColor: colors.green, color: '#000', fontSize: '12px', fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}>
                      {saving ? 'Guardando...' : '✓ Guardar cambios'}
                    </button>
                    <button onClick={cancelEdit} style={{ padding: '7px 12px', borderRadius: '8px', border: `1px solid ${colors.border}`, backgroundColor: 'transparent', color: colors.textSecondary, fontSize: '12px', cursor: 'pointer' }}>
                      Cancelar
                    </button>
                  </div>
                </div>
              ) : (
                items.length > 0 ? items.map((item, i) => (
                  <div key={i} style={{ color: colors.textPrimary, fontSize: '13px', display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: `1px solid ${colors.bgSub}` }}>
                    <span>{item.name || item.title || item.product_name}</span>
                    <span style={{ color: colors.textSecondary }}>× {item.quantity}{item.price ? ` · $${Number(item.price).toLocaleString('es-CL')}` : ''}</span>
                  </div>
                )) : <div style={{ color: colors.textSecondary, fontSize: '13px' }}>Sin detalle</div>
              )}
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
              <MessageSquare size={12} /> Ver conversación
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

// ─── Modal nuevo pedido manual ────────────────────────────────────
function NewOrderModal({ colors, products, onClose, onSaved }) {
  const EMPTY_ITEM = { name: '', quantity: 1, price: '' };
  const [form, setForm] = useState({ customerName: '', phone: '', address: '', status: 'nuevo' });
  const [items, setItems] = useState([{ ...EMPTY_ITEM }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [lookingUp, setLookingUp] = useState(false);

  const setField = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const lookupContact = async (phone) => {
    if (!phone.trim()) return;
    setLookingUp(true);
    try {
      const res = await api.get(`/contacts/by-phone?phone=${encodeURIComponent(phone.trim())}`);
      const c = res.data?.contact;
      if (c) {
        setForm(f => ({
          ...f,
          customerName: f.customerName || c.name || f.customerName,
          address: f.address || [c.address, c.city].filter(Boolean).join(', ') || f.address,
        }));
      }
    } catch (_) {}
    finally { setLookingUp(false); }
  };

  const setItem = (idx, k, v) => setItems(prev => prev.map((it, i) => i === idx ? { ...it, [k]: v } : it));

  const addItem = () => setItems(prev => [...prev, { ...EMPTY_ITEM }]);
  const removeItem = idx => setItems(prev => prev.filter((_, i) => i !== idx));

  const selectProduct = (idx, productId) => {
    if (!productId) { setItem(idx, 'name', ''); setItem(idx, 'price', ''); return; }
    const p = products.find(p => String(p.id) === productId);
    if (p) { setItem(idx, 'name', p.title); setItem(idx, 'price', String(p.price)); }
  };

  const total = items.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.quantity) || 1), 0);

  const handleSave = async () => {
    if (!form.customerName.trim()) { setError('El nombre del cliente es requerido'); return; }
    if (items.some(i => !i.name.trim())) { setError('Completa el nombre de todos los productos'); return; }
    setSaving(true); setError('');
    try {
      await api.post('/orders', { ...form, items });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Error creando pedido');
      setSaving(false);
    }
  };

  const inp = {
    padding: '8px 10px', borderRadius: '8px', border: `1px solid ${colors.border}`,
    backgroundColor: colors.bgHover, color: colors.textPrimary, fontSize: '13px',
    outline: 'none', width: '100%', boxSizing: 'border-box',
  };

  return (
    <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '20px' }}>
      <div style={{ backgroundColor: colors.bgPanel, borderRadius: '16px', width: '100%', maxWidth: '520px', maxHeight: '90vh', display: 'flex', flexDirection: 'column', border: `1px solid ${colors.border}` }}>

        {/* Header */}
        <div style={{ padding: '18px 20px', borderBottom: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: colors.textPrimary }}>Nuevo pedido</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: colors.textSecondary, cursor: 'pointer', padding: '4px' }}><X size={18} /></button>
        </div>

        {/* Body */}
        <div style={{ overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>

          {/* Cliente */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <div>
              <label style={{ fontSize: '11px', color: colors.textSecondary, display: 'block', marginBottom: '5px' }}>Nombre cliente *</label>
              <input style={inp} value={form.customerName} onChange={e => setField('customerName', e.target.value)} placeholder="Juan Pérez" />
            </div>
            <div>
              <label style={{ fontSize: '11px', color: colors.textSecondary, display: 'block', marginBottom: '5px' }}>
                Teléfono {lookingUp && <span style={{ color: colors.textSecondary, fontStyle: 'italic' }}>buscando...</span>}
              </label>
              <input style={inp} value={form.phone}
                onChange={e => setField('phone', e.target.value)}
                onBlur={e => lookupContact(e.target.value)}
                placeholder="56987654321" />
            </div>
          </div>

          <div>
            <label style={{ fontSize: '11px', color: colors.textSecondary, display: 'block', marginBottom: '5px' }}>Dirección</label>
            <input style={inp} value={form.address} onChange={e => setField('address', e.target.value)} placeholder="Av. Ejemplo 123, La Serena" />
          </div>

          <div>
            <label style={{ fontSize: '11px', color: colors.textSecondary, display: 'block', marginBottom: '5px' }}>Estado inicial</label>
            <select style={{ ...inp, cursor: 'pointer' }} value={form.status} onChange={e => setField('status', e.target.value)}>
              <option value="nuevo">Nuevo</option>
              <option value="por_despachar">Por despachar</option>
              <option value="paid">Pagado</option>
            </select>
          </div>

          {/* Productos */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
              <label style={{ fontSize: '11px', color: colors.textSecondary }}>Productos *</label>
              <button onClick={addItem} style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'none', border: `1px solid ${colors.border}`, borderRadius: '6px', padding: '3px 8px', color: colors.textSecondary, cursor: 'pointer', fontSize: '11px' }}>
                <Plus size={11} /> Agregar
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {items.map((item, idx) => (
                <div key={idx} style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                  {/* Selector de producto */}
                  <div style={{ flex: 2, minWidth: 0 }}>
                    {products.length > 0 ? (
                      <select style={{ ...inp, width: '100%' }}
                        onChange={e => { selectProduct(idx, e.target.value); }}
                        defaultValue="">
                        <option value="">— Seleccionar o escribir —</option>
                        {products.filter(p => p.active !== false).map(p => (
                          <option key={p.id} value={String(p.id)}>{p.title} · ${Number(p.price).toLocaleString('es-CL')}</option>
                        ))}
                      </select>
                    ) : null}
                    <input style={{ ...inp, marginTop: products.length > 0 ? '4px' : '0' }}
                      value={item.name}
                      onChange={e => setItem(idx, 'name', e.target.value)}
                      placeholder="Nombre del producto" />
                  </div>
                  {/* Cantidad */}
                  <input style={{ ...inp, width: '56px', textAlign: 'center', flexShrink: 0 }}
                    type="number" min="1" value={item.quantity}
                    onChange={e => setItem(idx, 'quantity', e.target.value)} />
                  {/* Precio */}
                  <input style={{ ...inp, width: '90px', flexShrink: 0 }}
                    type="number" min="0" value={item.price}
                    onChange={e => setItem(idx, 'price', e.target.value)}
                    placeholder="Precio" />
                  {items.length > 1 && (
                    <button onClick={() => removeItem(idx)} style={{ background: 'none', border: 'none', color: colors.red, cursor: 'pointer', padding: '4px', flexShrink: 0 }}>
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Total */}
          <div style={{ textAlign: 'right', fontSize: '15px', fontWeight: 700, color: colors.green }}>
            Total: ${total.toLocaleString('es-CL')}
          </div>

          {error && <div style={{ padding: '8px 12px', backgroundColor: `${colors.red}22`, borderRadius: '8px', color: colors.red, fontSize: '13px' }}>{error}</div>}
        </div>

        {/* Footer */}
        <div style={{ padding: '14px 20px', borderTop: `1px solid ${colors.border}`, display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '8px 18px', borderRadius: '8px', border: `1px solid ${colors.border}`, background: 'none', color: colors.textSecondary, cursor: 'pointer', fontSize: '13px' }}>
            Cancelar
          </button>
          <button onClick={handleSave} disabled={saving}
            style={{ padding: '8px 20px', borderRadius: '8px', border: 'none', backgroundColor: colors.green, color: 'white', fontWeight: 700, fontSize: '13px', cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Guardando...' : 'Crear pedido'}
          </button>
        </div>
      </div>
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
