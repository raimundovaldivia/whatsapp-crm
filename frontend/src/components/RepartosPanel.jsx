/**
 * RepartosPanel.jsx
 * Panel admin para gestión de repartos:
 *   - Tab "Nuevo reparto": seleccionar pedidos → optimizar → asignar repartidor → enviar
 *   - Tab "Historial": ver rutas enviadas/en progreso/completadas
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../utils/api.js';
import { useTheme } from '../theme.js';
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
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', backgroundColor: colors.bgPanel }}>
      {/* Header */}
      <div style={{ padding: '20px 24px 0', borderBottom: `1px solid ${colors.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
          <Truck size={22} color={colors.green} />
          <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: colors.textPrimary }}>Repartos</h2>
        </div>
        <div style={{ display: 'flex', gap: '4px' }}>
          {[
            { key: 'nuevo',     label: '+ Nuevo reparto' },
            { key: 'historial', label: 'Historial' },
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
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {tab === 'nuevo'     && <NuevoReparto colors={colors} />}
        {tab === 'historial' && <HistorialRepartos colors={colors} />}
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
      for (const rt of optRoutes) {
        const drvId = routeDrivers[rt.vehicle] ? parseInt(routeDrivers[rt.vehicle], 10) : null;
        const drv   = drivers.find(d => String(d.id) === String(drvId));
        const name  = optRoutes.length > 1
          ? `Reparto ${new Date().toLocaleDateString('es-CL')} — Vehículo ${rt.vehicle}`
          : `Reparto ${new Date().toLocaleDateString('es-CL')}`;
        await api.post('/delivery/routes', {
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
        sentCount++;
      }
      setSentRoute({ count: sentCount });
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
    const XLSX = await import('https://cdn.sheetjs.com/xlsx-0.20.1/package/xlsx.mjs');

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
          {n > 1 ? `${n} vehículos · ` : ''}{selectedOrders.length} paradas en total
        </p>
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

function HistorialRepartos({ colors }) {
  const [routes,   setRoutes]   = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [expanded, setExpanded] = useState(null);
  const [error,    setError]    = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api.get('/delivery/routes')
      .then(r => setRoutes(r.data.routes || []))
      .catch(e => setError(e.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, []);

  async function handleCancel(id) {
    if (!window.confirm('¿Cancelar esta ruta?')) return;
    try {
      await api.patch(`/delivery/routes/${id}`, { status: 'cancelled' });
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
                  {/* Paradas con su estado y medio de pago */}
                  {(() => {
                    const ordersList = Array.isArray(route.orders) ? route.orders : [];
                    const payments   = typeof route.stop_payments === 'object' && route.stop_payments ? route.stop_payments : {};
                    const notes      = typeof route.stop_notes === 'object' && route.stop_notes ? route.stop_notes : {};
                    const extrasMap  = typeof route.stop_extras === 'object' && route.stop_extras ? route.stop_extras : {};
                    const PAY = { efectivo: '💵 Efectivo', transferencia: '🏦 Transferencia', otro: 'Otro' };
                    const clp = n => `$${Math.round(Number(n) || 0).toLocaleString('es-CL')}`;
                    if (ordersList.length === 0) return null;
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        {ordersList.map((o, idx) => {
                          const key = `${o.source}_${o.id}`;
                          const st  = statuses[key] || 'pending';
                          const col = st === 'entregado' ? '#22c55e' : st === 'cancelled' ? '#f87171' : '#fb923c';
                          const pay = payments[key];
                          const note = notes[key];
                          const stopExtras = Array.isArray(extrasMap[key]) ? extrasMap[key] : [];
                          const extrasTotal = stopExtras.reduce((s, e) => s + (Number(e.price) || 0) * (Number(e.quantity) || 0), 0);
                          return (
                            <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12px' }}>
                                <span style={{ width: '20px', height: '20px', borderRadius: '10px', backgroundColor: col, color: '#fff', fontWeight: 800, fontSize: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                  {idx + 1}
                                </span>
                                <span style={{ color: colors.textPrimary, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                                  {o.customerName || key}
                                  <span style={{ color: colors.textMuted, fontWeight: 400 }}> · {o.orderName}</span>
                                </span>
                                {pay && <span style={{ color: colors.textMuted }}>{PAY[pay] || pay}</span>}
                                <span style={{ color: col, fontWeight: 700, flexShrink: 0 }}>
                                  {st === 'entregado' ? '✓ Entregado' : st === 'cancelled' ? '✕ No encontrado' : 'Pendiente'}
                                </span>
                              </div>
                              {note && (
                                <div style={{ marginLeft: '30px', fontSize: '12px', color: colors.textSecondary, fontStyle: 'italic' }}>
                                  📝 {note}
                                </div>
                              )}
                              {stopExtras.length > 0 && (
                                <div style={{ marginLeft: '30px', fontSize: '12px', color: '#8b5cf6' }}>
                                  🛒 Venta extra: {stopExtras.map(e => `${e.quantity}× ${e.name}`).join(', ')} = {clp(extrasTotal)}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          );
        })}
      </div>
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
