/**
 * RepartosPanel.jsx
 * Panel admin para gestión de repartos:
 *   - Tab "Nuevo reparto": seleccionar pedidos → optimizar → asignar repartidor → enviar
 *   - Tab "Historial": ver rutas enviadas/en progreso/completadas
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { api, API_BASE } from '../utils/api.js';
import { useTheme } from '../theme.js';
import * as ui from '../ui.js';
import { Truck, Package, RotateCcw, Send, Check, X, MapPin, ChevronDown, ChevronRight, Phone, Download } from 'lucide-react';

// ─── Mapa (Leaflet + OpenStreetMap, cargado desde index.html vía window.L) ────
//
// Pinta los puntos de reparto. `ordered` dibuja además la línea de la ruta en
// el orden recibido. Usa divIcon (HTML) para los pines numerados, evitando los
// assets de icono de Leaflet que suelen romperse con los bundlers.

function RouteMap({ routes, points = [], ordered = false, warehouse, colors, height = '100%' }) {
  const elRef    = useRef(null);
  const mapRef   = useRef(null);
  const layerRef = useRef(null);

  // Normalizar a lista de rutas: cada una { points, color, ordered }
  const routeList = routes && routes.length
    ? routes
    : [{ points, color: '#22c55e', ordered }];

  useEffect(() => {
    const L = window.L;
    if (!L || !elRef.current) return;

    if (!mapRef.current) {
      mapRef.current = L.map(elRef.current, { zoomControl: true, attributionControl: false });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 })
        .addTo(mapRef.current);
      layerRef.current = L.layerGroup().addTo(mapRef.current);
    }
    const map   = mapRef.current;
    const layer = layerRef.current;
    layer.clearLayers();

    const allLatLngs = [];

    // Bodega (origen/destino) con un pin distinto
    if (warehouse && typeof warehouse.lat === 'number' && typeof warehouse.lng === 'number') {
      const wIcon = L.divIcon({
        className: '',
        html: `<div style="background:#1e293b;color:#fff;width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:15px;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5)">🏠</div>`,
        iconSize: [30, 30], iconAnchor: [15, 15],
      });
      L.marker([warehouse.lat, warehouse.lng], { icon: wIcon }).addTo(layer).bindPopup('<b>Bodega</b>');
      allLatLngs.push([warehouse.lat, warehouse.lng]);
    }

    routeList.forEach(rt => {
      const color = rt.color || '#22c55e';
      const pts = (rt.points || []).filter(p => typeof p.lat === 'number' && typeof p.lng === 'number');
      const line = [];
      if (warehouse && typeof warehouse.lat === 'number') line.push([warehouse.lat, warehouse.lng]);
      pts.forEach((p) => {
        const ll = [p.lat, p.lng];
        line.push(ll); allLatLngs.push(ll);
        const label = p.label != null ? String(p.label) : '';
        const icon = L.divIcon({
          className: '',
          html: `<div style="background:${color};color:#fff;width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)">${label || '●'}</div>`,
          iconSize: [26, 26], iconAnchor: [13, 13],
        });
        L.marker(ll, { icon }).addTo(layer)
          .bindPopup(`<b>${(p.name || '').replace(/</g, '')}</b><br>${(p.address || '').replace(/</g, '')}`);
      });
      // Cerrar el círculo de vuelta a la bodega (round trip)
      if (rt.ordered && warehouse && typeof warehouse.lat === 'number' && pts.length) line.push([warehouse.lat, warehouse.lng]);
      if (rt.ordered && line.length >= 2) {
        L.polyline(line, { color, weight: 3, dashArray: '8,6' }).addTo(layer);
      }
    });

    if (allLatLngs.length === 0) {
      map.setView([-29.9027, -71.2519], 12); // La Serena por defecto
    } else {
      map.fitBounds(allLatLngs, { padding: [40, 40], maxZoom: 15 });
    }
    setTimeout(() => map.invalidateSize(), 60); // el contenedor pudo cambiar de tamaño
  }, [JSON.stringify(routeList), JSON.stringify(warehouse)]);

  // Destruir el mapa al desmontar
  useEffect(() => () => {
    if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
  }, []);

  if (!window.L) {
    return (
      <div style={{ width: '100%', height, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: colors.textMuted, fontSize: '13px', border: `1px solid ${colors.border}`, borderRadius: '12px' }}>
        Cargando mapa…
      </div>
    );
  }

  return <div ref={elRef} style={{ width: '100%', height, minHeight: '200px', borderRadius: '12px', overflow: 'hidden', border: `1px solid ${colors.border}` }} />;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const STATUS_META = {
  draft:       { label: 'Borrador',     color: '#94a3b8' },
  sent:        { label: 'Enviada',      color: '#38bdf8' },
  in_progress: { label: 'En progreso',  color: '#fb923c' },
  completed:   { label: 'Completada',   color: '#22c55e' },
  cancelled:   { label: 'Cancelada',    color: '#f87171' },
};

function fmt(n) { return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(n); }

// ─── Editor de bodega (origen/destino de las rutas) ──────────────────────────

function WarehouseEditor({ colors, warehouse, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState('');
  const [saving,  setSaving]  = useState(false);
  const [msg,     setMsg]     = useState(null);

  const start = () => { setDraft(warehouse?.address || ''); setEditing(true); setMsg(null); };

  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      const r = await api.post('/settings/warehouse', { address: draft.trim() });
      onSaved(r.data.warehouse);
      setEditing(false);
      if (r.data.warning) setMsg(r.data.warning);
    } catch (e) {
      setMsg(e.response?.data?.error || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <input
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
          placeholder="Dirección de la bodega, ej: Av. Balmaceda 1234, La Serena"
          style={{ ...inputStyle(colors), fontSize: '13px' }}
        />
        <div style={{ display: 'flex', gap: '6px' }}>
          <button onClick={save} disabled={saving}
            style={{ flex: 1, background: colors.green, color: '#fff', border: 'none', borderRadius: '7px', padding: '7px', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}>
            {saving ? 'Guardando...' : 'Guardar bodega'}
          </button>
          <button onClick={() => setEditing(false)}
            style={{ background: 'none', border: `1px solid ${colors.border}`, borderRadius: '7px', padding: '7px 12px', color: colors.textMuted, fontSize: '12px', cursor: 'pointer' }}>
            Cancelar
          </button>
        </div>
        {msg && <div style={{ fontSize: '11px', color: '#fbbf24' }}>{msg}</div>}
      </div>
    );
  }

  if (!warehouse?.address) {
    return (
      <div style={{ fontSize: '11px', color: '#fbbf24', backgroundColor: '#2a1f08', border: '1px solid #78350f', borderRadius: '8px', padding: '8px 10px', lineHeight: 1.4 }}>
        ⚠️ Sin bodega configurada. Las rutas salen y vuelven de ahí.{' '}
        <button onClick={start} style={{ background: 'none', border: 'none', color: '#fcd34d', textDecoration: 'underline', cursor: 'pointer', padding: 0, fontSize: '11px' }}>Configurar bodega</button>
      </div>
    );
  }

  return (
    <div style={{ fontSize: '11px', color: colors.textMuted, display: 'flex', alignItems: 'center', gap: '5px' }}>
      <span>🏠</span>
      <span style={{ color: colors.textSecondary, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {warehouse.address}{!warehouse.geocoded ? ' (sin ubicar)' : ''}
      </span>
      <button onClick={start} style={{ background: 'none', border: 'none', color: colors.blue, cursor: 'pointer', padding: 0, fontSize: '11px' }}>editar</button>
    </div>
  );
}

// Un color por vehículo, para distinguir las rutas en el mapa y la lista
const VEHICLE_COLORS = ['#22c55e', '#38bdf8', '#f59e0b', '#a78bfa', '#f87171', '#2dd4bf', '#fb923c', '#e879f9'];
const vehicleColor = (i) => VEHICLE_COLORS[i % VEHICLE_COLORS.length];

// Orden de despacho: suma la cantidad por producto de una lista de paradas.
// Devuelve [[nombre, cantidad], ...] ordenado de mayor a menor.
function buildManifest(stops) {
  const totals = {};
  for (const st of (stops || [])) {
    for (const it of (st.items || [])) {
      const name = (it.name || it.title || it.product_name || 'Sin nombre').trim() || 'Sin nombre';
      const qty  = Number(it.quantity) || 0;
      if (!qty) continue;
      totals[name] = (totals[name] || 0) + qty;
    }
  }
  return Object.entries(totals).sort((a, b) => b[1] - a[1]);
}
const manifestUnits = (manifest) => manifest.reduce((s, [, q]) => s + q, 0);

// ─── Componente principal ────────────────────────────────────────────────────

export default function RepartosPanel() {
  const { colors } = useTheme();
  const [tab, setTab] = useState('nuevo'); // 'nuevo' | 'historial'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden', backgroundColor: colors.bgPanel }}>
      {/* Header */}
      <div style={{ padding: '20px 24px 0', borderBottom: `1px solid ${colors.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
          <Truck size={22} color={colors.green} />
          <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: colors.textPrimary }}>Repartos</h2>
        </div>
        <div style={{ display: 'flex', gap: '4px' }}>
          {[
            { key: 'nuevo',     label: '+ Nuevo reparto' },
            { key: 'despachos', label: '📦 Despachos' },
            { key: 'historial', label: '🚚 Rutas' },
            { key: 'gastos',    label: '💸 Gastos' },
          ].map(({ key, label }) => (
            <button key={key} onClick={() => setTab(key)} style={{
              padding: '8px 16px', borderRadius: '8px 8px 0 0', border: 'none', cursor: 'pointer',
              fontWeight: 600, fontSize: '13px', transition: 'all 0.15s',
              backgroundColor: tab === key ? colors.bgCard : 'transparent',
              color: tab === key ? colors.green : colors.textSecondary,
              borderBottom: tab === key ? `2px solid ${colors.green}` : '2px solid transparent',
            }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Contenido */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {tab === 'nuevo'     && <NuevoReparto colors={colors} />}
        {tab === 'despachos' && <DespachosRepartos colors={colors} />}
        {tab === 'historial' && <HistorialRepartos colors={colors} />}
        {tab === 'gastos'    && <GastosRepartos colors={colors} />}
      </div>
    </div>
  );
}

// ─── Tab: Nuevo reparto ──────────────────────────────────────────────────────

const STEPS = ['select', 'optimize', 'assign', 'done'];

function NuevoReparto({ colors }) {
  const [step,           setStep]           = useState('select');
  const [orders,         setOrders]         = useState([]);
  const [loadingOrders,  setLoadingOrders]  = useState(true);
  const [selected,       setSelected]       = useState(new Set());
  const [optimizing,     setOptimizing]     = useState(false);
  const [optimizedRoute, setOptimizedRoute] = useState(null);
  const [driverName,     setDriverName]     = useState('');
  const [driverPhone,    setDriverPhone]    = useState('');
  const [drivers,        setDrivers]        = useState([]);     // usuarios con rol repartidor
  const [driverUserId,   setDriverUserId]   = useState('');     // '' = escribir a mano
  const [sending,        setSending]        = useState(false);
  const [sentRoute,      setSentRoute]      = useState(null);
  const [error,          setError]          = useState(null);
  const [editingAddr,    setEditingAddr]    = useState(null); // key de orden en edición
  const [addrDraft,      setAddrDraft]      = useState('');

  // Multi-vehículo
  const [vehicles,      setVehicles]      = useState(1);        // cuántos vehículos
  const [warehouse,     setWarehouse]     = useState(null);     // { address, lat, lng, geocoded }
  const [optRoutes,     setOptRoutes]     = useState([]);       // rutas optimizadas (una por vehículo)
  const [routeDrivers,  setRouteDrivers]  = useState({});       // vehicleIndex → driverUserId
  const [reschedId,     setReschedId]     = useState(null);     // `${source}_${id}` con el selector de fecha abierto
  const [reschedDate,   setReschedDate]   = useState('');       // YYYY-MM-DD elegida

  useEffect(() => {
    setLoadingOrders(true);
    api.get('/delivery/orders')
      .then(r => {
        setOrders(r.data.orders || []);
        setSelected(new Set((r.data.orders || []).map(o => `${o.source}_${o.id}`)));
      })
      .catch(e => setError(e.response?.data?.error || e.message))
      .finally(() => setLoadingOrders(false));

    // Repartidores con cuenta (rol 'repartidor'). Si hay uno solo, preseleccionarlo.
    api.get('/delivery/drivers')
      .then(r => {
        const list = r.data.drivers || [];
        setDrivers(list);
        if (list.length === 1) selectDriver(String(list[0].id), list);
      })
      .catch(() => setDrivers([]));

    // Bodega (origen/destino de las rutas)
    api.get('/settings/warehouse')
      .then(r => setWarehouse(r.data.warehouse || null))
      .catch(() => setWarehouse(null));
  }, []);

  function selectDriver(value, list = drivers) {
    setDriverUserId(value);
    const d = list.find(x => String(x.id) === String(value));
    if (d) {
      setDriverName(d.name || d.email || '');
      setDriverPhone(d.whatsapp_phone || '');
    } else {
      setDriverName('');
      setDriverPhone('');
    }
  }

  function reloadOrders() {
    setLoadingOrders(true);
    api.get('/delivery/orders')
      .then(r => setOrders(r.data.orders || []))
      .catch(e => setError(e.response?.data?.error || e.message))
      .finally(() => setLoadingOrders(false));
  }

  async function saveReschedule(o) {
    if (!reschedDate) return;
    try {
      await api.patch('/orders/reschedule', { source: o.source, id: o.id, date: reschedDate });
      setReschedId(null); setReschedDate('');
      reloadOrders();
    } catch (e) { alert(e.response?.data?.error || e.message); }
  }

  function toggleOrder(o) {
    const k = `${o.source}_${o.id}`;
    setSelected(prev => {
      const n = new Set(prev);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });
  }

  const selectedOrders = orders.filter(o => selected.has(`${o.source}_${o.id}`));

  async function handleOptimize() {
    if (selectedOrders.length === 0) return;
    setOptimizing(true);
    setError(null);
    try {
      const r = await api.post('/delivery/optimize', { orders: selectedOrders, vehicles }, { timeout: 90000 });
      const routes = r.data.routes || (r.data.route ? [{ vehicle: 1, stops: r.data.route }] : []);
      setOptRoutes(routes);
      setOptimizedRoute(r.data);        // conserva warning/optimized/warehouse
      if (r.data.warehouse) setWarehouse(r.data.warehouse);
      // Preasignar repartidor: si hay tantos choferes como rutas, uno por ruta;
      // si hay uno solo, ese a todas.
      const preset = {};
      routes.forEach((rt, i) => {
        if (drivers.length === routes.length) preset[rt.vehicle] = String(drivers[i].id);
        else if (drivers.length === 1)        preset[rt.vehicle] = String(drivers[0].id);
      });
      setRouteDrivers(preset);
      setStep('assign');
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setOptimizing(false);
    }
  }

  async function handleSend() {
    setSending(true);
    setError(null);
    try {
      let sentCount = 0;
      let skippedAll = [];
      for (const rt of optRoutes) {
        const drvId = routeDrivers[rt.vehicle] ? parseInt(routeDrivers[rt.vehicle], 10) : null;
        const drv   = drivers.find(d => String(d.id) === String(drvId));
        const name  = optRoutes.length > 1
          ? `Reparto ${new Date().toLocaleDateString('es-CL')} — Vehículo ${rt.vehicle}`
          : `Reparto ${new Date().toLocaleDateString('es-CL')}`;
        const { data } = await api.post('/delivery/routes', {
          name,
          orders:         rt.stops,
          optimizedRoute: rt.stops,
          totalDistance:  rt.totalDistance,
          totalDuration:  rt.totalDuration,
          mapsUrl:        rt.mapsUrl,
          driverName:     drv?.name || null,
          driverPhone:    drv?.whatsapp_phone || null,
          driverUserId:   drvId,
          send:           true,
        }, { timeout: 60000 });
        if (Array.isArray(data?.skipped)) skippedAll = skippedAll.concat(data.skipped);
        sentCount++;
      }
      // Avisar si el backend omitió pedidos ya entregados/pagados/cancelados
      setSentRoute({ count: sentCount, skipped: skippedAll });
      setStep('done');
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setSending(false);
    }
  }

  async function saveAddress(order) {
    if (!addrDraft.trim()) return;
    try {
      await api.patch(`/orders/${order.id}/address`, { address: addrDraft.trim() });
      // Actualizar localmente
      setOrders(prev => prev.map(o =>
        o.source === 'bot' && String(o.id) === String(order.id)
          ? { ...o, fullAddress: addrDraft.trim(), address: addrDraft.trim() }
          : o
      ));
      setEditingAddr(null);
      setAddrDraft('');
    } catch (e) {
      setError(e.response?.data?.error || 'Error guardando dirección');
    }
  }

  async function handleExportXlsx() {
    if (selectedOrders.length === 0) return;
    const XLSX = await import('xlsx');

    // ── Hoja 1: Despacho (formato software externo) ──────────────
    const HEADERS = [
      'Título* Requerido', 'Dirección completa* Requerida', 'Carga',
      'Hora inicial', 'Hora final', 'Tiempo de servicio', 'Notas',
      'Latitud', 'Longitud', 'ID de referencia', 'Habilidades requeridas',
      'Habilidades opcionales', 'Persona de contacto', 'Teléfono de contacto',
      'Hora inicial 2', 'Hora final 2', 'Carga 2', 'Carga 3', 'Prioridad',
      'SMS', 'Correo electrónico de contacto', 'Carga pick', 'Carga pick 2',
      'Carga pick 3', 'Fecha programada', 'Tipo de visita',
    ];

    const despachoRows = selectedOrders.map(o => {
      const row = new Array(26).fill('');
      // Col A: #IDNombre
      row[0] = `${o.orderName}${o.customerName}`;
      // Col B: Dirección
      row[1] = o.fullAddress || '';
      // Col G: Notas (items)
      row[6] = (o.items || []).map(i => {
        const name  = i.name || i.title || i.product_name || '?';
        const price = i.price ? ` - $${Number(i.price).toLocaleString('es-CL')}` : '';
        return `${i.quantity}x ${name}${price}`;
      }).join(', ');
      // Col N: Teléfono — solo dígitos, sin 56 ni +56
      const phone = (o.phone || '').replace(/\D/g, '').replace(/^56/, '');
      if (phone) row[13] = Number(phone);
      return row;
    });

    const ws1 = XLSX.utils.aoa_to_sheet([HEADERS, ...despachoRows]);

    // ── Hoja 2: Resumen de productos ──────────────────────────────
    const totals = {};
    for (const o of selectedOrders) {
      for (const i of (o.items || [])) {
        const name  = i.name || i.title || i.product_name || 'Sin nombre';
        const price = Number(i.price) || 0;
        const qty   = Number(i.quantity) || 0;
        if (!totals[name]) totals[name] = { qty: 0, price };
        totals[name].qty   += qty;
        totals[name].price  = price; // último precio visto
      }
    }
    const resumenHeaders = ['Producto', 'Cantidad Total', 'Precio Unitario', 'Total'];
    const resumenRows = Object.entries(totals)
      .sort((a, b) => b[1].qty - a[1].qty)
      .map(([name, { qty, price }]) => [
        name, qty,
        price ? `$${price.toLocaleString('es-CL')}` : '—',
        price ? `$${(qty * price).toLocaleString('es-CL')}` : '—',
      ]);

    const ws2 = XLSX.utils.aoa_to_sheet([resumenHeaders, ...resumenRows]);

    // ── Generar archivo ───────────────────────────────────────────
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws1, 'Hoja 91');
    XLSX.utils.book_append_sheet(wb, ws2, 'Resumen productos');
    XLSX.writeFile(wb, `despacho_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  function reset() {
    setStep('select');
    setOptimizedRoute(null);
    setOptRoutes([]);
    setRouteDrivers({});
    setSentRoute(null);
    setError(null);
    // Recargar pedidos
    setLoadingOrders(true);
    api.get('/delivery/orders')
      .then(r => {
        setOrders(r.data.orders || []);
        setSelected(new Set((r.data.orders || []).map(o => `${o.source}_${o.id}`)));
      })
      .finally(() => setLoadingOrders(false));
  }

  const s = panelStyles(colors);

  // ── Step done ───────────────────────────────────────────────────
  if (step === 'done' && sentRoute) {
    const n = sentRoute.count || 1;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '16px' }}>
        <div style={{ fontSize: '56px' }}>✅</div>
        <h3 style={{ color: colors.textPrimary, margin: 0, fontSize: '20px', fontWeight: 800 }}>
          {n > 1 ? `${n} rutas enviadas` : 'Ruta enviada'}
        </h3>
        <p style={{ color: colors.textSecondary, margin: 0, textAlign: 'center' }}>
          {n > 1 ? `${n} vehículos · ` : ''}{selectedOrders.length - (sentRoute.skipped?.length || 0)} paradas en total
        </p>
        {sentRoute.skipped?.length > 0 && (
          <div style={{ maxWidth: 420, padding: '12px 14px', backgroundColor: `${colors.orange || '#e8a33d'}18`, border: `1px solid ${colors.orange || '#e8a33d'}55`, borderRadius: '10px', color: colors.textSecondary, fontSize: '13px' }}>
            <div style={{ fontWeight: 700, color: colors.textPrimary, marginBottom: 6 }}>
              ⏭️ {sentRoute.skipped.length} pedido{sentRoute.skipped.length > 1 ? 's' : ''} no disponible{sentRoute.skipped.length > 1 ? 's' : ''} para despachar hoy — no se enviaron
            </div>
            {sentRoute.skipped.slice(0, 12).map((o, i) => (
              <div key={i}>• {o.customerName || o.orderName || o.id}</div>
            ))}
          </div>
        )}
        <button onClick={reset} style={{ ...s.btn, marginTop: '8px' }}>
          Crear otro reparto
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Columna izquierda: selección de pedidos */}
      <div style={{ width: '360px', borderRight: `1px solid ${colors.border}`, display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <div style={{ padding: '16px', borderBottom: `1px solid ${colors.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: colors.textPrimary, fontWeight: 700, fontSize: '14px' }}>
            Pedidos pendientes {loadingOrders ? '' : `(${orders.length})`}
          </span>
          <span style={{ color: colors.textMuted, fontSize: '12px' }}>
            {selected.size} seleccionados
          </span>
        </div>

        {error && (
          <div style={{ margin: '12px', padding: '10px 14px', backgroundColor: `${colors.red}18`, borderRadius: '8px', color: colors.red, fontSize: '13px' }}>
            {error}
          </div>
        )}

        {loadingOrders ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.textMuted, fontSize: '14px' }}>
            Cargando pedidos...
          </div>
        ) : orders.length === 0 ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px', color: colors.textMuted }}>
            <Package size={40} opacity={0.4} />
            <p style={{ margin: 0, fontSize: '14px' }}>No hay pedidos pendientes</p>
          </div>
        ) : (
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {orders.map(o => {
              const k       = `${o.source}_${o.id}`;
              const checked = selected.has(k);
              return (
                <div key={k} onClick={() => toggleOrder(o)} style={{
                  display: 'flex', alignItems: 'flex-start', gap: '10px',
                  padding: '12px 16px', cursor: 'pointer',
                  borderBottom: `1px solid ${colors.border}`,
                  backgroundColor: checked ? `${colors.green}08` : 'transparent',
                  transition: 'background 0.1s',
                }}>
                  {/* Checkbox */}
                  <div style={{
                    width: '18px', height: '18px', borderRadius: '5px', flexShrink: 0, marginTop: '2px',
                    border: `2px solid ${checked ? colors.green : colors.border}`,
                    backgroundColor: checked ? colors.green : 'transparent',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    transition: 'all 0.1s',
                  }}>
                    {checked && <Check size={11} color="#fff" strokeWidth={3} />}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                      <span style={{ color: colors.textPrimary, fontWeight: 600, fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {o.customerName}
                      </span>
                      <span style={{ color: colors.green, fontSize: '12px', fontWeight: 700, flexShrink: 0 }}>
                        {o.totalPrice > 0 ? fmt(o.totalPrice) : '—'}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '3px' }}>
                      <MapPin size={11} color={o.fullAddress ? colors.textMuted : colors.red} />
                      {o.source === 'bot' && !o.fullAddress && editingAddr !== `${o.source}_${o.id}` ? (
                        <button
                          onClick={e => { e.stopPropagation(); setEditingAddr(`${o.source}_${o.id}`); setAddrDraft(''); }}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.red, fontSize: '12px', padding: 0, textDecoration: 'underline' }}>
                          + Agregar dirección
                        </button>
                      ) : o.source === 'bot' && editingAddr === `${o.source}_${o.id}` ? (
                        <div onClick={e => e.stopPropagation()} style={{ display: 'flex', gap: '4px', flex: 1 }}>
                          <input
                            autoFocus
                            value={addrDraft}
                            onChange={e => setAddrDraft(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') saveAddress(o); if (e.key === 'Escape') { setEditingAddr(null); setAddrDraft(''); } }}
                            placeholder="Ej: Av. Ejemplo 123, La Serena"
                            style={{ flex: 1, fontSize: '11px', padding: '2px 6px', borderRadius: '5px', border: `1px solid ${colors.border}`, backgroundColor: colors.bgCard, color: colors.textPrimary, outline: 'none' }}
                          />
                          <button onClick={() => saveAddress(o)} style={{ background: colors.green, border: 'none', borderRadius: '4px', color: '#fff', fontSize: '11px', padding: '2px 7px', cursor: 'pointer', fontWeight: 600 }}>✓</button>
                          <button onClick={() => { setEditingAddr(null); setAddrDraft(''); }} style={{ background: 'none', border: 'none', color: colors.textMuted, cursor: 'pointer', fontSize: '12px' }}>✕</button>
                        </div>
                      ) : (
                        <span style={{ color: colors.textMuted, fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {o.fullAddress || '—'}
                        </span>
                      )}
                    </div>
                    <span style={{ color: colors.textMuted, fontSize: '11px' }}>{o.orderName}</span>
                    {o.dispatchCount > 0 && (
                      <span
                        title={o.lastAttemptStatus === 'fallido' ? 'Ya salió antes y no se pudo entregar' : o.lastAttemptStatus === 'reprogramado' ? 'Reprogramado por el cliente' : 'Ya salió a reparto antes'}
                        style={{ marginLeft: '8px', fontSize: '11px', fontWeight: 700, color: '#fb923c' }}>
                        🔁 {o.dispatchCount + 1}º intento{o.lastAttemptStatus === 'fallido' ? ' · falló' : ''}
                      </span>
                    )}
                    {o.deliveryDate && (() => {
                      const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' });
                      const future = o.deliveryDate > today;
                      const [y, m, d] = o.deliveryDate.split('-');
                      return (
                        <span title={o.deliveryNote || ''} style={{ marginLeft: '8px', fontSize: '11px', fontWeight: 600, color: future ? '#c4b5fd' : '#fbbf24' }}>
                          📅 {future ? `Entregar el ${d}/${m}` : `Pedido para el ${d}/${m}`}
                        </span>
                      );
                    })()}
                    <div onClick={e => e.stopPropagation()} style={{ marginTop: '4px' }}>
                      {reschedId === `${o.source}_${o.id}` ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <input
                            type="date"
                            autoFocus
                            value={reschedDate}
                            min={new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' })}
                            onChange={e => setReschedDate(e.target.value)}
                            style={{ fontSize: '11px', padding: '2px 6px', borderRadius: '5px', border: `1px solid ${colors.border}`, backgroundColor: colors.bgCard, color: colors.textPrimary, outline: 'none' }}
                          />
                          <button onClick={() => saveReschedule(o)} disabled={!reschedDate}
                            style={{ background: '#a78bfa', border: 'none', borderRadius: '4px', color: '#fff', fontSize: '11px', padding: '2px 8px', cursor: reschedDate ? 'pointer' : 'not-allowed', fontWeight: 700, opacity: reschedDate ? 1 : 0.5 }}>Reprogramar</button>
                          <button onClick={() => { setReschedId(null); setReschedDate(''); }}
                            style={{ background: 'none', border: 'none', color: colors.textMuted, cursor: 'pointer', fontSize: '12px' }}>✕</button>
                        </div>
                      ) : (
                        <button
                          onClick={() => { setReschedId(`${o.source}_${o.id}`); setReschedDate(o.deliveryDate || ''); }}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#a78bfa', fontSize: '11px', fontWeight: 600, padding: 0 }}>
                          📅 Reprogramar a otro día
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Botones acción */}
        <div style={{ padding: '14px 16px', borderTop: `1px solid ${colors.border}`, display: 'flex', flexDirection: 'column', gap: '8px' }}>

          {/* Bodega (origen y destino de las rutas) */}
          <WarehouseEditor colors={colors} warehouse={warehouse} onSaved={setWarehouse} />

          {/* Número de vehículos */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
            <span style={{ fontSize: '12px', color: colors.textSecondary, fontWeight: 600 }}>🚚 Vehículos</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
              <button onClick={() => setVehicles(v => Math.max(1, v - 1))}
                style={{ width: '28px', height: '28px', borderRadius: '7px', border: `1px solid ${colors.border}`, background: colors.bgCard, color: colors.textPrimary, cursor: 'pointer', fontWeight: 700, fontSize: '16px' }}>−</button>
              <span style={{ width: '34px', textAlign: 'center', color: colors.textPrimary, fontWeight: 700, fontSize: '15px' }}>{vehicles}</span>
              <button onClick={() => setVehicles(v => Math.min(8, v + 1))}
                style={{ width: '28px', height: '28px', borderRadius: '7px', border: `1px solid ${colors.border}`, background: colors.bgCard, color: colors.textPrimary, cursor: 'pointer', fontWeight: 700, fontSize: '16px' }}>+</button>
            </div>
          </div>

          <button
            onClick={handleOptimize}
            disabled={selectedOrders.length === 0 || optimizing}
            style={{
              ...s.btn,
              width: '100%',
              opacity: selectedOrders.length === 0 ? 0.4 : 1,
              gap: '8px',
            }}>
            {optimizing ? 'Optimizando...'
              : vehicles > 1
                ? `Optimizar en ${vehicles} rutas (${selectedOrders.length})`
                : `Optimizar ruta (${selectedOrders.length})`}
          </button>
          <button
            onClick={handleExportXlsx}
            disabled={selectedOrders.length === 0}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
              width: '100%', padding: '9px 18px', borderRadius: '10px', fontWeight: 600,
              fontSize: '13px', cursor: selectedOrders.length === 0 ? 'not-allowed' : 'pointer',
              border: '1px solid #22c55e44', backgroundColor: '#052010', color: '#4ade80',
              opacity: selectedOrders.length === 0 ? 0.4 : 1,
            }}>
            <Download size={14} /> Exportar despacho ({selectedOrders.length})
          </button>
        </div>
      </div>

      {/* Panel derecho: resultado de optimización + formulario */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {step === 'select' && !optimizing && (() => {
          const pts = selectedOrders.map(o => ({
            lat: o.lat, lng: o.lng, name: o.customerName, address: o.fullAddress,
          }));
          const withCoords   = pts.filter(p => typeof p.lat === 'number' && typeof p.lng === 'number');
          const sinUbicar    = selectedOrders.length - withCoords.length;
          return (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ flex: 1, minHeight: 0, padding: '16px' }}>
                <RouteMap points={pts} warehouse={warehouse} colors={colors} />
              </div>
              <div style={{ padding: '0 16px 14px', color: colors.textMuted, fontSize: '12px' }}>
                {withCoords.length > 0
                  ? <>📍 {withCoords.length} de {selectedOrders.length} pedidos ubicados en el mapa.{sinUbicar > 0 ? ` ${sinUbicar} sin ubicar (dirección no reconocida).` : ''}</>
                  : selectedOrders.length > 0
                    ? '⚠️ No se pudo ubicar ningún pedido. Falta configurar GOOGLE_MAPS_API_KEY en el backend, o las direcciones no son reconocibles.'
                    : 'Selecciona pedidos para verlos en el mapa.'}
              </div>
            </div>
          );
        })()}

        {optimizing && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
            <div style={{ fontSize: '36px', animation: 'spin 1s linear infinite' }}>🗺</div>
            <p style={{ color: colors.textSecondary, margin: 0 }}>Calculando ruta optimizada...</p>
          </div>
        )}

        {step === 'assign' && optRoutes.length > 0 && (
          <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>

            {optimizedRoute?.optimized === false && (
              <div style={{ fontSize: '12px', color: '#fbbf24', backgroundColor: '#2a1f08', border: '1px solid #78350f', borderRadius: '8px', padding: '10px 12px', marginBottom: '16px', lineHeight: 1.4 }}>
                {optimizedRoute.warning || 'Rutas sin optimizar (revisa la configuración de Google Maps y la bodega).'}
              </div>
            )}

            {/* Orden de despacho total: qué preparar en bodega */}
            {(() => {
              const manifest = buildManifest(optRoutes.flatMap(rt => rt.stops || []));
              if (!manifest.length) return null;
              return (
                <div style={{ border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '14px', marginBottom: '20px', backgroundColor: colors.bgCard }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                    <Package size={16} color={colors.green} />
                    <span style={{ color: colors.textPrimary, fontWeight: 800, fontSize: '14px' }}>Orden de despacho</span>
                    <span style={{ marginLeft: 'auto', color: colors.textMuted, fontSize: '12px' }}>{manifestUnits(manifest)} u. en total</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                    {manifest.map(([name, qty]) => (
                      <div key={name} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '13px', paddingBottom: '5px', borderBottom: `1px solid ${colors.border}` }}>
                        <span style={{ color: colors.textSecondary }}>{name}</span>
                        <span style={{ color: colors.textPrimary, fontWeight: 700, flexShrink: 0 }}>{qty}</span>
                      </div>
                    ))}
                  </div>
                  {optRoutes.length > 1 && (
                    <p style={{ margin: '10px 0 0', fontSize: '11px', color: colors.textMuted }}>Abajo, el detalle de qué cargar en cada vehículo.</p>
                  )}
                </div>
              );
            })()}

            {/* Mapa general con todas las rutas (una por color) */}
            {optRoutes.some(rt => (rt.stops || []).some(s => typeof s.lat === 'number')) && (
              <div style={{ height: '300px', marginBottom: '20px' }}>
                <RouteMap
                  colors={colors}
                  warehouse={warehouse}
                  routes={optRoutes.map((rt, i) => ({
                    color: vehicleColor(i),
                    ordered: true,
                    points: (rt.stops || []).map(s => ({
                      lat: s.lat, lng: s.lng, label: s.stopNumber, name: s.customerName, address: s.fullAddress,
                    })),
                  }))}
                />
              </div>
            )}

            {/* Una tarjeta por vehículo */}
            {optRoutes.map((rt, i) => {
              const color = vehicleColor(i);
              return (
                <div key={rt.vehicle} style={{ border: `1px solid ${colors.border}`, borderLeft: `4px solid ${color}`, borderRadius: '12px', marginBottom: '16px', overflow: 'hidden' }}>
                  {/* Cabecera del vehículo */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 14px', backgroundColor: colors.bgCard }}>
                    <span style={{ width: '24px', height: '24px', borderRadius: '6px', backgroundColor: color, color: '#fff', fontWeight: 800, fontSize: '13px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{rt.vehicle}</span>
                    <span style={{ color: colors.textPrimary, fontWeight: 700, fontSize: '14px' }}>
                      {optRoutes.length > 1 ? `Vehículo ${rt.vehicle}` : 'Ruta'}
                    </span>
                    <span style={{ marginLeft: 'auto', color: colors.textMuted, fontSize: '12px' }}>
                      {(rt.stops || []).length} paradas{rt.totalDistance ? ` · ${rt.totalDistance}` : ''}{rt.totalDuration ? ` · ${rt.totalDuration}` : ''}
                    </span>
                  </div>

                  {/* Orden de despacho: qué cargar en este vehículo */}
                  {optRoutes.length > 1 && (() => {
                    const manifest = buildManifest(rt.stops);
                    if (!manifest.length) return null;
                    return (
                      <div style={{ padding: '10px 14px', borderTop: `1px solid ${colors.border}`, backgroundColor: `${color}0d` }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                          <Package size={14} color={color} />
                          <span style={{ color: colors.textPrimary, fontWeight: 700, fontSize: '12px' }}>Cargar en este vehículo · {manifestUnits(manifest)} u.</span>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                          {manifest.map(([name, qty]) => (
                            <div key={name} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '13px' }}>
                              <span style={{ color: colors.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                              <span style={{ color: colors.textPrimary, fontWeight: 700, flexShrink: 0 }}>{qty}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Selector de repartidor de esta ruta */}
                  {drivers.length > 0 && (
                    <div style={{ padding: '10px 14px', borderTop: `1px solid ${colors.border}` }}>
                      <select
                        value={routeDrivers[rt.vehicle] || ''}
                        onChange={e => setRouteDrivers(prev => ({ ...prev, [rt.vehicle]: e.target.value }))}
                        style={{ ...inputStyle(colors), width: '100%', cursor: 'pointer' }}>
                        <option value="">— Sin asignar (la ve cualquier repartidor) —</option>
                        {drivers.map(d => (
                          <option key={d.id} value={d.id}>{d.name || d.email}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Paradas en orden */}
                  <div>
                    {(rt.stops || []).map((stop, idx) => (
                      <div key={`${stop.source}_${stop.id}`} style={{
                        display: 'flex', alignItems: 'center', gap: '12px',
                        padding: '9px 14px', borderTop: `1px solid ${colors.border}`,
                      }}>
                        <div style={{ width: '24px', height: '24px', borderRadius: '12px', backgroundColor: color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <span style={{ color: '#fff', fontSize: '11px', fontWeight: 800 }}>{stop.stopNumber || idx + 1}</span>
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ color: colors.textPrimary, fontWeight: 600, fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{stop.customerName}</div>
                          <div style={{ color: colors.textMuted, fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{stop.fullAddress || 'Sin dirección'}</div>
                        </div>
                        {stop.durationText && (
                          <span style={{ color: colors.textMuted, fontSize: '11px', flexShrink: 0 }}>{stop.durationText}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}

            {drivers.length === 0 && (
              <p style={{ color: colors.textMuted, fontSize: '12px', margin: '0 0 14px', lineHeight: 1.5 }}>
                No hay usuarios con rol Repartidor. Créalos en Ajustes → Usuarios para asignar cada ruta; mientras tanto quedan sin asignar y las ve cualquier repartidor que entre.
              </p>
            )}

            {error && (
              <div style={{ padding: '10px 14px', backgroundColor: `${colors.red}18`, borderRadius: '8px', color: colors.red, fontSize: '13px', marginBottom: '16px' }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={() => setStep('select')} disabled={sending}
                style={{ padding: '14px 18px', borderRadius: '10px', border: `1px solid ${colors.border}`, background: 'none', color: colors.textSecondary, cursor: 'pointer', fontSize: '14px', fontWeight: 600 }}>
                Volver
              </button>
              <button onClick={handleSend} disabled={sending} style={{ ...s.btn, flex: 1, gap: '8px', fontSize: '15px', padding: '14px' }}>
                <Send size={16} />
                {sending ? 'Enviando...' : optRoutes.length > 1 ? `Enviar ${optRoutes.length} rutas` : 'Enviar al repartidor'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Tab: Historial de rutas ─────────────────────────────────────────────────

// ─── DESPACHOS: qué entregó el repartidor, por día ───────────────────────────
//
// Una fila por parada: estado que dejó el repartidor, hora, medio de pago y
// situación de cobranza. Agrupado por día con totales. Filtros por rango,
// repartidor, medio de pago y estado. Exporta CSV.

const CLP = n => `$${Math.round(Number(n) || 0).toLocaleString('es-CL')}`;

// Rellena el cuerpo (BODY) de un template de WhatsApp con los datos reales del
// pedido, para la vista previa del cobro. Parámetros: {{1}} nombre, {{2}} pedido,
// {{3}} total, {{4}} datos bancarios.
function fillTemplateBody(tpl, row, bank) {
  const body = (tpl?.components || []).find(c => String(c.type || '').toUpperCase() === 'BODY');
  const text = body?.text || '';
  if (!text) return '(Este template no tiene texto de cuerpo para previsualizar.)';
  const rawFirst = String(row?.customer_name || '').trim().split(/\s+/)[0];
  const first = rawFirst ? (rawFirst.charAt(0).toUpperCase() + rawFirst.slice(1).toLowerCase()) : 'Hola';
  const vals = { '1': first, '2': row?.order_label || `#${row?.order_id}`, '3': CLP(row?.total || 0), '4': bank || '-' };
  return text.replace(/\{\{(\d+)\}\}/g, (_, n) => (vals[n] != null ? vals[n] : `{{${n}}}`));
}
const isoDay = d => new Date(d).toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' });
const PAY_META = {
  efectivo:      { label: 'Efectivo',      icon: '💵', color: '#22c55e' },
  transferencia: { label: 'Transferencia', icon: '🏦', color: '#38bdf8' },
  otro:          { label: 'Otro',          icon: '💳', color: '#a78bfa' },
};
const STOP_META = {
  entregado: { label: 'Entregado',    color: '#2dd4bf' },
  cancelled: { label: 'Fallido',      color: '#f87171' },
  postponed: { label: 'Reprogramado', color: '#a78bfa' },
  pending:   { label: 'Pendiente',    color: '#fb923c' },
};

function chargeInfo(row) {
  if (row.status !== 'entregado') return null;
  if (row.paid) return { label: 'Pagado', color: '#22c55e', icon: '✅' };
  if (row.payment_method === 'efectivo') return { label: 'Efectivo al entregar', color: '#22c55e', icon: '💵' };
  if (row.payment_method !== 'transferencia') return null;
  if (row.charge?.sent_at) {
    const when = new Date(row.charge.sent_at).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Santiago' });
    return { label: `Cobro enviado ${when}${row.charge.count > 1 ? ` (×${row.charge.count})` : ''}${row.charge.pending ? ' · sin comprobante' : ''}`, color: row.charge.pending ? '#fbbf24' : '#22c55e', icon: '💸' };
  }
  if (row.charge?.pending) return { label: 'Cobro NO enviado — por cobrar', color: '#f87171', icon: '⚠️' };
  return { label: 'Transferencia', color: '#38bdf8', icon: '🏦' };
}

function DespachosRepartos({ colors }) {
  const today = isoDay(new Date());
  const weekAgo = isoDay(Date.now() - 6 * 86400000);
  const [from,    setFrom]    = useState(weekAgo);
  const [to,      setTo]      = useState(today);
  const [driver,  setDriver]  = useState('');
  const [pay,     setPay]     = useState('');
  const [status,  setStatus]  = useState('');
  const [drivers, setDrivers] = useState([]);
  const [rows,    setRows]    = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [openDays, setOpenDays] = useState({});
  const [charging, setCharging] = useState('');   // día que está enviando cobros
  const [chargeMsg, setChargeMsg] = useState(null);
  const [chargeModal, setChargeModal] = useState(null);   // { day, rows } — modal de cobro
  const [chargeTpls,  setChargeTpls]  = useState([]);     // templates aprobados
  const [chargeTpl,   setChargeTpl]   = useState('');     // template elegido
  const [chargeBank,  setChargeBank]  = useState('');     // datos bancarios ({{4}})
  const [chargeIdx,   setChargeIdx]   = useState(0);      // destinatario en la vista previa
  const [chargeSel,   setChargeSel]   = useState(new Set());  // stop_keys a los que SI se cobra
  const [payBusy,     setPayBusy]     = useState('');     // stop_key cuyo medio de pago se está guardando
  const [editTot,     setEditTot]     = useState(null);   // stop_key con el total en edición
  const [editTotVal,  setEditTotVal]  = useState('');
  const [canEditItems, setCanEditItems] = useState(false);  // módulo edit_delivered_items
  const [itemsModal, setItemsModal] = useState(null);  // { source, id, name, label }
  const [itemRows,   setItemRows]   = useState(null);  // null = cargando
  const [itemsBusy,  setItemsBusy]  = useState(false);

  useEffect(() => {
    api.get('/delivery/drivers').then(r => setDrivers(r.data.drivers || [])).catch(() => {});
    api.get('/settings/modules').then(r => setCanEditItems(!!(r.data?.modules?.edit_delivered_items))).catch(() => {});
  }, []);

  // Abre el modal de cobro: elige template y muestra la vista previa antes de enviar.
  async function openChargeModal(d, ev) {
    ev?.stopPropagation?.();
    const pend = (d.rows || []).filter(r =>
      r.status === 'entregado' && r.payment_method === 'transferencia' && r.charge?.pending
    );
    if (!pend.length) return;
    setChargeModal({ day: d.day, rows: pend });
    setChargeIdx(0); setChargeMsg(null);
    setChargeSel(new Set(pend.map(r => r.stop_key)));
    try {
      const [tplRes, cfgRes] = await Promise.all([
        api.get('/templates').catch(() => ({ data: { data: [] } })),
        api.get('/settings/charge-settings').catch(() => ({ data: {} })),
      ]);
      const all = tplRes.data?.data || tplRes.data || [];
      const approved = all.filter(t => t.status === 'APPROVED');
      setChargeTpls(approved);
      const cfg = cfgRes.data?.data || cfgRes.data || {};
      setChargeBank(cfg.bankDetails || '');
      const def = cfg.waTemplate && approved.some(t => t.name === cfg.waTemplate)
        ? cfg.waTemplate : (approved[0]?.name || '');
      setChargeTpl(def);
    } catch { /* si falla, el modal igual permite enviar con el template de Ajustes */ }
  }

  // Envía el cobro con el template elegido (o el de Ajustes si no hay lista).
  async function doCharge() {
    if (!chargeModal) return;
    const day = chargeModal.day;
    const orders = (chargeModal.rows || [])
      .filter(r => chargeSel.has(r.stop_key))
      .map(r => ({ source: r.source, id: r.order_id }));
    if (!orders.length) { setChargeMsg({ day, text: 'Selecciona al menos un cliente', ok: false }); return; }
    setCharging(day);
    try {
      const { data } = await api.post('/orders/send-charge', { orders, template: chargeTpl || undefined });
      const sent = data.sent || 0, failed = data.failed || 0;
      setChargeMsg({ day, text: failed === 0 ? `\u2705 ${sent} cobro(s) enviado(s)` : `Enviados ${sent}, fallaron ${failed}. Revisa que el template esté aprobado (Ajustes \u2192 Cobranza).`, ok: failed === 0 });
      load();
    } catch (e) {
      setChargeMsg({ day, text: e.response?.data?.error || 'Error enviando los cobros', ok: false });
    } finally { setCharging(''); setChargeModal(null); }
  }

  // Cambiar a mano el medio de pago de un pedido desde la tabla (corrige si el
  // repartidor se equivocó). Refresca para recalcular pagos y cobranza.
  async function changePay(r, method) {
    setPayBusy(r.stop_key);
    try {
      // El pago que se ve en Despachos viene de la ruta (stop_payments), no de
      // la tabla orders. Hay que actualizar la parada de la ruta y además
      // reconciliar el pedido (estado de pago / cobranza).
      if (r.route_id) {
        await api.patch(`/delivery/routes/${r.route_id}/stop-payment`, { stopKey: r.stop_key, paymentMethod: method });
      }
      await api.patch('/orders/payment-method', { source: r.source, id: r.order_id, paymentMethod: method });
      load();
    } catch (e) {
      alert(e.response?.data?.error || 'No se pudo cambiar el medio de pago');
    } finally { setPayBusy(''); }
  }

  // Corrige el monto real del pedido (lo entregado != lo pedido). Afecta el cobro y los totales.
  async function saveTotal(r) {
    const v = Math.round(Number(editTotVal));
    setEditTot(null);
    if (!Number.isFinite(v) || v < 0 || v === Math.round(r.total || 0)) return;
    try {
      await api.patch('/orders/adjust-total', { source: r.source, id: r.order_id, total: v });
      load();
    } catch (e) {
      alert(e.response?.data?.error || 'No se pudo corregir el monto');
    }
  }

  // Editor de productos entregados (recalcula total). Bajo el modulo edit_delivered_items.
  async function openItems(r) {
    setItemsModal({ source: r.source, id: r.order_id, name: r.customer_name || 'cliente', label: r.order_label || '' });
    setItemRows(null);
    try {
      const { data } = await api.get(`/orders/order-items?source=${r.source}&id=${encodeURIComponent(r.order_id)}`);
      setItemRows((data.items || []).map(i => ({ name: i.name || '', quantity: Number(i.quantity) || 0, price: Number(i.price) || 0, extra: !!i.extra })));
    } catch (e) { setItemRows([]); }
  }
  const setItem = (i, patch) => setItemRows(prev => prev.map((it, k) => k === i ? { ...it, ...patch } : it));
  const removeItem = (i) => setItemRows(prev => prev.filter((_, k) => k !== i));
  const addItem = () => setItemRows(prev => [...(prev || []), { name: '', quantity: 1, price: 0, extra: true }]);
  async function saveItems() {
    if (!itemsModal || !itemRows) return;
    setItemsBusy(true);
    try {
      await api.patch('/orders/set-items', { source: itemsModal.source, id: itemsModal.id, items: itemRows });
      setItemsModal(null); setItemRows(null); load();
    } catch (e) { alert(e.response?.data?.error || 'No se pudo guardar'); }
    finally { setItemsBusy(false); }
  }

  const load = useCallback(() => {
    setLoading(true); setError(null);
    const q = new URLSearchParams({ from, to });
    if (driver) q.set('driver', driver);
    Promise.all([
      api.get(`/delivery/dispatches?${q.toString()}`),
      api.get(`/delivery/expenses?from=${from}&to=${to}`).catch(() => ({ data: { expenses: [] } })),
    ])
      .then(([disp, exp]) => {
        setRows(disp.data.rows || []);
        setExpenses(exp.data.expenses || []);
      })
      .catch(e => setError(e.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  }, [from, to, driver]);

  useEffect(() => { load(); }, [load]);

  const filtered = rows.filter(r =>
    (!pay    || r.payment_method === pay) &&
    (!status || r.status === status)
  );

  // Agrupar por día (más reciente primero) con totales
  const days = [];
  const byDay = {};
  for (const r of filtered) {
    if (!byDay[r.day]) { byDay[r.day] = { day: r.day, rows: [], entregados: 0, fallidos: 0, reprogramados: 0, pendientes: 0, efectivo: 0, transferencia: 0, otro: 0, cobrosEnviados: 0, cobrosPendientes: 0, extras: 0 }; days.push(byDay[r.day]); }
    const d = byDay[r.day];
    d.rows.push(r);
    if (r.status === 'entregado') {
      d.entregados++;
      const amount = (r.total || 0) + (r.extra_total || 0);
      if (r.payment_method === 'efectivo') d.efectivo += amount;
      else if (r.payment_method === 'transferencia') d.transferencia += amount;
      else if (r.payment_method) d.otro += amount;
      if (r.payment_method === 'transferencia') {
        if (r.charge?.sent_at) d.cobrosEnviados++;
        else if (r.charge?.pending) d.cobrosPendientes++;
      }
      d.extras += r.extra_total || 0;
    } else if (r.status === 'cancelled') d.fallidos++;
    else if (r.status === 'postponed') d.reprogramados++;
    else d.pendientes++;
  }

  // ── Gastos del repartidor por día (mismo rango y filtro de repartidor) ──
  const clDay = ts => { try { return new Date(ts).toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' }); } catch { return String(ts || '').slice(0, 10); } };
  const gastosByDay = {};
  let gastosTotal = 0;
  for (const e of expenses) {
    if (driver && String(e.driver_user_id) !== String(driver)) continue;   // respeta el filtro de repartidor
    const day = clDay(e.created_at);
    const amt = Number(e.amount) || 0;
    gastosByDay[day] = (gastosByDay[day] || 0) + amt;
    gastosTotal += amt;
  }
  for (const d of days) d.gastos = gastosByDay[d.day] || 0;

  const totals = days.reduce((t, d) => ({
    entregados: t.entregados + d.entregados, fallidos: t.fallidos + d.fallidos,
    efectivo: t.efectivo + d.efectivo, transferencia: t.transferencia + d.transferencia,
    cobrosEnviados: t.cobrosEnviados + d.cobrosEnviados, cobrosPendientes: t.cobrosPendientes + d.cobrosPendientes,
  }), { entregados: 0, fallidos: 0, efectivo: 0, transferencia: 0, cobrosEnviados: 0, cobrosPendientes: 0 });
  totals.gastos = gastosTotal;
  totals.netoEfectivo = totals.efectivo - gastosTotal;   // efectivo recaudado menos lo que gastó el repartidor

  const dayLabel = day => new Date(day + 'T12:00:00').toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' });
  const timeOf = r => new Date(r.at).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Santiago' });

  function exportCSV() {
    const head = ['Fecha', 'Hora', 'Repartidor', 'Ruta', 'Pedido', 'Cliente', 'Teléfono', 'Dirección', 'Productos', 'Estado', 'Medio de pago', 'Total', 'Extras', 'Cobro', 'Nota'];
    const lines = filtered.map(r => [
      r.day, r.time_is_exact ? timeOf(r) : '', r.driver_name || '', r.route_name, r.order_label, r.customer_name || '', r.phone || '',
      r.address || '', (r.items || []).map(i => `${i.quantity}x ${i.name}`).join(' | '),
      STOP_META[r.status]?.label || r.status, PAY_META[r.payment_method]?.label || '',
      Math.round(r.total || 0), Math.round(r.extra_total || 0), chargeInfo(r)?.label || '', r.note || '',
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(';'));
    const blob = new Blob(['﻿' + [head.join(';'), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `despachos_${from}_${to}.csv`; a.click();
    URL.revokeObjectURL(a.href);
  }

  const inp = ui.input(colors, { padding: '6px 9px', backgroundColor: colors.bgCard, fontSize: '12px' });
  const chip = (text, color) => (
    <span style={ui.chip(colors, color)}>{text}</span>
  );

  return (
    <div style={{ flex: 1, minHeight: 0, height: '100%', overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {/* Filtros */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
        <label style={{ fontSize: '11px', color: colors.textMuted }}>Desde</label>
        <input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} style={inp} />
        <label style={{ fontSize: '11px', color: colors.textMuted }}>Hasta</label>
        <input type="date" value={to} min={from} max={today} onChange={e => setTo(e.target.value)} style={inp} />
        <select value={driver} onChange={e => setDriver(e.target.value)} style={inp}>
          <option value="">Todos los repartidores</option>
          {drivers.map(d => <option key={d.id} value={d.id}>{d.name || d.email}</option>)}
        </select>
        <select value={pay} onChange={e => setPay(e.target.value)} style={inp}>
          <option value="">Todo medio de pago</option>
          <option value="efectivo">💵 Efectivo</option>
          <option value="transferencia">🏦 Transferencia</option>
          <option value="otro">Otro</option>
        </select>
        <select value={status} onChange={e => setStatus(e.target.value)} style={inp}>
          <option value="">Todos los estados</option>
          <option value="entregado">Entregado</option>
          <option value="cancelled">Fallido</option>
          <option value="postponed">Reprogramado</option>
          <option value="pending">Pendiente</option>
        </select>
        <div style={{ flex: 1 }} />
        <button onClick={load} title="Actualizar" style={{ ...inp, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}><RotateCcw size={12} /></button>
        <button onClick={exportCSV} disabled={!filtered.length} style={{ ...inp, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '5px', color: colors.green }}><Download size={12} /> CSV</button>
      </div>

      {/* Totales del período */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        {chip(`${totals.entregados} entregados`, '#2dd4bf')}
        {chip(`${totals.fallidos} fallidos`, '#f87171')}
        {chip(`💵 ${CLP(totals.efectivo)} efectivo`, '#22c55e')}
        {chip(`🏦 ${CLP(totals.transferencia)} transferencia`, '#38bdf8')}
        {chip(`💸 ${totals.cobrosEnviados} cobros enviados`, '#fbbf24')}
        {totals.cobrosPendientes > 0 && chip(`⚠️ ${totals.cobrosPendientes} sin cobrar`, '#f87171')}
        {totals.gastos > 0 && chip(`🧾 ${CLP(totals.gastos)} gastos`, '#fb923c')}
        {totals.gastos > 0 && chip(`💰 ${CLP(totals.netoEfectivo)} neto efectivo`, totals.netoEfectivo >= 0 ? '#22c55e' : '#f87171')}
      </div>

      {loading && <div style={{ color: colors.textMuted, fontSize: '13px' }}>Cargando despachos…</div>}
      {error && <div style={{ color: colors.red, fontSize: '13px' }}>{error}</div>}
      {!loading && !error && days.length === 0 && (
        <div style={{ color: colors.textMuted, fontSize: '13px', padding: '30px 0', textAlign: 'center' }}>Sin despachos en este período.</div>
      )}

      {/* Por día */}
      {days.map(d => {
        const open = openDays[d.day] !== false; // abiertos por defecto
        return (
          <div key={d.day} style={{ border: `1px solid ${colors.border}`, borderRadius: '10px', overflow: 'hidden', flexShrink: 0 }}>
            <div onClick={() => setOpenDays(o => ({ ...o, [d.day]: !open }))}
              style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', backgroundColor: colors.bgCard, cursor: 'pointer', flexWrap: 'wrap' }}>
              {open ? <ChevronDown size={14} color={colors.textMuted} /> : <ChevronRight size={14} color={colors.textMuted} />}
              <span style={{ fontWeight: 700, fontSize: '13px', color: colors.textPrimary, textTransform: 'capitalize' }}>{dayLabel(d.day)}</span>
              <span style={{ fontSize: '11px', color: colors.textMuted }}>{d.rows.length} paradas</span>
              <div style={{ flex: 1 }} />
              {chip(`${d.entregados} ✓`, '#2dd4bf')}
              {d.fallidos > 0 && chip(`${d.fallidos} ✗`, '#f87171')}
              {d.reprogramados > 0 && chip(`📅 ${d.reprogramados} reprog.`, '#a78bfa')}
              {d.pendientes > 0 && chip(`${d.pendientes} pend.`, '#fb923c')}
              {chip(`💵 ${CLP(d.efectivo)}`, '#22c55e')}
              {chip(`🏦 ${CLP(d.transferencia)}`, '#38bdf8')}
              {d.transferencia > 0 && chip(`💸 ${d.cobrosEnviados}/${d.cobrosEnviados + d.cobrosPendientes} cobrados`, d.cobrosPendientes ? '#fbbf24' : '#22c55e')}
              {d.extras > 0 && chip(`🥚 +${CLP(d.extras)} extras`, '#c4b5fd')}
              {d.gastos > 0 && chip(`🧾 ${CLP(d.gastos)} gastos`, '#fb923c')}
              {d.cobrosPendientes > 0 && (
                <button
                  onClick={(ev) => openChargeModal(d, ev)}
                  disabled={charging === d.day}
                  style={{ backgroundColor: '#fbbf24', color: '#231a02', border: 'none', borderRadius: '999px', padding: '4px 12px', fontSize: '11px', fontWeight: 800, cursor: 'pointer', opacity: charging === d.day ? 0.6 : 1 }}>
                  {charging === d.day ? 'Enviando…' : `💸 Cobrar a ${d.cobrosPendientes} no cobrado${d.cobrosPendientes === 1 ? '' : 's'}`}
                </button>
              )}
            </div>
            {chargeMsg?.day === d.day && (
              <div style={{ padding: '6px 14px', fontSize: '12px', color: chargeMsg.ok ? '#22c55e' : '#f87171', backgroundColor: colors.bgCard, borderTop: `1px solid ${colors.border}` }}>
                {chargeMsg.text}
              </div>
            )}
            {open && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', minWidth: '860px' }}>
                  <thead>
                    <tr style={{ color: colors.textMuted, fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      {['Hora', 'Repartidor', 'Cliente', 'Productos', 'Estado', 'Pago', 'Total', 'Cobranza'].map(h => (
                        <th key={h} style={{ textAlign: 'left', padding: '8px 12px', borderBottom: `1px solid ${colors.border}`, fontWeight: 600 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {d.rows.map(r => {
                      const sm = STOP_META[r.status] || STOP_META.pending;
                      const pm = PAY_META[r.payment_method];
                      const ci = chargeInfo(r);
                      return (
                        <tr key={`${r.route_id}_${r.stop_key}`} style={{ borderBottom: `1px solid ${colors.border}` }}>
                          <td style={{ padding: '8px 12px', color: colors.textSecondary, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                            {r.time_is_exact ? timeOf(r) : <span title="Ruta anterior al registro de hora por parada" style={{ opacity: 0.5 }}>~{timeOf(r)}</span>}
                          </td>
                          <td style={{ padding: '8px 12px', color: colors.textSecondary, whiteSpace: 'nowrap' }}>{r.driver_name || '—'}<div style={{ fontSize: '10px', opacity: 0.7 }}>{r.route_name}</div></td>
                          <td style={{ padding: '8px 12px' }}>
                            <div style={{ color: colors.textPrimary, fontWeight: 600 }}>{r.customer_name || '—'} <span style={{ color: colors.textMuted, fontWeight: 400 }}>{r.order_label}</span></div>
                            <div style={{ color: colors.textMuted, fontSize: '11px' }}>{r.address || ''}</div>
                            {r.note && <div style={{ color: '#fbbf24', fontSize: '11px' }}>📝 {r.note}</div>}
                          </td>
                          <td style={{ padding: '8px 12px', color: colors.textSecondary }}>
                            {(r.items || []).map((i, k) => <div key={k}>{i.quantity}x {i.name}</div>)}
                            {(r.extras || []).map((e, k) => <div key={'x' + k} style={{ color: '#c4b5fd' }}>+ {e.quantity}x {e.name}</div>)}
                          </td>
                          <td style={{ padding: '8px 12px' }}>{chip(sm.label, sm.color)}</td>
                          <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>
                            <select value={r.payment_method || ''} disabled={payBusy === r.stop_key}
                              onChange={e => changePay(r, e.target.value || null)}
                              title="Cambiar medio de pago"
                              style={{ fontSize: '11px', padding: '3px 6px', borderRadius: '6px', background: colors.bgInput, color: colors.textPrimary, border: `1px solid ${colors.border}`, cursor: payBusy === r.stop_key ? 'wait' : 'pointer', opacity: payBusy === r.stop_key ? 0.6 : 1 }}>
                              <option value="">—</option>
                              <option value="efectivo">💵 Efectivo</option>
                              <option value="transferencia">🏦 Transferencia</option>
                              <option value="otro">Otro</option>
                            </select>
                          </td>
                          <td style={{ padding: '8px 12px', color: colors.textPrimary, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                            {!canEditItems ? (
                              r.status === 'entregado' ? CLP((r.total || 0) + (r.extra_total || 0)) : <span style={{ color: colors.textMuted }}>{CLP(r.total)}</span>
                            ) : (
                              <span onClick={() => openItems(r)} title="Editar productos y monto"
                                style={{ cursor: 'pointer', borderBottom: `1px dashed ${colors.blue}` }}>
                                {r.status === 'entregado' ? CLP((r.total || 0) + (r.extra_total || 0)) : <span style={{ color: colors.textMuted }}>{CLP(r.total)}</span>} <span style={{ color: colors.blue, fontSize: '11px' }}>✎</span>
                              </span>
                            )}
                          </td>
                          <td style={{ padding: '8px 12px', fontSize: '11px', color: ci?.color || colors.textMuted, whiteSpace: 'nowrap' }}>{ci ? `${ci.icon} ${ci.label}` : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}

      {chargeModal && (() => {
        const rowsM = chargeModal.rows || [];
        const selCount = rowsM.filter(r => chargeSel.has(r.stop_key)).length;
        const allSel = rowsM.length > 0 && selCount === rowsM.length;
        const idx = Math.min(chargeIdx, rowsM.length - 1);
        const row = rowsM[idx];
        const tpl = chargeTpls.find(t => t.name === chargeTpl);
        const preview = chargeTpls.length === 0
          ? '(No hay templates aprobados. Se enviará como texto normal a quienes escribieron hace menos de 24 h.)'
          : (tpl ? fillTemplateBody(tpl, row, chargeBank) : 'Elige un template para ver la vista previa.');
        return (
          <div onClick={() => { if (!charging) setChargeModal(null); }}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}>
            <div onClick={e => e.stopPropagation()}
              style={{ background: colors.bgPanel, border: `1px solid ${colors.border}`, borderRadius: 14, padding: 18, width: 'min(560px, 96vw)', maxHeight: '90vh', overflowY: 'auto' }}>
              <div style={{ color: colors.textPrimary, fontWeight: 800, fontSize: 16 }}>
                Cobrar a {rowsM.length} no cobrado{rowsM.length === 1 ? '' : 's'}
              </div>
              <div style={{ color: colors.textMuted, fontSize: 12, marginBottom: 14 }}>{dayLabel(chargeModal.day)}</div>

              <div style={{ color: colors.textSecondary, fontSize: 12, fontWeight: 700, marginBottom: 4 }}>Template a enviar</div>
              {chargeTpls.length === 0 ? (
                <div style={{ color: colors.yellow, fontSize: 12, marginBottom: 12 }}>
                  No hay templates aprobados en WhatsApp. Los que escribieron hace menos de 24 h reciben texto normal; el resto queda en “Por cobrar”.
                </div>
              ) : (
                <select value={chargeTpl} onChange={e => setChargeTpl(e.target.value)}
                  style={{ width: '100%', margin: '0 0 14px', padding: '9px 10px', borderRadius: 8, background: colors.bgInput, color: colors.textPrimary, border: `1px solid ${colors.border}`, fontSize: 13 }}>
                  {chargeTpls.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
                </select>
              )}

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ color: colors.textSecondary, fontSize: 12, fontWeight: 700 }}>Destinatarios ({selCount}/{rowsM.length})</span>
                <button onClick={() => setChargeSel(allSel ? new Set() : new Set(rowsM.map(r => r.stop_key)))}
                  style={{ background: 'none', border: 'none', color: colors.blue, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                  {allSel ? 'Ninguno' : 'Todos'}
                </button>
              </div>
              <div style={{ maxHeight: 160, overflowY: 'auto', border: `1px solid ${colors.border}`, borderRadius: 10, marginBottom: 14 }}>
                {rowsM.map((r, i) => {
                  const on = chargeSel.has(r.stop_key);
                  return (
                    <div key={r.stop_key}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderBottom: i < rowsM.length - 1 ? `1px solid ${colors.border}` : 'none', background: i === idx ? colors.bgHover : 'transparent' }}>
                      <input type="checkbox" checked={on}
                        onChange={() => setChargeSel(prev => { const n = new Set(prev); n.has(r.stop_key) ? n.delete(r.stop_key) : n.add(r.stop_key); return n; })}
                        style={{ cursor: 'pointer' }} />
                      <div onClick={() => setChargeIdx(i)} style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}>
                        <div style={{ color: colors.textPrimary, fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.customer_name || 'cliente'}</div>
                        <div style={{ color: colors.textMuted, fontSize: 11 }}>{r.order_label} · {CLP(r.total || 0)}</div>
                      </div>
                      <button onClick={() => setChargeIdx(i)} title="Ver vista previa"
                        style={{ background: 'none', border: 'none', color: i === idx ? colors.green : colors.textMuted, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>ver</button>
                    </div>
                  );
                })}
              </div>

              <div style={{ color: colors.textSecondary, fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
                Vista previa{rowsM.length > 1 ? ` (${idx + 1}/${rowsM.length})` : ''} · {row?.customer_name || 'cliente'} · {row?.order_label || ''}
              </div>
              <div style={{ whiteSpace: 'pre-wrap', background: colors.bgInput, border: `1px solid ${colors.border}`, borderRadius: 10, padding: 12, color: colors.textPrimary, fontSize: 13, minHeight: 60 }}>
                {preview}
              </div>
              {rowsM.length > 1 && (
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 8 }}>
                  <button onClick={() => setChargeIdx(i => Math.max(0, i - 1))} disabled={idx === 0}
                    style={{ background: 'none', border: `1px solid ${colors.border}`, borderRadius: 8, color: colors.textSecondary, padding: '4px 12px', cursor: idx === 0 ? 'default' : 'pointer', opacity: idx === 0 ? 0.5 : 1 }}>← Anterior</button>
                  <button onClick={() => setChargeIdx(i => Math.min(rowsM.length - 1, i + 1))} disabled={idx >= rowsM.length - 1}
                    style={{ background: 'none', border: `1px solid ${colors.border}`, borderRadius: 8, color: colors.textSecondary, padding: '4px 12px', cursor: idx >= rowsM.length - 1 ? 'default' : 'pointer', opacity: idx >= rowsM.length - 1 ? 0.5 : 1 }}>Siguiente →</button>
                </div>
              )}

              <div style={{ color: colors.textMuted, fontSize: 11, marginTop: 12 }}>
                A quienes te escribieron hace menos de 24 h les llega el mismo detalle como mensaje normal; a los demás, este template.
              </div>

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
                <button onClick={() => setChargeModal(null)} disabled={charging === chargeModal.day}
                  style={{ background: 'none', border: `1px solid ${colors.border}`, borderRadius: 8, color: colors.textSecondary, padding: '9px 14px', cursor: 'pointer', fontWeight: 700 }}>Cancelar</button>
                <button onClick={doCharge} disabled={charging === chargeModal.day || selCount === 0 || (chargeTpls.length > 0 && !chargeTpl)}
                  style={{ background: '#fbbf24', color: '#231a02', border: 'none', borderRadius: 8, padding: '9px 16px', cursor: (selCount === 0 ? 'not-allowed' : 'pointer'), fontWeight: 800, opacity: (charging === chargeModal.day || selCount === 0) ? 0.6 : 1 }}>
                  {charging === chargeModal.day ? 'Enviando…' : `Enviar a ${selCount}`}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {itemsModal && (() => {
        const rows = itemRows || [];
        const itTotal = rows.reduce((sum, i) => sum + (Number(i.price) || 0) * (Number(i.quantity) || 0), 0);
        return (
          <div onClick={() => { if (!itemsBusy) { setItemsModal(null); setItemRows(null); } }}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}>
            <div onClick={e => e.stopPropagation()}
              style={{ background: colors.bgPanel, border: `1px solid ${colors.border}`, borderRadius: 14, padding: 18, width: 'min(560px, 96vw)', maxHeight: '90vh', overflowY: 'auto' }}>
              <div style={{ color: colors.textPrimary, fontWeight: 800, fontSize: 16 }}>Editar productos</div>
              <div style={{ color: colors.textMuted, fontSize: 12, marginBottom: 14 }}>{itemsModal.name} · {itemsModal.label}</div>

              {itemRows === null ? (
                <div style={{ color: colors.textMuted, fontSize: 13, padding: '20px 0' }}>Cargando productos…</div>
              ) : rows.length === 0 ? (
                <div style={{ color: colors.textMuted, fontSize: 13, padding: '10px 0' }}>Este pedido no tiene productos con detalle. Puedes agregar uno.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {rows.map((it, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${colors.border}`, borderRadius: 10, padding: '8px 10px' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <input value={it.name} onChange={e => setItem(i, { name: e.target.value })} placeholder="Producto"
                          style={ui.input(colors, { width: '100%', padding: '5px 8px', fontSize: 13, marginBottom: 4 })} />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ color: colors.textMuted, fontSize: 11 }}>$</span>
                          <input type="number" value={it.price} onChange={e => setItem(i, { price: e.target.value })}
                            style={ui.input(colors, { width: 90, padding: '4px 6px', fontSize: 12 })} />
                          <span style={{ color: colors.textMuted, fontSize: 11, marginLeft: 6 }}>c/u</span>
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <button onClick={() => setItem(i, { quantity: Math.max(0, (Number(it.quantity) || 0) - 1) })}
                          style={{ ...ui.btn(colors, 'secondary'), padding: '2px 9px', fontSize: 15 }}>−</button>
                        <input type="number" value={it.quantity} onChange={e => setItem(i, { quantity: e.target.value })}
                          style={ui.input(colors, { width: 48, padding: '4px 6px', fontSize: 13, textAlign: 'center' })} />
                        <button onClick={() => setItem(i, { quantity: (Number(it.quantity) || 0) + 1 })}
                          style={{ ...ui.btn(colors, 'secondary'), padding: '2px 9px', fontSize: 15 }}>+</button>
                      </div>
                      <div style={{ width: 74, textAlign: 'right', color: colors.textPrimary, fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
                        {CLP((Number(it.price) || 0) * (Number(it.quantity) || 0))}
                      </div>
                      <button onClick={() => removeItem(i)} title="Quitar"
                        style={{ background: 'none', border: 'none', color: colors.dangerSoft, cursor: 'pointer', fontSize: 15, fontWeight: 800 }}>✕</button>
                    </div>
                  ))}
                </div>
              )}

              {itemRows !== null && (
                <button onClick={addItem}
                  style={{ ...ui.btn(colors, 'ghost'), color: colors.blue, padding: '6px 0', marginTop: 8 }}>+ Agregar producto</button>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14, paddingTop: 12, borderTop: `1px solid ${colors.border}` }}>
                <span style={{ color: colors.textSecondary, fontSize: 13, fontWeight: 700 }}>Total</span>
                <span style={{ color: colors.textPrimary, fontSize: 18, fontWeight: 800 }}>{CLP(itTotal)}</span>
              </div>

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
                <button onClick={() => { setItemsModal(null); setItemRows(null); }} disabled={itemsBusy}
                  style={{ ...ui.btn(colors, 'secondary'), padding: '9px 14px' }}>Cancelar</button>
                <button onClick={saveItems} disabled={itemsBusy || itemRows === null}
                  style={{ background: colors.green, color: '#fff', border: 'none', borderRadius: 8, padding: '9px 16px', cursor: 'pointer', fontWeight: 800, opacity: itemsBusy ? 0.6 : 1 }}>
                  {itemsBusy ? 'Guardando…' : 'Guardar'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function HistorialRepartos({ colors }) {
  const [routes,   setRoutes]   = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [expanded, setExpanded] = useState(null);
  const [error,    setError]    = useState(null);
  // ── Agregar pedido a una ruta existente ──
  const [addFor,   setAddFor]   = useState(null);   // id de ruta en modo "agregar"
  const [addPool,  setAddPool]  = useState([]);     // pedidos pendientes para elegir
  const [addSel,   setAddSel]   = useState(new Set());
  const [addBusy,  setAddBusy]  = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api.get('/delivery/routes')
      .then(r => setRoutes(r.data.routes || []))
      .catch(e => setError(e.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, []);

  async function openAdd(route) {
    setAddFor(route.id); setAddSel(new Set()); setAddPool([]);
    try {
      const r = await api.get('/delivery/orders');
      const inRoute = new Set((Array.isArray(route.orders) ? route.orders : []).map(o => `${o.source}_${o.id}`));
      setAddPool((r.data.orders || []).filter(o => !inRoute.has(`${o.source}_${o.id}`)));
    } catch (e) { alert(e.response?.data?.error || e.message); setAddFor(null); }
  }
  async function confirmAdd(routeId) {
    const chosen = addPool.filter(o => addSel.has(`${o.source}_${o.id}`));
    if (!chosen.length) { setAddFor(null); return; }
    setAddBusy(true);
    try {
      const { data } = await api.post(`/delivery/routes/${routeId}/orders`, { orders: chosen });
      setAddFor(null); setAddSel(new Set());
      await new Promise(r => setTimeout(r, 150));
      load();
      if (data?.added) alert(`✅ ${data.added} pedido${data.added > 1 ? 's' : ''} agregado${data.added > 1 ? 's' : ''} a la ruta.`);
    } catch (e) { alert(e.response?.data?.error || e.message); }
    finally { setAddBusy(false); }
  }

  async function handleCancel(id) {
    if (!window.confirm('¿Cancelar esta ruta?')) return;
    try {
      await api.patch(`/delivery/routes/${id}`, { status: 'cancelled' });
      load();
    } catch (e) {
      alert(e.response?.data?.error || e.message);
    }
  }

  async function handleRelease(id) {
    if (!window.confirm('¿Devolver los pedidos de esta ruta a "por despachar"?')) return;
    try {
      const { data } = await api.post(`/delivery/routes/${id}/release`);
      alert(`${data.restored || 0} pedido(s) devueltos a por despachar.`);
      load();
    } catch (e) {
      alert(e.response?.data?.error || e.message);
    }
  }

  async function handleDelete(id) {
    if (!window.confirm('¿Eliminar esta ruta?')) return;
    try {
      await api.delete(`/delivery/routes/${id}`);
      load();
    } catch (e) {
      alert(e.response?.data?.error || e.message);
    }
  }

  const s = panelStyles(colors);

  if (loading) return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.textMuted, fontSize: '14px' }}>Cargando historial...</div>;
  if (error)   return <div style={{ padding: '24px', color: colors.red, fontSize: '14px' }}>{error} <button onClick={load} style={{ marginLeft: '8px', color: colors.blue, background: 'none', border: 'none', cursor: 'pointer' }}>Reintentar</button></div>;
  if (routes.length === 0) return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', color: colors.textMuted }}>
      <Truck size={48} opacity={0.3} />
      <p style={{ margin: 0 }}>Todavía no hay rutas creadas</p>
    </div>
  );

  return (
    <div style={{ overflowY: 'auto', height: '100%', padding: '16px' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '12px' }}>
        <button onClick={load} style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'none', border: `1px solid ${colors.border}`, borderRadius: '8px', padding: '6px 12px', color: colors.textSecondary, cursor: 'pointer', fontSize: '12px' }}>
          <RotateCcw size={12} /> Actualizar
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {routes.map(route => {
          const meta    = STATUS_META[route.status] || { label: route.status, color: '#fff' };
          const isExp   = expanded === route.id;
          const total   = parseInt(route.order_count) || 0;
          const statuses = typeof route.stop_statuses === 'object' ? route.stop_statuses : {};
          const done    = Object.values(statuses).filter(v => v === 'entregado').length;
          const failed  = Object.values(statuses).filter(v => v === 'cancelled').length;

          return (
            <div key={route.id} style={{ backgroundColor: colors.bgCard, borderRadius: '12px', border: `1px solid ${colors.border}`, overflow: 'hidden' }}>
              {/* Header de la ruta */}
              <div
                onClick={() => setExpanded(isExp ? null : route.id)}
                style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 16px', cursor: 'pointer' }}>
                <div style={{ flexShrink: 0, color: colors.textMuted }}>
                  {isExp ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                    <span style={{ color: colors.textPrimary, fontWeight: 700, fontSize: '14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {route.name}
                    </span>
                    <span style={{ backgroundColor: `${meta.color}22`, color: meta.color, border: `1px solid ${meta.color}55`, borderRadius: '6px', padding: '2px 8px', fontSize: '11px', fontWeight: 700, flexShrink: 0 }}>
                      {meta.label}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '12px', color: colors.textMuted, fontSize: '12px' }}>
                    <span>{total} paradas</span>
                    {done > 0    && <span style={{ color: '#22c55e' }}>✓ {done}</span>}
                    {failed > 0  && <span style={{ color: '#f87171' }}>✕ {failed}</span>}
                    {route.driver_name && <span>👤 {route.driver_name}</span>}
                    {route.total_distance && <span>{route.total_distance}</span>}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                  {route.status === 'draft' && (
                    <button onClick={e => { e.stopPropagation(); handleDelete(route.id); }}
                      title="Eliminar borrador"
                      style={{ background: 'none', border: `1px solid ${colors.border}`, borderRadius: '6px', padding: '4px 8px', cursor: 'pointer', color: colors.red, fontSize: '12px' }}>
                      <X size={13} />
                    </button>
                  )}
                  {(route.status === 'sent' || route.status === 'in_progress') && (
                    <button onClick={e => { e.stopPropagation(); handleCancel(route.id); }}
                      title="Cancelar ruta"
                      style={{ background: 'none', border: `1px solid ${colors.border}`, borderRadius: '6px', padding: '4px 8px', cursor: 'pointer', color: colors.red, fontSize: '12px' }}>
                      Cancelar
                    </button>
                  )}
                  {route.status === 'cancelled' && (
                    <button onClick={e => { e.stopPropagation(); handleRelease(route.id); }}
                      title="Devolver los pedidos a por despachar"
                      style={{ background: 'none', border: `1px solid ${colors.border}`, borderRadius: '6px', padding: '4px 8px', cursor: 'pointer', color: colors.textSecondary, fontSize: '12px', whiteSpace: 'nowrap' }}>
                      ↩ Devolver pedidos
                    </button>
                  )}
                </div>
              </div>

              {/* Detalle expandido */}
              {isExp && (
                <div style={{ borderTop: `1px solid ${colors.border}`, padding: '12px 16px' }}>
                  {/* Fechas */}
                  <div style={{ display: 'flex', gap: '20px', marginBottom: '12px', color: colors.textMuted, fontSize: '12px' }}>
                    {route.created_at && <span>Creada: {new Date(route.created_at).toLocaleString('es-CL')}</span>}
                    {route.sent_at    && <span>Enviada: {new Date(route.sent_at).toLocaleString('es-CL')}</span>}
                    {route.completed_at && <span>Completada: {new Date(route.completed_at).toLocaleString('es-CL')}</span>}
                  </div>
                  {/* Repartidor */}
                  {(route.driver_name || route.driver_phone) && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '12px', color: colors.textSecondary, fontSize: '13px' }}>
                      <Phone size={13} />
                      {route.driver_name} {route.driver_phone}
                    </div>
                  )}
                  {/* Paradas de la ruta (compacto). El detalle de pagos, notas,
                      ventas extra y cobranza vive en 📦 Despachos — aquí solo
                      qué lleva la ruta y su estado, para operar sobre ella. */}
                  {(() => {
                    const ordersList = Array.isArray(route.orders) ? route.orders : [];
                    if (ordersList.length === 0) return null;
                    return (
                      <>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                          <span style={{ fontSize: '11px', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Paradas ({ordersList.length})</span>
                          <span style={{ fontSize: '11px', color: colors.textMuted }}>El detalle y la cobranza están en 📦 Despachos</span>
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                          {ordersList.map((o, idx) => {
                            const key = `${o.source}_${o.id}`;
                            const st  = statuses[key] || 'pending';
                            const col = st === 'entregado' ? '#22c55e' : st === 'cancelled' ? '#f87171' : '#fb923c';
                            return (
                              <span key={key} title={st === 'entregado' ? 'Entregado' : st === 'cancelled' ? 'Fallido' : 'Pendiente'}
                                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: colors.textSecondary, backgroundColor: colors.bg, border: `1px solid ${colors.border}`, borderRadius: '999px', padding: '3px 10px', maxWidth: '220px' }}>
                                <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: col, flexShrink: 0 }} />
                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{idx + 1}. {o.customerName || key}</span>
                              </span>
                            );
                          })}
                        </div>
                      </>
                    );
                  })()}

                  {/* ── Agregar pedido a esta ruta ── */}
                  {!['completed', 'cancelled'].includes(route.status) && (
                    <div style={{ marginTop: '12px', borderTop: `1px dashed ${colors.border}`, paddingTop: '12px' }}>
                      {addFor !== route.id ? (
                        <button onClick={() => openAdd(route)}
                          style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'none', border: `1px solid ${colors.border}`, borderRadius: '8px', padding: '6px 12px', color: colors.blue, cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>
                          + Agregar pedido{route.status === 'sent' || route.status === 'in_progress' ? ' (sale en camino al instante)' : ''}
                        </button>
                      ) : (
                        <div style={{ backgroundColor: colors.bg, borderRadius: '10px', border: `1px solid ${colors.border}`, padding: '10px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                            <span style={{ color: colors.textPrimary, fontWeight: 700, fontSize: '13px' }}>Pedidos pendientes</span>
                            <button onClick={() => setAddFor(null)} style={{ background: 'none', border: 'none', color: colors.textMuted, cursor: 'pointer', fontSize: '12px' }}>✕ cerrar</button>
                          </div>
                          {addPool.length === 0 ? (
                            <div style={{ color: colors.textMuted, fontSize: '12px', padding: '8px 0' }}>No hay pedidos pendientes para agregar.</div>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '220px', overflowY: 'auto' }}>
                              {addPool.map(o => {
                                const key = `${o.source}_${o.id}`;
                                const on = addSel.has(key);
                                return (
                                  <label key={key} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', borderRadius: '6px', cursor: 'pointer', backgroundColor: on ? `${colors.blue}18` : 'transparent' }}>
                                    <input type="checkbox" checked={on} onChange={() => {
                                      setAddSel(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
                                    }} />
                                    <span style={{ flex: 1, minWidth: 0, fontSize: '12px', color: colors.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                      {o.customerName || o.orderName}
                                      <span style={{ color: colors.textMuted }}> · {o.fullAddress || 'sin dirección'}</span>
                                      {o.dispatchCount > 0 && <span style={{ color: '#fb923c', fontWeight: 700 }}> · 🔁 {o.dispatchCount + 1}º</span>}
                                    </span>
                                    <span style={{ fontSize: '12px', fontWeight: 700, color: colors.green }}>${Number(o.totalPrice || 0).toLocaleString('es-CL')}</span>
                                  </label>
                                );
                              })}
                            </div>
                          )}
                          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '10px' }}>
                            <button disabled={addBusy || addSel.size === 0} onClick={() => confirmAdd(route.id)}
                              style={{ background: addSel.size ? colors.blue : colors.border, color: '#fff', border: 'none', borderRadius: '8px', padding: '7px 14px', cursor: addSel.size ? 'pointer' : 'default', fontSize: '12px', fontWeight: 700, opacity: addBusy ? 0.6 : 1 }}>
                              {addBusy ? 'Agregando...' : `Agregar ${addSel.size || ''}`}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Gastos rendidos por los repartidores ───────────────────────────────────
function GastosRepartos({ colors }) {
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [total, setTotal]       = useState(0);
  const [photo, setPhoto]       = useState(null); // url en modal

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get('/delivery/expenses');
      setExpenses(r.data.expenses || []);
      setTotal(r.data.total || 0);
    } catch { setExpenses([]); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const token = (() => { try { return localStorage.getItem('crm_token') || ''; } catch { return ''; } })();
  const photoUrl = id => `${API_BASE}/api/delivery/expenses/${id}/photo?_token=${encodeURIComponent(token)}`;
  const clp = n => `$${Math.round(Number(n) || 0).toLocaleString('es-CL')}`;

  async function del(id) {
    try { await api.delete(`/delivery/expenses/${id}`); load(); } catch {}
  }

  if (loading) return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.textMuted, fontSize: '14px' }}>Cargando gastos...</div>;

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
        <span style={{ color: colors.textPrimary, fontWeight: 700, fontSize: '15px' }}>Gastos rendidos ({expenses.length})</span>
        <span style={{ color: colors.textPrimary, fontWeight: 800, fontSize: '16px' }}>Total: {clp(total)}</span>
      </div>

      {expenses.length === 0 ? (
        <p style={{ color: colors.textMuted, fontSize: '14px' }}>Aún no hay gastos rendidos. El repartidor los agrega desde la app (💸 Gasto en la ruta).</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {expenses.map(e => (
            <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', backgroundColor: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: '10px', padding: '12px 14px' }}>
              {e.has_photo ? (
                <img src={photoUrl(e.id)} alt="boleta" onClick={() => setPhoto(photoUrl(e.id))}
                  style={{ width: '48px', height: '48px', borderRadius: '8px', objectFit: 'cover', cursor: 'pointer', flexShrink: 0 }} />
              ) : (
                <div style={{ width: '48px', height: '48px', borderRadius: '8px', backgroundColor: colors.bgApp, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: colors.textMuted, fontSize: '18px' }}>🧾</div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: colors.textPrimary, fontWeight: 700, fontSize: '14px' }}>
                  {e.category || 'Gasto'} · {clp(e.amount)}
                </div>
                <div style={{ color: colors.textSecondary, fontSize: '12px' }}>
                  {e.driver_name || 'Repartidor'} · {new Date(e.created_at).toLocaleDateString('es-CL')} {new Date(e.created_at).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })}
                  {e.note ? ` · ${e.note}` : ''}
                </div>
              </div>
              <button onClick={() => del(e.id)} style={{ background: 'none', border: 'none', color: colors.textMuted, cursor: 'pointer', fontSize: '13px' }}>Eliminar</button>
            </div>
          ))}
        </div>
      )}

      {photo && (
        <div onClick={() => setPhoto(null)} style={{ position: 'fixed', inset: 0, zIndex: 60, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '30px' }}>
          <img src={photo} alt="boleta" style={{ maxWidth: '90%', maxHeight: '90%', borderRadius: '8px' }} />
        </div>
      )}
    </div>
  );
}

// ─── Estilos compartidos ─────────────────────────────────────────────────────

function panelStyles(colors) {
  return {
    btn: {
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      backgroundColor: colors.green, color: '#fff',
      border: 'none', borderRadius: '10px', padding: '10px 18px',
      fontWeight: 700, fontSize: '14px', cursor: 'pointer',
    },
  };
}

function inputStyle(colors) {
  return {
    flex: 1, padding: '10px 12px', borderRadius: '8px',
    border: `1px solid ${colors.border}`,
    backgroundColor: colors.bgCard,
    color: colors.textPrimary, fontSize: '14px',
    outline: 'none',
  };
}
