import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Users, Search, RefreshCw, MessageSquare, ShoppingBag,
  TrendingUp, WifiOff, MapPin, ChevronRight, ChevronLeft, UserCheck,
} from 'lucide-react';
import { api } from '../utils/api.js';
import { useTheme } from '../theme.js';

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

export default function ClientesPanel({ onOpenConversation, onOpenReengagement }) {
  const { colors, isDark } = useTheme();
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
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100vh', backgroundColor: colors.bgApp, overflow: 'hidden' }}>

      {/* Header */}
      <div style={{ padding: '14px 24px', backgroundColor: colors.bgPanel, borderBottom: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Users size={20} color={colors.green} />
          <h1 style={{ color: colors.textPrimary, fontSize: '17px', fontWeight: 600 }}>Clientes</h1>
          <span style={{ backgroundColor: colors.bgAccent, color: colors.green, borderRadius: '6px', padding: '2px 8px', fontSize: '11px', fontWeight: 600, border: `1px solid ${colors.green}33` }}>
            Shopify
          </span>
          {allCustomers.length > 0 && (
            <span style={{ backgroundColor: colors.bgHover, color: colors.textSecondary, borderRadius: '12px', padding: '2px 8px', fontSize: '12px' }}>
              {loading ? `${loadingProgress.loaded} cargando...` : `${allCustomers.length} total`}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <div style={{ backgroundColor: colors.bgHover, borderRadius: '8px', display: 'flex', alignItems: 'center', padding: '7px 12px', gap: '7px' }}>
            <Search size={14} color={colors.textSecondary} />
            <input
              type="text"
              placeholder="Buscar por nombre, email o teléfono..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ background: 'none', border: 'none', color: colors.textPrimary, fontSize: '13px', outline: 'none', width: '220px' }}
            />
          </div>
          <button onClick={loadAll} title="Recargar todo"
            style={{ padding: '8px', borderRadius: '8px', backgroundColor: colors.bgHover, border: 'none', cursor: 'pointer', display: 'flex' }}>
            <RefreshCw size={14} color={colors.textSecondary} />
          </button>
        </div>
      </div>

      {/* Stats */}
      {allCustomers.length > 0 && (
        <div style={{ display: 'flex', backgroundColor: colors.bgApp, borderBottom: `1px solid ${colors.border}` }}>
          {[
            { label: 'Clientes totales', value: allCustomers.length,                                          icon: <Users size={14} /> },
            { label: 'Con pedidos',       value: withOrders,                                                  icon: <ShoppingBag size={14} /> },
            { label: 'Pedidos totales',   value: totalOrders.toLocaleString('es-CL'),                         icon: <ShoppingBag size={14} /> },
            { label: 'Ingresos totales',  value: `$${Math.round(totalSpent).toLocaleString('es-CL')}`,        icon: <TrendingUp size={14} /> },
          ].map(({ label, value, icon }) => (
            <div key={label} style={{ flex: 1, padding: '10px 20px', borderRight: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ color: colors.textSecondary }}>{icon}</span>
              <div>
                <div style={{ color: colors.textPrimary, fontWeight: 700, fontSize: '15px' }}>{value}</div>
                <div style={{ color: colors.textSecondary, fontSize: '11px' }}>{label}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Tabla */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && allCustomers.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '80px', color: colors.textSecondary }}>
            <div style={{ width: '36px', height: '36px', border: `3px solid ${colors.border}`, borderTop: `3px solid ${colors.green}`, borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 16px' }} />
            <div style={{ fontSize: '14px', marginBottom: '6px' }}>Cargando clientes de Shopify...</div>
            <div style={{ fontSize: '12px', opacity: 0.6 }}>Puede tardar ~30s si Render está en cold start</div>
          </div>
        ) : error ? (
          <div style={{ textAlign: 'center', padding: '60px', color: colors.red }}>
            <WifiOff size={40} style={{ marginBottom: '12px', opacity: 0.7 }} />
            <div style={{ fontSize: '14px', marginBottom: '16px', maxWidth: '400px', margin: '0 auto 16px', lineHeight: 1.5 }}>{error}</div>
            <button onClick={loadAll} style={{ backgroundColor: `${colors.green}22`, color: colors.green, border: `1px solid ${colors.green}33`, borderRadius: '8px', padding: '8px 16px', fontSize: '13px', cursor: 'pointer' }}>
              Reintentar
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '80px', color: colors.textSecondary }}>
            <Users size={48} style={{ marginBottom: '16px', opacity: 0.2 }} />
            <div style={{ fontSize: '15px' }}>
              {search ? `Sin resultados para "${search}"` : 'No se encontraron clientes'}
            </div>
          </div>
        ) : (
          <>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ backgroundColor: colors.bgApp, position: 'sticky', top: 0, zIndex: 1 }}>
                  {['Cliente', 'Contacto', 'Pedidos', 'Total gastado', 'Último pedido', 'Ubicación', ''].map(h => (
                    <th key={h} style={{ padding: '10px 16px', textAlign: 'left', color: colors.textSecondary, fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', borderBottom: `1px solid ${colors.border}`, whiteSpace: 'nowrap' }}>
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
                      style={{ borderBottom: `1px solid ${colors.bgSub}`, cursor: 'pointer', backgroundColor: expanded === c.shopifyId ? colors.bgAccent : 'transparent', transition: 'background-color 0.1s' }}
                      onMouseEnter={e => { if (expanded !== c.shopifyId) e.currentTarget.style.backgroundColor = colors.bgSub; }}
                      onMouseLeave={e => { if (expanded !== c.shopifyId) e.currentTarget.style.backgroundColor = 'transparent'; }}
                    >
                      {/* Nombre */}
                      <td style={{ padding: '12px 16px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <div style={{ width: '36px', height: '36px', borderRadius: '50%', backgroundColor: colors.bgHover, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', fontWeight: 700, color: colors.green, flexShrink: 0 }}>
                            {(c.firstName?.[0] || c.name?.[0] || '?').toUpperCase()}
                          </div>
                          <div>
                            <div style={{ color: colors.textPrimary, fontSize: '13px', fontWeight: 500 }}>{c.name}</div>
                            {c.tags?.length > 0 && (
                              <div style={{ display: 'flex', gap: '3px', marginTop: '3px' }}>
                                {c.tags.slice(0, 2).map(t => (
                                  <span key={t} style={{ backgroundColor: colors.bgHover, color: colors.textSecondary, borderRadius: '4px', padding: '1px 5px', fontSize: '10px' }}>{t}</span>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* Contacto */}
                      <td style={{ padding: '12px 16px' }}>
                        <div style={{ fontSize: '12px', color: colors.textSecondary }}>
                          {c.email && <div style={{ marginBottom: '2px' }}>{c.email}</div>}
                          {c.phone && <div>{c.phone}</div>}
                          {!c.email && !c.phone && <span style={{ color: colors.borderStrong }}>—</span>}
                        </div>
                      </td>

                      {/* Pedidos */}
                      <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                        {(parseInt(c.totalOrders) || 0) > 0
                          ? <span style={{ display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'center', color: colors.textPrimary, fontSize: '13px' }}>
                              <ShoppingBag size={12} color={colors.green} /> {parseInt(c.totalOrders)}
                            </span>
                          : <span style={{ color: colors.textSecondary, fontSize: '13px' }}>—</span>}
                      </td>

                      {/* Total gastado */}
                      <td style={{ padding: '12px 16px' }}>
                        {(parseFloat(c.totalSpent) || 0) > 0
                          ? <span style={{ color: colors.green, fontSize: '13px', fontWeight: 600 }}>
                              ${Math.round(parseFloat(c.totalSpent)).toLocaleString('es-CL')} {c.currency}
                            </span>
                          : <span style={{ color: colors.textSecondary, fontSize: '13px' }}>—</span>}
                      </td>

                      {/* Último pedido */}
                      <td style={{ padding: '12px 16px' }}>
                        {c.lastOrder ? (
                          <div>
                            <div style={{ color: colors.textPrimary, fontSize: '12px' }}>{c.lastOrder.name}</div>
                            <div style={{ color: colors.textSecondary, fontSize: '11px' }}>{formatDate(c.lastOrder.createdAt)}</div>
                          </div>
                        ) : <span style={{ color: colors.borderStrong, fontSize: '12px' }}>—</span>}
                      </td>

                      {/* Ubicación */}
                      <td style={{ padding: '12px 16px', color: colors.textSecondary, fontSize: '12px' }}>
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
                              style={{ display: 'flex', alignItems: 'center', gap: '4px', backgroundColor: colors.bgHover, color: colors.textSecondary, padding: '5px 9px', borderRadius: '7px', fontSize: '11px', border: 'none', cursor: 'pointer' }}>
                              <MessageSquare size={11} /> Chat
                            </button>
                          )}
                          {c.phone && onOpenReengagement && (
                            <button
                              onClick={e => { e.stopPropagation(); onOpenReengagement(c.phone); }}
                              title="Re-enganchar este cliente"
                              style={{ display: 'flex', alignItems: 'center', gap: '4px', backgroundColor: `${colors.green}18`, color: colors.green, padding: '5px 9px', borderRadius: '7px', fontSize: '11px', border: `1px solid ${colors.green}33`, cursor: 'pointer' }}>
                              <UserCheck size={11} /> Reenganche
                            </button>
                          )}
                          <ChevronRight size={14} color={colors.borderStrong}
                            style={{ transform: expanded === c.shopifyId ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }} />
                        </div>
                      </td>
                    </tr>

                    {/* Detalle expandible */}
                    {expanded === c.shopifyId && (
                      <tr key={`${c.shopifyId}-detail`} style={{ backgroundColor: colors.bgApp }}>
                        <td colSpan={7} style={{ padding: '12px 16px 16px 62px', borderBottom: `2px solid ${colors.green}33` }}>
                          <div style={{ display: 'flex', gap: '32px', flexWrap: 'wrap' }}>
                            {c.lastOrder && (
                              <div>
                                <div style={{ color: colors.textSecondary, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>Último pedido</div>
                                <div style={{ backgroundColor: colors.bgPanel, borderRadius: '8px', padding: '10px 14px', border: `1px solid ${colors.border}`, minWidth: '200px' }}>
                                  <div style={{ color: colors.textPrimary, fontSize: '13px', fontWeight: 600, marginBottom: '4px' }}>{c.lastOrder.name}</div>
                                  {c.lastOrder.items?.length > 0 && (
                                    <div style={{ color: colors.textSecondary, fontSize: '12px', marginBottom: '4px' }}>{c.lastOrder.items.join(', ')}</div>
                                  )}
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <span style={{ color: colors.green, fontSize: '13px', fontWeight: 600 }}>
                                      ${Math.round(c.lastOrder.totalPrice).toLocaleString('es-CL')}
                                    </span>
                                    <span style={{ color: colors.textSecondary, fontSize: '11px' }}>{c.lastOrder.createdAt?.slice(0, 10)}</span>
                                  </div>
                                </div>
                              </div>
                            )}
                            <div>
                              <div style={{ color: colors.textSecondary, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>Info</div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', fontSize: '12px', color: colors.textSecondary }}>
                                <div><span style={{ color: colors.textPrimary }}>Cliente desde:</span> {formatDate(c.createdAt)}</div>
                                {c.city    && <div><span style={{ color: colors.textPrimary }}>Ciudad:</span> {c.city}</div>}
                                {c.country && <div><span style={{ color: colors.textPrimary }}>País:</span> {c.country}</div>}
                                {c.note    && <div><span style={{ color: colors.textPrimary }}>Nota:</span> {c.note}</div>}
                                {c.tags?.length > 0 && (
                                  <div style={{ display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' }}>
                                    <span style={{ color: colors.textPrimary }}>Tags:</span>
                                    {c.tags.map(t => (
                                      <span key={t} style={{ backgroundColor: colors.bgHover, color: colors.textSecondary, borderRadius: '4px', padding: '1px 6px', fontSize: '11px' }}>{t}</span>
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
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', padding: '16px', borderTop: `1px solid ${colors.border}` }}>
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={currentPage <= 1}
                  style={{ display: 'flex', alignItems: 'center', gap: '4px', backgroundColor: currentPage <= 1 ? colors.bgSub : colors.bgHover, color: currentPage <= 1 ? colors.borderStrong : colors.textSecondary, border: 'none', borderRadius: '7px', padding: '7px 12px', fontSize: '12px', cursor: currentPage <= 1 ? 'default' : 'pointer' }}>
                  <ChevronLeft size={14} /> Anterior
                </button>

                <span style={{ color: colors.textSecondary, fontSize: '13px' }}>
                  Página <strong style={{ color: colors.textPrimary }}>{currentPage}</strong> de <strong style={{ color: colors.textPrimary }}>{totalPages}</strong>
                  <span style={{ marginLeft: '8px', color: colors.borderStrong, fontSize: '11px' }}>
                    ({filtered.length} clientes{search ? ' encontrados' : ''})
                  </span>
                </span>

                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage >= totalPages}
                  style={{ display: 'flex', alignItems: 'center', gap: '4px', backgroundColor: currentPage >= totalPages ? colors.bgSub : colors.bgHover, color: currentPage >= totalPages ? colors.borderStrong : colors.textSecondary, border: 'none', borderRadius: '7px', padding: '7px 12px', fontSize: '12px', cursor: currentPage >= totalPages ? 'default' : 'pointer' }}>
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
