import { useState, useEffect, useCallback } from 'react';
import { Package, Search, RefreshCw, ExternalLink, Tag, AlertCircle, WifiOff } from 'lucide-react';
import { api } from '../utils/api.js';
import { useTheme } from '../theme.js';

export default function CatalogoPanel() {
  const { colors } = useTheme();
  const [products, setProducts] = useState([]);
  const [total, setTotal]       = useState(0);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [syncing, setSyncing]   = useState(false);
  const [search, setSearch]     = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [toast, setToast]       = useState(null);
  const [shop, setShop]         = useState('');

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  // Debounce búsqueda
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 350);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: 200 });
      if (debouncedSearch) params.set('search', debouncedSearch);
      // Timeout de 60s para aguantar el cold start de Render (gratis ~ 30-45s)
      const res = await api.get(`/catalogo?${params}`, { timeout: 60000 });
      setProducts(res.data.products || []);
      setTotal(res.data.total || 0);
      setShop(res.data.shop || '');
    } catch (err) {
      const msg = err.code === 'ECONNABORTED'
        ? 'La tienda Shopify tardó mucho en responder. Render necesita ~30s para arrancar — intenta de nuevo.'
        : (err.response?.data?.error || err.message || 'Error cargando catálogo');
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch]);

  useEffect(() => { load(); }, [load]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await api.post('/catalogo/sync');
      showToast(`✅ ${res.data.synced || 0} productos sincronizados`);
      load();
    } catch (err) {
      showToast(err.response?.data?.error || 'Error sincronizando', 'error');
    } finally {
      setSyncing(false);
    }
  };

  const activeProducts  = products.filter(p => p.status === 'active');
  const draftProducts   = products.filter(p => p.status !== 'active');

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100vh', backgroundColor: colors.bgApp, overflow: 'hidden' }}>

      {/* Header */}
      <div style={{
        padding: '14px 24px', backgroundColor: colors.bgPanel,
        borderBottom: `1px solid ${colors.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Package size={20} color={colors.green} />
          <h1 style={{ color: colors.textPrimary, fontSize: '17px', fontWeight: 600 }}>Catálogo</h1>
          <span style={{ backgroundColor: colors.bgHover, color: colors.textSecondary, borderRadius: '12px', padding: '2px 8px', fontSize: '12px' }}>
            {total} productos
          </span>
          {shop && (
            <span style={{ color: colors.textSecondary, fontSize: '12px' }}>· {shop}</span>
          )}
        </div>

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {/* Buscador */}
          <div style={{
            backgroundColor: colors.bgHover, borderRadius: '8px',
            display: 'flex', alignItems: 'center', padding: '7px 12px', gap: '7px',
          }}>
            <Search size={14} color={colors.textSecondary} />
            <input
              type="text"
              placeholder="Buscar producto..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ background: 'none', border: 'none', color: colors.textPrimary, fontSize: '13px', outline: 'none', width: '180px' }}
            />
          </div>

          {/* Sync */}
          <button
            onClick={handleSync}
            disabled={syncing}
            title="Sincronizar con Shopify"
            style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              backgroundColor: `${colors.green}22`, color: colors.green,
              padding: '8px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 500,
              border: `1px solid ${colors.green}33`, opacity: syncing ? 0.6 : 1,
            }}>
            <RefreshCw size={14} style={{ animation: syncing ? 'spin 1s linear infinite' : 'none' }} />
            {syncing ? 'Sincronizando...' : 'Sincronizar'}
          </button>
        </div>
      </div>

      {/* Stats rápidas */}
      {!loading && products.length > 0 && (
        <div style={{
          display: 'flex', gap: '12px', padding: '12px 24px',
          backgroundColor: colors.bgApp, borderBottom: `1px solid ${colors.border}`,
        }}>
          {[
            { label: 'Activos',    value: activeProducts.length,  color: colors.green },
            { label: 'Borradores', value: draftProducts.length,   color: colors.textSecondary },
            { label: 'Con stock',  value: products.filter(p => p.variants?.some(v => v.stock > 0)).length, color: colors.yellow },
          ].map(({ label, value, color }) => (
            <div key={label} style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              fontSize: '13px', color: colors.textSecondary,
            }}>
              <span style={{ color, fontWeight: 700 }}>{value}</span> {label}
            </div>
          ))}
        </div>
      )}

      {/* Contenido */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '80px', color: colors.textSecondary }}>
            <div style={{
              width: '40px', height: '40px', border: `3px solid ${colors.border}`,
              borderTop: `3px solid ${colors.green}`, borderRadius: '50%',
              animation: 'spin 1s linear infinite', margin: '0 auto 16px',
            }} />
            <div style={{ fontSize: '15px', marginBottom: '8px' }}>Cargando catálogo...</div>
            <div style={{ fontSize: '12px', opacity: 0.6 }}>
              Si es la primera vez, puede tardar ~30s (Shopify despertando)
            </div>
          </div>
        ) : error ? (
          <div style={{ textAlign: 'center', padding: '80px', color: colors.textSecondary }}>
            <WifiOff size={48} style={{ marginBottom: '16px', color: colors.red, opacity: 0.7 }} />
            <div style={{ fontSize: '15px', fontWeight: 500, color: colors.red, marginBottom: '10px' }}>
              Error al cargar catálogo
            </div>
            <div style={{
              fontSize: '13px', color: colors.textSecondary, maxWidth: '400px', margin: '0 auto 20px',
              lineHeight: 1.5,
            }}>
              {error}
            </div>
            <button
              onClick={load}
              style={{
                backgroundColor: `${colors.green}22`, color: colors.green,
                border: `1px solid ${colors.green}33`, borderRadius: '8px',
                padding: '9px 18px', fontSize: '13px', fontWeight: 500,
                cursor: 'pointer',
              }}>
              Reintentar
            </button>
          </div>
        ) : products.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '80px', color: colors.textSecondary }}>
            <Package size={48} style={{ marginBottom: '16px', opacity: 0.2 }} />
            <div style={{ fontSize: '16px', fontWeight: 500, marginBottom: '8px' }}>
              {debouncedSearch ? `Sin resultados para "${debouncedSearch}"` : 'Sin productos'}
            </div>
            {!debouncedSearch && (
              <div style={{ fontSize: '13px', opacity: 0.7 }}>
                Sincroniza tu tienda Shopify para importar el catálogo
              </div>
            )}
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: '14px',
          }}>
            {products.map(p => <ProductCard key={p.id} product={p} shop={shop} colors={colors} />)}
          </div>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: '24px', right: '24px', zIndex: 1000,
          backgroundColor: toast.type === 'error' ? (colors.bgAccent2) : colors.bgAccent,
          border: `1px solid ${toast.type === 'error' ? colors.red : colors.green}`,
          color: toast.type === 'error' ? colors.red : colors.green,
          padding: '12px 18px', borderRadius: '10px', fontSize: '13px', fontWeight: 500,
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        }}>
          {toast.msg}
        </div>
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

function ProductCard({ product: p, shop, colors }) {
  const minPrice = p.priceMin ?? p.price_min ?? 0;
  const maxPrice = p.priceMax ?? p.price_max ?? 0;
  const precio = minPrice === maxPrice
    ? `$${Number(minPrice).toLocaleString('es-CL')}`
    : `$${Number(minPrice).toLocaleString('es-CL')} – $${Number(maxPrice).toLocaleString('es-CL')}`;

  const variants = Array.isArray(p.variants) ? p.variants : [];
  const totalStock = variants.reduce((sum, v) => sum + (v.stock || 0), 0);
  const isActive = p.status === 'active';
  const productUrl = shop && p.handle ? `https://${shop}/products/${p.handle}` : null;

  const tags = Array.isArray(p.tags) ? p.tags : [];

  return (
    <div style={{
      backgroundColor: colors.bgPanel,
      borderRadius: '12px',
      border: `1px solid ${colors.border}`,
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      transition: 'border-color 0.2s, transform 0.1s',
    }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = colors.borderStrong; e.currentTarget.style.transform = 'translateY(-1px)'; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = colors.border; e.currentTarget.style.transform = 'translateY(0)'; }}
    >
      {/* Imagen */}
      <div style={{
        height: '160px', backgroundColor: colors.bgSub,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        overflow: 'hidden', position: 'relative',
      }}>
        {p.imageUrl ? (
          <img src={p.imageUrl} alt={p.title}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <Package size={40} color={colors.borderStrong} />
        )}

        {/* Badge status */}
        <div style={{
          position: 'absolute', top: '8px', left: '8px',
          backgroundColor: isActive ? colors.bgAccent : colors.bgHover,
          color: isActive ? colors.green : colors.textSecondary,
          borderRadius: '6px', padding: '3px 8px', fontSize: '11px', fontWeight: 600,
          border: `1px solid ${isActive ? `${colors.green}33` : colors.borderStrong}`,
        }}>
          {isActive ? 'Activo' : 'Borrador'}
        </div>

        {/* Link externo */}
        {productUrl && (
          <a href={productUrl} target="_blank" rel="noreferrer"
            style={{
              position: 'absolute', top: '8px', right: '8px',
              backgroundColor: 'rgba(0,0,0,0.5)', color: colors.textPrimary,
              borderRadius: '6px', padding: '5px', display: 'flex',
            }}
            onClick={e => e.stopPropagation()}>
            <ExternalLink size={13} />
          </a>
        )}
      </div>

      {/* Info */}
      <div style={{ padding: '12px 14px', flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <div style={{ fontWeight: 600, color: colors.textPrimary, fontSize: '14px', lineHeight: '1.3' }}>
          {p.title}
        </div>

        {p.vendor && (
          <div style={{ color: colors.textSecondary, fontSize: '12px' }}>{p.vendor}</div>
        )}

        {p.description && (
          <div style={{ color: colors.textSecondary, fontSize: '12px', lineHeight: '1.5', WebkitLineClamp: 2, display: '-webkit-box', WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {p.description}
          </div>
        )}

        {/* Precio */}
        <div style={{ color: colors.green, fontSize: '16px', fontWeight: 700, marginTop: '2px' }}>
          {precio}
        </div>

        {/* Variantes */}
        {variants.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', marginTop: '2px' }}>
            {variants.slice(0, 3).map((v, i) => (
              <div key={i} style={{
                display: 'flex', justifyContent: 'space-between',
                fontSize: '12px', color: colors.textSecondary,
              }}>
                <span>{v.title}</span>
                <span style={{ color: v.stock > 0 ? colors.textPrimary : colors.red }}>
                  {v.stock != null ? (v.stock > 0 ? `${v.stock} un.` : 'Agotado') : '—'}
                </span>
              </div>
            ))}
            {variants.length > 3 && (
              <div style={{ fontSize: '11px', color: colors.textSecondary, opacity: 0.7 }}>
                +{variants.length - 3} variantes más
              </div>
            )}
          </div>
        )}

        {/* Tags */}
        {tags.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '4px' }}>
            {tags.slice(0, 3).map((tag, i) => (
              <span key={i} style={{
                backgroundColor: colors.bgHover, color: colors.textSecondary,
                borderRadius: '6px', padding: '2px 7px', fontSize: '11px',
                display: 'flex', alignItems: 'center', gap: '3px',
              }}>
                <Tag size={9} /> {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Footer stock total */}
      <div style={{
        padding: '8px 14px', borderTop: `1px solid ${colors.border}`,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span style={{ fontSize: '12px', color: colors.textSecondary }}>
          {variants.length} variante{variants.length !== 1 ? 's' : ''}
        </span>
        <span style={{
          fontSize: '12px', fontWeight: 600,
          color: totalStock > 0 ? colors.green : colors.red,
        }}>
          {totalStock > 0 ? `${totalStock} en stock` : 'Sin stock'}
        </span>
      </div>
    </div>
  );
}
