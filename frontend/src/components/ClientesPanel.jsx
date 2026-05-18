import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Users, Search, RefreshCw, MessageSquare, ShoppingBag,
  TrendingUp, WifiOff, MapPin, ChevronRight, ChevronLeft,
} from 'lucide-react';
import { api } from '../utils/api.js';

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  const now = new Date();
  const diff = Math.floor((now - d) / 86400000);
  if (diff === 0) return 'Hoy';
  if (diff === 1) return 'Ayer';
  if (diff < 7)   return `Hace ${diff} días`;
  if (diff < 30)  return `Hace ${Math.floor(diff / 7)} sem.`;
  if (diff < 365) return `Hace ${Math.floor(diff / 30)} meses`;
  return `Hace ${Math.floor(diff / 365)} años`;
}

const PAGE_SIZE = 50;

export default function ClientesPanel({ onOpenConversation }) {
  const [allCustomers, setAllCustomers] = useState([]);   // todos los cargados desde Shopify
  const [loading, setLoading]           = useState(true);
  const [loadingProgress, setLoadingProgress] = useState({ loaded: 0, total: null });
  const [error, setError]               = useState(null);
  const [search, setSearch]             = useState('');
  const [page, setPage]                 = useState(1);
  const [expanded, setExpanded]         = useState(null);
  const abortRef = useRef(false);

  // Una sola llamada al backend — el backend hace el loop internamente (servidor a servidor)
  const loadAll = useCallback(async () => {
    abortRef.current = false;
    setLoading(true);
    setError(null);
    setAllCustomers([]);
    setPage(1);
    setExpanded(null);
    setLoadingProgress({ loaded: 0, total: null });

    try {
      const res  = await api.get('/clientes/all', { timeout: 120000 }); // 2 min para tiendas grandes
      const data = res.data;
      if (!data.success) throw new Error(data.error);
      setAllCustomers(data.customers || []);
      setLoadingProgress({ loaded: data.total, total: data.total });
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); return () => { abortRef.current = true; }; }, []);

  // Filtrado local por búsqueda
  const filtered = search.trim()
    ? allCustomers.filter(c => {
        const q = search.toLowerCase();
        return (
          c.name?.toLowerCase().includes(q) ||
          c.email?.toLowerCase().includes(q) ||
          c.phone?.includes(q) ||
          c.city?.toLowerCase().includes(q)
        );
      })
    : allCustomers;

  // Paginación local
  const totalPages  = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageItems   = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  // Reset página al buscar
  useEffect(() => { setPage(1); }, [search]);

  // Stats (sobre todos los cargados)
  const totalOrders = allCustomers.reduce((s, c) => s + (parseInt(c.totalOrders) || 0), 0);
  const totalSpent  = allCustomers.reduce((s, c) => s + (parseFloat(c.totalSpent)  || 0), 0);
  const withOrders  = allCustomers.filter(c => (parseInt(c.totalOrders) || 0) > 0).length;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100vh', backgroundColor: '#0b141a', overflow: 'hidden' }}>

      {/* Header */}
      <div style={{ padding: '14px 24px', backgroundColor: '#202c33', borderBottom: '1px solid #2a3942', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Users size={20} color="#00a884" />
          <h1 style={{ color: '#e9edef', fontSize: '17px', fontWeight: 600 }}>Clientes</h1>
          <span style={{ backgroundColor: '#0d2e25', color: '#00a884', borderRadius: '6px', padding: '2px 8px', fontSize: '11px', fontWeight: 600, border: '1px solid #00a88433' }}>
            Shopify
          </span>
          {allCustomers.length > 0 && (
            <span style={{ backgroundColor: '#2a3942', color: '#8696a0', borderRadius: '12px', padding: '2px 8px', fontSize: '12px' }}>
              {loading ? `${loadingProgress.loaded} cargando...` : `${allCustomers.length} total`}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <div style={{ backgroundColor: '#2a3942', borderRadius: '8px', display: 'flex', alignItems: 'center', padding: '7px 12px', gap: '7px' }}>
            <Search size={14} color="#8696a0" />
            <input
              type="text"
              placeholder="Buscar por nombre, email o teléfono..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ background: 'none', border: 'none', color: '#e9edef', fontSize: '13px', outline: 'none', width: '220px' }}
            />
          </div>
          <button onClick={loadAll} title="Recargar todo"
            style={{ padding: '8px', borderRadius: '8px', backgroundColor: '#2a3942', border: 'none', cursor: 'pointer', display: 'flex' }}>
            <RefreshCw size={14} color="#8696a0" />
          </button>
        </div>
      </div>

      {/* Stats */}
      {allCustomers.length > 0 && (
        <div style={{ display: 'flex', backgroundColor: '#111b21', borderBottom: '1px solid #2a3942' }}>
          {[
            { label: 'Clientes totales', value: allCustomers.length,                                          icon: <Users size={14} /> },
            { label: 'Con pedidos',       value: withOrders,                                                  icon: <ShoppingBag size={14} /> },
            { label: 'Pedidos totales',   value: totalOrders.toLocaleString('es-CL'),                         icon: <ShoppingBag size={14} /> },
            { label: 'Ingresos totales',  value: `$${Math.round(totalSpent).toLocaleString('es-CL')}`,        icon: <TrendingUp size={14} /> },
          ].map(({ label, value, icon }) => (
            <div key={label} style={{ flex: 1, padding: '10px 20px', borderRight: '1px solid #2a3942', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ color: '#8696a0' }}>{icon}</span>
              <div>
                <div style={{ color: '#e9edef', fontWeight: 700, fontSize: '15px' }}>{value}</div>
                <div style={{ color: '#8696a0', fontSize: '11px' }}>{label}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Tabla */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && allCustomers.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '80px', color: '#8696a0' }}>
            <div style={{ width: '36px', height: '36px', border: '3px solid #2a3942', borderTop: '3px solid #00a884', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 16px' }} />
            <div style={{ fontSize: '14px', marginBottom: '6px' }}>Cargando clientes de Shopify...</div>
            <div style={{ fontSize: '12px', opacity: 0.6 }}>Puede tardar ~30s si Render está en cold start</div>
          </div>
        ) : error ? (
          <div style={{ textAlign: 'center', padding: '60px', color: '#e57373' }}>
            <WifiOff size={40} style={{ marginBottom: '12px', opacity: 0.7 }} />
            <div style={{ fontSize: '14px', marginBottom: '16px', maxWidth: '400px', margin: '0 auto 16px', lineHeight: 1.5 }}>{error}</div>
            <button onClick={loadAll} style={{ backgroundColor: '#00a88422', color: '#00a884', border: '1px solid #00a88433', borderRadius: '8px', padding: '8px 16px', fontSize: '13px', cursor: 'pointer' }}>
              Reintentar
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '80px', color: '#8696a0' }}>
            <Users size={48} style={{ marginBottom: '16px', opacity: 0.2 }} />
            <div style={{ fontSize: '15px' }}>
              {search ? `Sin resultados para "${search}"` : 'No se encontraron clientes'}
            </div>
          </div>
        ) : (
          <>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ backgroundColor: '#111b21', position: 'sticky', top: 0, zIndex: 1 }}>
                  {['Cliente', 'Contacto', 'Pedidos', 'Total gastado', 'Último pedido', 'Ubicación', ''].map(h => (
                    <th key={h} style={{ padding: '10px 16px', textAlign: 'left', color: '#8696a0', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', borderBottom: '1px solid #2a3942', whiteSpace: 'nowrap' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageItems.map(c => (
                  <>
                    <tr
                      key={c.shopifyId}
                      onClick={() => setExpanded(expanded === c.shopifyId ? null : c.shopifyId)}
                      style={{ borderBottom: '1px solid #1a2530', cursor: 'pointer', backgroundColor: expanded === c.shopifyId ? '#1a2e28' : 'transparent', transition: 'background-color 0.1s' }}
                      onMouseEnter={e => { if (expanded !== c.shopifyId) e.currentTarget.style.backgroundColor = '#151e25'; }}
                      onMouseLeave={e => { if (expanded !== c.shopifyId) e.currentTarget.style.backgroundColor = 'transparent'; }}
                    >
                      {/* Nombre */}
                      <td style={{ padding: '12px 16px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <div style={{ width: '36px', height: '36px', borderRadius: '50%', backgroundColor: '#2a3942', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', fontWeight: 700, color: '#00a884', flexShrink: 0 }}>
                            {(c.firstName?.[0] || c.name?.[0] || '?').toUpperCase()}
                          </div>
                          <div>
                            <div style={{ color: '#e9edef', fontSize: '13px', fontWeight: 500 }}>{c.name}</div>
                            {c.tags?.length > 0 && (
                              <div style={{ display: 'flex', gap: '3px', marginTop: '3px' }}>
                                {c.tags.slice(0, 2).map(t => (
                                  <span key={t} style={{ backgroundColor: '#2a3942', color: '#8696a0', borderRadius: '4px', padding: '1px 5px', fontSize: '10px' }}>{t}</span>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* Contacto */}
                      <td style={{ padding: '12px 16px' }}>
                        <div style={{ fontSize: '12px', color: '#8696a0' }}>
                          {c.email && <div style={{ marginBottom: '2px' }}>{c.email}</div>}
                          {c.phone && <div>{c.phone}</div>}
                          {!c.email && !c.phone && <span style={{ color: '#374045' }}>—</span>}
                        </div>
                      </td>

                      {/* Pedidos */}
                      <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                        {(parseInt(c.totalOrders) || 0) > 0
                          ? <span style={{ display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'center', color: '#e9edef', fontSize: '13px' }}>
                              <ShoppingBag size={12} color="#00a884" /> {parseInt(c.totalOrders)}
                            </span>
                          : <span style={{ color: '#8696a0', fontSize: '13px' }}>—</span>}
                      </td>

                      {/* Total gastado */}
                      <td style={{ padding: '12px 16px' }}>
                        {(parseFloat(c.totalSpent) || 0) > 0
                          ? <span style={{ color: '#00a884', fontSize: '13px', fontWeight: 600 }}>
                              ${Math.round(parseFloat(c.totalSpent)).toLocaleString('es-CL')} {c.currency}
                            </span>
                          : <span style={{ color: '#8696a0', fontSize: '13px' }}>—</span>}
                      </td>

                      {/* Último pedido */}
                      <td style={{ padding: '12px 16px' }}>
                        {c.lastOrder ? (
                          <div>
                            <div style={{ color: '#e9edef', fontSize: '12px' }}>{c.lastOrder.name}</div>
                            <div style={{ color: '#8696a0', fontSize: '11px' }}>{formatDate(c.lastOrder.createdAt)}</div>
                          </div>
                        ) : <span style={{ color: '#374045', fontSize: '12px' }}>—</span>}
                      </td>

                      {/* Ubicación */}
                      <td style={{ padding: '12px 16px', color: '#8696a0', fontSize: '12px' }}>
                        {c.city
                          ? <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}><MapPin size={11} /> {c.city}</span>
                          : '—'}
                      </td>

                      {/* Acciones */}
                      <td style={{ padding: '12px 16px' }}>
                        <div style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
                          {c.phone && onOpenConversation && (
                            <button
                              onClick={e => { e.stopPropagation(); onOpenConversation(c.phone); }}
                              title="Abrir chat"
                              style={{ display: 'flex', alignItems: 'center', gap: '4px', backgroundColor: '#2a3942', color: '#8696a0', padding: '5px 9px', borderRadius: '7px', fontSize: '11px', border: 'none', cursor: 'pointer' }}>
                              <MessageSquare size={11} /> Chat
                            </button>
                          )}
                          <ChevronRight size={14} color="#374045"
                            style={{ transform: expanded === c.shopifyId ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }} />
                        </div>
                      </td>
                    </tr>

                    {/* Detalle expandible */}
                    {expanded === c.shopifyId && (
                      <tr key={`${c.shopifyId}-detail`} style={{ backgroundColor: '#0e1a20' }}>
                        <td colSpan={7} style={{ padding: '12px 16px 16px 62px', borderBottom: '2px solid #00a88433' }}>
                          <div style={{ display: 'flex', gap: '32px', flexWrap: 'wrap' }}>
                            {c.lastOrder && (
                              <div>
                                <div style={{ color: '#8696a0', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>Último pedido</div>
                                <div style={{ backgroundColor: '#202c33', borderRadius: '8px', padding: '10px 14px', border: '1px solid #2a3942', minWidth: '200px' }}>
                                  <div style={{ color: '#e9edef', fontSize: '13px', fontWeight: 600, marginBottom: '4px' }}>{c.lastOrder.name}</div>
                                  {c.lastOrder.items?.length > 0 && (
                                    <div style={{ color: '#8696a0', fontSize: '12px', marginBottom: '4px' }}>{c.lastOrder.items.join(', ')}</div>
                                  )}
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <span style={{ color: '#00a884', fontSize: '13px', fontWeight: 600 }}>
                                      ${Math.round(c.lastOrder.totalPrice).toLocaleString('es-CL')}
                                    </span>
                                    <span style={{ color: '#8696a0', fontSize: '11px' }}>{c.lastOrder.createdAt?.slice(0, 10)}</span>
                                  </div>
                                </div>
                              </div>
                            )}
                            <div>
                              <div style={{ color: '#8696a0', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>Info</div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', fontSize: '12px', color: '#8696a0' }}>
                                <div><span style={{ color: '#e9edef' }}>Cliente desde:</span> {formatDate(c.createdAt)}</div>
                                {c.city    && <div><span style={{ color: '#e9edef' }}>Ciudad:</span> {c.city}</div>}
                                {c.country && <div><span style={{ color: '#e9edef' }}>País:</span> {c.country}</div>}
                                {c.note    && <div><span style={{ color: '#e9edef' }}>Nota:</span> {c.note}</div>}
                                {c.tags?.length > 0 && (
                                  <div style={{ display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' }}>
                                    <span style={{ color: '#e9edef' }}>Tags:</span>
                                    {c.tags.map(t => (
                                      <span key={t} style={{ backgroundColor: '#2a3942', color: '#8696a0', borderRadius: '4px', padding: '1px 6px', fontSize: '11px' }}>{t}</span>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>

            {/* Paginación local */}
            {totalPages > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', padding: '16px', borderTop: '1px solid #2a3942' }}>
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={currentPage <= 1}
                  style={{ display: 'flex', alignItems: 'center', gap: '4px', backgroundColor: currentPage <= 1 ? '#1a2530' : '#2a3942', color: currentPage <= 1 ? '#374045' : '#8696a0', border: 'none', borderRadius: '7px', padding: '7px 12px', fontSize: '12px', cursor: currentPage <= 1 ? 'default' : 'pointer' }}>
                  <ChevronLeft size={14} /> Anterior
                </button>

                <span style={{ color: '#8696a0', fontSize: '13px' }}>
                  Página <strong style={{ color: '#e9edef' }}>{currentPage}</strong> de <strong style={{ color: '#e9edef' }}>{totalPages}</strong>
                  <span style={{ marginLeft: '8px', color: '#374045', fontSize: '11px' }}>
                    ({filtered.length} clientes{search ? ' encontrados' : ''})
                  </span>
                </span>

                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage >= totalPages}
                  style={{ display: 'flex', alignItems: 'center', gap: '4px', backgroundColor: currentPage >= totalPages ? '#1a2530' : '#2a3942', color: currentPage >= totalPages ? '#374045' : '#8696a0', border: 'none', borderRadius: '7px', padding: '7px 12px', fontSize: '12px', cursor: currentPage >= totalPages ? 'default' : 'pointer' }}>
                  Siguiente <ChevronRight size={14} />
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
