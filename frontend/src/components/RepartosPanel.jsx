/**
 * RepartosPanel.jsx
 * Panel admin para gestión de repartos:
 *   - Tab "Nuevo reparto": seleccionar pedidos → optimizar → asignar repartidor → enviar
 *   - Tab "Historial": ver rutas enviadas/en progreso/completadas
 */
import { useState, useEffect, useCallback } from 'react';
import { api } from '../utils/api.js';
import { useTheme } from '../theme.js';
import { Truck, Package, RotateCcw, Send, Check, X, MapPin, ChevronDown, ChevronRight, Phone, Download } from 'lucide-react';
import * as XLSX from 'xlsx';

// ─── Helpers ────────────────────────────────────────────────────────────────

const STATUS_META = {
  draft:       { label: 'Borrador',     color: '#94a3b8' },
  sent:        { label: 'Enviada',      color: '#38bdf8' },
  in_progress: { label: 'En progreso',  color: '#fb923c' },
  completed:   { label: 'Completada',   color: '#22c55e' },
  cancelled:   { label: 'Cancelada',    color: '#f87171' },
};

function fmt(n) { return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(n); }

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
  const [sending,        setSending]        = useState(false);
  const [sentRoute,      setSentRoute]      = useState(null);
  const [error,          setError]          = useState(null);
  const [editingAddr,    setEditingAddr]    = useState(null); // key de orden en edición
  const [addrDraft,      setAddrDraft]      = useState('');

  useEffect(() => {
    setLoadingOrders(true);
    api.get('/delivery/orders')
      .then(r => {
        setOrders(r.data.orders || []);
        setSelected(new Set((r.data.orders || []).map(o => `${o.source}_${o.id}`)));
      })
      .catch(e => setError(e.response?.data?.error || e.message))
      .finally(() => setLoadingOrders(false));
  }, []);

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
      const r = await api.post('/delivery/optimize', { orders: selectedOrders });
      setOptimizedRoute(r.data);
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
      const r = await api.post('/delivery/routes', {
        orders:         selectedOrders,
        optimizedRoute: optimizedRoute?.route,
        totalDistance:  optimizedRoute?.totalDistance,
        totalDuration:  optimizedRoute?.totalDuration,
        mapsUrl:        optimizedRoute?.mapsUrl,
        driverName:     driverName.trim() || null,
        driverPhone:    driverPhone.trim() || null,
        send:           true,
      });
      setSentRoute(r.data.route);
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

  function handleExportXlsx() {
    if (selectedOrders.length === 0) return;

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
      // Col N: Teléfono como fórmula =+56...
      const phone = (o.phone || '').replace(/\D/g, '');
      if (phone) row[13] = { t: 'n', f: `+${phone}` };
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
    setDriverName('');
    setDriverPhone('');
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
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '16px' }}>
        <div style={{ fontSize: '56px' }}>✅</div>
        <h3 style={{ color: colors.textPrimary, margin: 0, fontSize: '20px', fontWeight: 800 }}>Ruta enviada</h3>
        <p style={{ color: colors.textSecondary, margin: 0, textAlign: 'center' }}>
          {sentRoute.name} — {selectedOrders.length} paradas
          {driverName ? ` · ${driverName}` : ''}
        </p>
        {optimizedRoute?.totalDistance && (
          <p style={{ color: colors.textMuted, margin: 0, fontSize: '13px' }}>
            {optimizedRoute.totalDistance} · {optimizedRoute.totalDuration}
          </p>
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
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Botones acción */}
        <div style={{ padding: '14px 16px', borderTop: `1px solid ${colors.border}`, display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <button
            onClick={handleOptimize}
            disabled={selectedOrders.length === 0 || optimizing}
            style={{
              ...s.btn,
              width: '100%',
              opacity: selectedOrders.length === 0 ? 0.4 : 1,
              gap: '8px',
            }}>
            {optimizing ? 'Optimizando...' : `Optimizar ruta (${selectedOrders.length})`}
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
        {step === 'select' && !optimizing && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', color: colors.textMuted }}>
            <Truck size={48} opacity={0.3} />
            <p style={{ margin: 0, fontSize: '15px' }}>Selecciona pedidos y presiona Optimizar</p>
          </div>
        )}

        {optimizing && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
            <div style={{ fontSize: '36px', animation: 'spin 1s linear infinite' }}>🗺</div>
            <p style={{ color: colors.textSecondary, margin: 0 }}>Calculando ruta optimizada...</p>
          </div>
        )}

        {step === 'assign' && optimizedRoute && (
          <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
            {/* Stats de la ruta optimizada */}
            <div style={{ display: 'flex', gap: '12px', marginBottom: '20px' }}>
              {[
                { label: 'Paradas',   value: optimizedRoute.route?.length ?? 0 },
                { label: 'Distancia', value: optimizedRoute.totalDistance || '—' },
                { label: 'Duración',  value: optimizedRoute.totalDuration  || '—' },
              ].map(({ label, value }) => (
                <div key={label} style={{ flex: 1, backgroundColor: colors.bgCard, borderRadius: '10px', padding: '14px', textAlign: 'center', border: `1px solid ${colors.border}` }}>
                  <div style={{ color: colors.textPrimary, fontWeight: 800, fontSize: '18px' }}>{value}</div>
                  <div style={{ color: colors.textMuted, fontSize: '12px', marginTop: '4px' }}>{label}</div>
                </div>
              ))}
            </div>

            {/* Orden de paradas */}
            <h4 style={{ color: colors.textPrimary, margin: '0 0 10px', fontSize: '14px', fontWeight: 700 }}>
              Orden optimizado
            </h4>
            <div style={{ backgroundColor: colors.bgCard, borderRadius: '12px', border: `1px solid ${colors.border}`, marginBottom: '20px', overflow: 'hidden' }}>
              {(optimizedRoute.route || []).map((stop, idx) => (
                <div key={`${stop.source}_${stop.id}`} style={{
                  display: 'flex', alignItems: 'center', gap: '12px',
                  padding: '10px 14px', borderBottom: idx < optimizedRoute.route.length - 1 ? `1px solid ${colors.border}` : 'none',
                }}>
                  <div style={{ width: '26px', height: '26px', borderRadius: '13px', backgroundColor: colors.green, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <span style={{ color: '#fff', fontSize: '12px', fontWeight: 800 }}>{stop.stopNumber}</span>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: colors.textPrimary, fontWeight: 600, fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{stop.customerName}</div>
                    <div style={{ color: colors.textMuted, fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{stop.fullAddress}</div>
                  </div>
                  {stop.durationText && (
                    <span style={{ color: colors.textMuted, fontSize: '11px', flexShrink: 0 }}>{stop.durationText}</span>
                  )}
                </div>
              ))}
            </div>

            {/* Datos del repartidor */}
            <h4 style={{ color: colors.textPrimary, margin: '0 0 10px', fontSize: '14px', fontWeight: 700 }}>
              Repartidor (opcional)
            </h4>
            <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
              <input
                value={driverName}
                onChange={e => setDriverName(e.target.value)}
                placeholder="Nombre del repartidor"
                style={inputStyle(colors)}
              />
              <input
                value={driverPhone}
                onChange={e => setDriverPhone(e.target.value)}
                placeholder="Teléfono"
                type="tel"
                style={{ ...inputStyle(colors), maxWidth: '160px' }}
              />
            </div>

            {error && (
              <div style={{ padding: '10px 14px', backgroundColor: `${colors.red}18`, borderRadius: '8px', color: colors.red, fontSize: '13px', marginBottom: '16px' }}>
                {error}
              </div>
            )}

            {/* Botón enviar */}
            <button onClick={handleSend} disabled={sending} style={{ ...s.btn, width: '100%', gap: '8px', fontSize: '15px', padding: '14px' }}>
              <Send size={16} />
              {sending ? 'Enviando al repartidor...' : 'Enviar al repartidor'}
            </button>

            {optimizedRoute?.mapsUrl && (
              <a href={optimizedRoute.mapsUrl} target="_blank" rel="noreferrer"
                style={{ display: 'block', textAlign: 'center', marginTop: '10px', color: colors.blue, fontSize: '13px', textDecoration: 'none' }}>
                Ver ruta en Google Maps →
              </a>
            )}
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
                  {/* Stop statuses */}
                  {Object.keys(statuses).length > 0 && (
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      {Object.entries(statuses).map(([key, val]) => (
                        <span key={key} style={{
                          fontSize: '11px', fontWeight: 600, padding: '2px 8px', borderRadius: '6px',
                          backgroundColor: val === 'entregado' ? '#22c55e22' : val === 'cancelled' ? '#f8717122' : '#fb923c22',
                          color: val === 'entregado' ? '#22c55e' : val === 'cancelled' ? '#f87171' : '#fb923c',
                          border: `1px solid ${val === 'entregado' ? '#22c55e44' : val === 'cancelled' ? '#f8717144' : '#fb923c44'}`,
                        }}>
                          {key}: {val}
                        </span>
                      ))}
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
