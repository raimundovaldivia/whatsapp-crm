/**
 * Tienda.jsx — Tienda pública inspirada en diezrios.com
 * Accesible en /tienda/:slug sin autenticación.
 */
import { useState, useEffect, useCallback } from 'react';
import { ShoppingCart, Plus, Minus, X, ChevronRight, CheckCircle, Search, MessageCircle } from 'lucide-react';

const API_BASE = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

async function apiFetch(path) {
  const r = await fetch(`${API_BASE}${path}`);
  if (!r.ok) throw new Error((await r.json()).error || 'Error');
  return r.json();
}

async function apiPost(path, body) {
  const r = await fetch(`${API_BASE}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Error');
  return data;
}

const fmt = (n) => `$${Number(n).toLocaleString('es-CL')}`;

// ── Estilos base ───────────────────────────────────────────────────
const BASE_FONT = "'Inter', system-ui, -apple-system, sans-serif";

export default function Tienda({ slug }) {
  const [store, setStore]       = useState(null);
  const [products, setProducts] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [search, setSearch]     = useState('');
  const [cart, setCart]         = useState([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [view, setView]         = useState('catalog'); // 'catalog' | 'checkout' | 'success'
  const [form, setForm]         = useState({ name: '', phone: '', address: '', city: '' });
  const [submitting, setSubmitting] = useState(false);
  const [orderResult, setOrderResult] = useState(null);
  const [formErrors, setFormErrors]   = useState({});
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Liberar el overflow bloqueado por el CSS global del CRM
  useEffect(() => {
    document.body.style.overflow   = 'auto';
    document.body.style.height     = 'auto';
    document.body.style.background = 'white';
    document.body.style.color      = '#111827';
    const root = document.getElementById('root');
    if (root) { root.style.height = 'auto'; root.style.display = 'block'; }
    return () => {
      document.body.style.overflow   = '';
      document.body.style.height     = '';
      document.body.style.background = '';
      document.body.style.color      = '';
      if (root) { root.style.height = ''; root.style.display = ''; }
    };
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [storeData, prodData] = await Promise.all([
          apiFetch(`/store/${slug}/info`),
          apiFetch(`/store/${slug}/products`),
        ]);
        setStore(storeData);
        setProducts(prodData.products || []);
      } catch { setNotFound(true); }
      finally { setLoading(false); }
    })();
  }, [slug]);

  const PRIMARY   = store?.color || '#22c55e';
  const PRIMARY_D = store?.color ? store.color : '#16a34a'; // darker shade

  const cartCount  = cart.reduce((s, i) => s + i.quantity, 0);
  const cartTotal  = cart.reduce((s, i) => s + parseFloat(i.product.price) * i.quantity, 0);
  const FREE_SHIP  = store?.free_shipping_threshold ? Number(store.free_shipping_threshold) : 10000;

  const filteredProducts = products.filter(p =>
    !search || p.title.toLowerCase().includes(search.toLowerCase())
  );

  const addToCart = useCallback((product) => {
    setCart(prev => {
      const ex = prev.find(i => i.product.id === product.id);
      if (ex) return prev.map(i => i.product.id === product.id ? { ...i, quantity: i.quantity + 1 } : i);
      return [...prev, { product, quantity: 1 }];
    });
  }, []);

  const removeOne = useCallback((id) => {
    setCart(prev => {
      const ex = prev.find(i => i.product.id === id);
      if (!ex) return prev;
      if (ex.quantity === 1) return prev.filter(i => i.product.id !== id);
      return prev.map(i => i.product.id === id ? { ...i, quantity: i.quantity - 1 } : i);
    });
  }, []);

  const removeItem = useCallback((id) => setCart(prev => prev.filter(i => i.product.id !== id)), []);

  const getQty = (id) => cart.find(i => i.product.id === id)?.quantity || 0;

  const validate = () => {
    const e = {};
    if (!form.name.trim())    e.name    = 'Requerido';
    if (!form.phone.trim())   e.phone   = 'Requerido';
    if (!form.address.trim()) e.address = 'Requerido';
    if (!form.city.trim())    e.city    = 'Requerido';
    setFormErrors(e);
    return !Object.keys(e).length;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    setSubmitting(true);
    try {
      const items  = cart.map(i => ({ productId: i.product.id, quantity: i.quantity }));
      const result = await apiPost(`/store/${slug}/orders`, { ...form, items });
      setOrderResult(result);
      setCart([]);
      setView('success');
    } catch (err) { alert(err.message); }
    finally { setSubmitting(false); }
  };

  // ─── Loading / Not found ──────────────────────────────────────────
  if (loading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: BASE_FONT }}>
      <div style={{ textAlign: 'center', color: '#6b7280' }}>
        <div style={{ width: 40, height: 40, border: '3px solid #e5e7eb', borderTopColor: '#22c55e', borderRadius: '50%', margin: '0 auto 16px', animation: 'spin 0.8s linear infinite' }} />
        Cargando tienda...
        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    </div>
  );

  if (notFound) return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontFamily: BASE_FONT, gap: 12 }}>
      <div style={{ fontSize: 48 }}>🏪</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: '#111827' }}>Tienda no encontrada</div>
      <div style={{ color: '#6b7280' }}>Verifica el enlace e intenta nuevamente.</div>
    </div>
  );

  const logoUrl = store?.logo;
  const storeName = store?.name || 'Tienda';

  // ─── Página de éxito ──────────────────────────────────────────────
  if (view === 'success') return (
    <div style={{ minHeight: '100vh', backgroundColor: '#f9fafb', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: BASE_FONT }}>
      <div style={{ backgroundColor: 'white', borderRadius: 16, padding: '40px 32px', maxWidth: 440, width: '100%', textAlign: 'center', boxShadow: '0 4px 24px rgba(0,0,0,0.08)' }}>
        <div style={{ width: 72, height: 72, borderRadius: '50%', backgroundColor: `${PRIMARY}20`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
          <CheckCircle size={40} color={PRIMARY} />
        </div>
        <h2 style={{ margin: '0 0 8px', fontSize: 24, fontWeight: 800, color: '#111827' }}>¡Pedido recibido!</h2>
        <p style={{ margin: '0 0 20px', color: '#6b7280', fontSize: 15, lineHeight: 1.6 }}>
          Te enviamos la confirmación por WhatsApp al número <strong>{form.phone}</strong>.
        </p>
        <div style={{ backgroundColor: '#f9fafb', borderRadius: 12, padding: 16, marginBottom: 24, textAlign: 'left', fontSize: 14, color: '#374151', lineHeight: 1.8 }}>
          <div>📍 <strong>Entrega:</strong> {form.address}, {form.city}</div>
          <div>💵 <strong>Total:</strong> {fmt(orderResult?.total)}</div>
          <div>💳 <strong>Pago:</strong> Contra entrega</div>
        </div>
        <button onClick={() => { setView('catalog'); setForm({ name: '', phone: '', address: '', city: '' }); }}
          style={{ padding: '13px 28px', borderRadius: 10, border: 'none', backgroundColor: PRIMARY, color: 'white', fontWeight: 700, cursor: 'pointer', fontSize: 15 }}>
          Seguir comprando
        </button>
      </div>
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', backgroundColor: 'white', fontFamily: BASE_FONT, color: '#111827' }}>

      {/* ── Announcement bar ─────────────────────────────────────── */}
      <div style={{ backgroundColor: '#111827', color: 'white', textAlign: 'center', padding: '10px 16px', fontSize: 13, fontWeight: 500, letterSpacing: 0.2 }}>
        🚚 Delivery gratis por compras sobre {fmt(FREE_SHIP)}
      </div>

      {/* ── Header ───────────────────────────────────────────────── */}
      <header style={{ backgroundColor: 'white', borderBottom: '1px solid #e5e7eb', position: 'sticky', top: 0, zIndex: 100, boxShadow: '0 1px 8px rgba(0,0,0,0.06)' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '14px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>

          {/* Logo */}
          <a href="#" onClick={() => { setView('catalog'); setCartOpen(false); }} style={{ textDecoration: 'none', flexShrink: 0 }}>
            {logoUrl
              ? <img src={logoUrl} alt={storeName} style={{ height: 48, width: 'auto', objectFit: 'contain' }} />
              : <span style={{ fontSize: 22, fontWeight: 900, color: '#111827', letterSpacing: -0.5 }}>{storeName}</span>
            }
          </a>

          {/* Search (desktop) */}
          <div style={{ flex: 1, maxWidth: 420, display: 'flex', alignItems: 'center', backgroundColor: '#f3f4f6', borderRadius: 10, padding: '8px 14px', gap: 8 }}>
            <Search size={16} color="#9ca3af" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar productos..."
              style={{ flex: 1, border: 'none', backgroundColor: 'transparent', outline: 'none', fontSize: 14, color: '#111827' }} />
            {search && <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={14} /></button>}
          </div>

          {/* Cart button */}
          <button onClick={() => setCartOpen(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 18px', borderRadius: 10,
              backgroundColor: PRIMARY, border: 'none', color: 'white', fontWeight: 700, cursor: 'pointer', fontSize: 14, flexShrink: 0, position: 'relative' }}>
            <ShoppingCart size={18} />
            <span style={{ display: 'none' }}>Carrito</span>
            {cartCount > 0 && (
              <span style={{ backgroundColor: 'white', color: PRIMARY, borderRadius: 10, padding: '1px 7px',
                fontSize: 11, fontWeight: 800, marginLeft: 2 }}>{cartCount}</span>
            )}
          </button>
        </div>

        {/* Search (mobile) */}
        <div style={{ padding: '0 16px 12px', display: 'none' }} className="mobile-search">
          <div style={{ display: 'flex', alignItems: 'center', backgroundColor: '#f3f4f6', borderRadius: 10, padding: '8px 14px', gap: 8 }}>
            <Search size={16} color="#9ca3af" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar..."
              style={{ flex: 1, border: 'none', backgroundColor: 'transparent', outline: 'none', fontSize: 14, color: '#111827' }} />
          </div>
        </div>
      </header>

      {/* ── Main content ─────────────────────────────────────────── */}
      {view === 'catalog' && (
        <>
          {/* Hero */}
          <section style={{ background: 'linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 50%, #f9fafb 100%)', padding: '56px 24px' }}>
            <div style={{ maxWidth: 1200, margin: '0 auto', display: 'flex', alignItems: 'center', gap: 48, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 280 }}>
                <div style={{ display: 'inline-block', backgroundColor: `${PRIMARY}20`, color: PRIMARY, fontSize: 12, fontWeight: 700, padding: '5px 12px', borderRadius: 20, marginBottom: 16, letterSpacing: 0.5, textTransform: 'uppercase' }}>
                  Del campo a tu mesa
                </div>
                <h1 style={{ margin: '0 0 16px', fontSize: 'clamp(28px, 4vw, 46px)', fontWeight: 900, lineHeight: 1.15, color: '#111827', letterSpacing: -1 }}>
                  Productos frescos<br /><span style={{ color: PRIMARY }}>directo al hogar</span>
                </h1>
                <p style={{ margin: '0 0 24px', fontSize: 16, color: '#6b7280', lineHeight: 1.7, maxWidth: 440 }}>
                  Sin intermediarios, sin secretos. Animales criados en libertad, productos que llegan frescos a tu puerta en La Serena y Coquimbo.
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 28 }}>
                  {['🥚 Huevos de gallinas libres', '🫒 Aceitunas artesanales', '🧀 Selección quesera', '🚚 Lunes a sábado'].map(tag => (
                    <span key={tag} style={{ backgroundColor: 'white', border: '1px solid #e5e7eb', borderRadius: 20, padding: '5px 12px', fontSize: 13, fontWeight: 500, color: '#374151' }}>{tag}</span>
                  ))}
                </div>
                <button onClick={() => document.getElementById('catalogo')?.scrollIntoView({ behavior: 'smooth' })}
                  style={{ padding: '14px 28px', borderRadius: 12, border: 'none', backgroundColor: PRIMARY, color: 'white', fontWeight: 800, fontSize: 16, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  Ver productos <ChevronRight size={18} />
                </button>
                <div style={{ marginTop: 24, display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ display: 'flex' }}>
                    {['⭐','⭐','⭐','⭐','⭐'].map((s,i) => <span key={i} style={{ fontSize: 16 }}>{s}</span>)}
                  </div>
                  <span style={{ fontSize: 13, color: '#6b7280', fontWeight: 500 }}>Más de 500 caseritos felices</span>
                </div>
              </div>
              {/* Stats */}
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                {[
                  { num: '100%', label: 'Campo libre', icon: '🌿' },
                  { num: '0', label: 'Intermediarios', icon: '🤝' },
                  { num: '52', label: 'Semanas al año', icon: '📅' },
                ].map(s => (
                  <div key={s.label} style={{ backgroundColor: 'white', borderRadius: 14, padding: '20px 24px', textAlign: 'center', boxShadow: '0 2px 12px rgba(0,0,0,0.06)', border: '1px solid #e5e7eb', minWidth: 100 }}>
                    <div style={{ fontSize: 28 }}>{s.icon}</div>
                    <div style={{ fontSize: 26, fontWeight: 900, color: PRIMARY, lineHeight: 1.2, marginTop: 8 }}>{s.num}</div>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4, fontWeight: 500 }}>{s.label}</div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* Delivery promo banner */}
          {cartTotal > 0 && cartTotal < FREE_SHIP && (
            <div style={{ backgroundColor: '#fefce8', borderBottom: '1px solid #fef08a', textAlign: 'center', padding: '10px 16px', fontSize: 13, color: '#854d0e', fontWeight: 600 }}>
              🚚 Te faltan {fmt(FREE_SHIP - cartTotal)} para el delivery gratis
            </div>
          )}
          {cartTotal >= FREE_SHIP && cartTotal > 0 && (
            <div style={{ backgroundColor: '#f0fdf4', borderBottom: '1px solid #bbf7d0', textAlign: 'center', padding: '10px 16px', fontSize: 13, color: '#166534', fontWeight: 600 }}>
              ✅ ¡Tienes delivery gratis!
            </div>
          )}

          {/* Catalog */}
          <section id="catalogo" style={{ maxWidth: 1200, margin: '0 auto', padding: '48px 24px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 28, flexWrap: 'wrap', gap: 8 }}>
              <h2 style={{ margin: 0, fontSize: 28, fontWeight: 800, color: '#111827' }}>
                {search ? `Resultados para "${search}"` : 'Todos los productos'}
              </h2>
              <span style={{ fontSize: 14, color: '#6b7280' }}>{filteredProducts.length} producto{filteredProducts.length !== 1 ? 's' : ''}</span>
            </div>

            {filteredProducts.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '80px 0', color: '#9ca3af' }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>🔍</div>
                <p style={{ fontSize: 16 }}>No encontramos productos para "{search}"</p>
                <button onClick={() => setSearch('')} style={{ marginTop: 12, padding: '8px 18px', borderRadius: 8, border: `1px solid ${PRIMARY}`, backgroundColor: 'white', color: PRIMARY, cursor: 'pointer', fontWeight: 600 }}>Ver todos</button>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 20 }}>
                {filteredProducts.map(product => {
                  const qty = getQty(product.id);
                  const hasDiscount = product.compare_price && parseFloat(product.compare_price) > parseFloat(product.price);
                  const outOfStock  = product.stock === 0;
                  return (
                    <div key={product.id}
                      style={{ backgroundColor: 'white', borderRadius: 14, overflow: 'hidden',
                        border: '1px solid #e5e7eb', transition: 'transform 0.15s, box-shadow 0.15s',
                        boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
                        opacity: outOfStock ? 0.7 : 1 }}
                      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 8px 24px rgba(0,0,0,0.10)'; }}
                      onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = '0 1px 4px rgba(0,0,0,0.05)'; }}>

                      {/* Image */}
                      <div style={{ position: 'relative', height: 220, backgroundColor: '#f9fafb', overflow: 'hidden' }}>
                        {product.image_url
                          ? <img src={product.image_url} alt={product.title} style={{ width: '100%', height: '100%', objectFit: 'cover', transition: 'transform 0.3s' }}
                              onMouseEnter={e => e.target.style.transform = 'scale(1.04)'}
                              onMouseLeave={e => e.target.style.transform = 'scale(1)'} />
                          : <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 48 }}>🥚</div>
                        }
                        {outOfStock && (
                          <div style={{ position: 'absolute', top: 10, left: 10, backgroundColor: '#111827', color: 'white', fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 20 }}>Agotado</div>
                        )}
                        {hasDiscount && !outOfStock && (
                          <div style={{ position: 'absolute', top: 10, left: 10, backgroundColor: '#ef4444', color: 'white', fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 20 }}>
                            -{Math.round((1 - product.price / product.compare_price) * 100)}%
                          </div>
                        )}
                      </div>

                      {/* Info */}
                      <div style={{ padding: '14px 16px 16px' }}>
                        <h3 style={{ margin: '0 0 6px', fontSize: 14, fontWeight: 700, color: '#111827', lineHeight: 1.4 }}>{product.title}</h3>
                        {product.description && (
                          <p style={{ margin: '0 0 10px', fontSize: 12, color: '#9ca3af', lineHeight: 1.5,
                            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                            {product.description}
                          </p>
                        )}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                          <span style={{ fontSize: 18, fontWeight: 800, color: '#111827' }}>{fmt(product.price)}</span>
                          {hasDiscount && <span style={{ fontSize: 12, color: '#9ca3af', textDecoration: 'line-through' }}>{fmt(product.compare_price)}</span>}
                        </div>

                        {outOfStock ? (
                          <div style={{ textAlign: 'center', padding: '9px', borderRadius: 8, backgroundColor: '#f3f4f6', color: '#9ca3af', fontSize: 13, fontWeight: 600 }}>Sin stock</div>
                        ) : qty === 0 ? (
                          <button onClick={() => addToCart(product)}
                            style={{ width: '100%', padding: '10px', borderRadius: 9, border: 'none',
                              backgroundColor: PRIMARY, color: 'white', fontWeight: 700, cursor: 'pointer', fontSize: 14,
                              transition: 'background 0.15s' }}
                            onMouseEnter={e => e.target.style.backgroundColor = PRIMARY_D}
                            onMouseLeave={e => e.target.style.backgroundColor = PRIMARY}>
                            Añadir al carrito
                          </button>
                        ) : (
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#f9fafb', borderRadius: 9, padding: '4px 6px', border: `1.5px solid ${PRIMARY}` }}>
                            <button onClick={() => removeOne(product.id)}
                              style={{ width: 34, height: 34, borderRadius: 7, border: 'none', backgroundColor: 'white', cursor: 'pointer',
                                display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', fontWeight: 700, fontSize: 18, color: '#374151' }}>
                              −
                            </button>
                            <span style={{ fontWeight: 800, fontSize: 16, color: '#111827', minWidth: 24, textAlign: 'center' }}>{qty}</span>
                            <button onClick={() => addToCart(product)}
                              style={{ width: 34, height: 34, borderRadius: 7, border: 'none', backgroundColor: PRIMARY, color: 'white',
                                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 18 }}>
                              +
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* How it works */}
          <section style={{ backgroundColor: '#f9fafb', borderTop: '1px solid #e5e7eb', padding: '56px 24px' }}>
            <div style={{ maxWidth: 1200, margin: '0 auto', textAlign: 'center' }}>
              <p style={{ margin: '0 0 8px', fontSize: 12, fontWeight: 700, color: PRIMARY, textTransform: 'uppercase', letterSpacing: 1 }}>Cómo funciona</p>
              <h2 style={{ margin: '0 0 40px', fontSize: 28, fontWeight: 800, color: '#111827' }}>Del campo a tu puerta</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 24 }}>
                {[
                  { step: '1', icon: '🛒', title: 'Elige tus productos', desc: 'Arma tu pedido con lo que más te gusta.' },
                  { step: '2', icon: '📅', title: 'Pide toda la semana', desc: 'Los pedidos cierran de lunes a sábado a las 11 AM.' },
                  { step: '3', icon: '🌿', title: 'Lo preparamos fresco', desc: 'Directo desde el campo, sin intermediarios.' },
                  { step: '4', icon: '🚚', title: 'Llega rápido', desc: 'Despacho a domicilio. Gratis sobre ' + fmt(FREE_SHIP) + '.' },
                ].map(s => (
                  <div key={s.step} style={{ backgroundColor: 'white', borderRadius: 14, padding: '28px 20px', border: '1px solid #e5e7eb' }}>
                    <div style={{ width: 44, height: 44, borderRadius: '50%', backgroundColor: `${PRIMARY}20`, color: PRIMARY,
                      fontWeight: 800, fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>{s.step}</div>
                    <div style={{ fontSize: 32, marginBottom: 10 }}>{s.icon}</div>
                    <div style={{ fontWeight: 700, fontSize: 15, color: '#111827', marginBottom: 6 }}>{s.title}</div>
                    <div style={{ fontSize: 13, color: '#6b7280', lineHeight: 1.6 }}>{s.desc}</div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* Footer */}
          <footer style={{ backgroundColor: '#111827', color: '#9ca3af', padding: '32px 24px', textAlign: 'center' }}>
            <div style={{ maxWidth: 1200, margin: '0 auto' }}>
              {logoUrl
                ? <img src={logoUrl} alt={storeName} style={{ height: 40, filter: 'brightness(0) invert(1)', marginBottom: 12, opacity: 0.8 }} />
                : <div style={{ fontSize: 20, fontWeight: 800, color: 'white', marginBottom: 12 }}>{storeName}</div>
              }
              <p style={{ margin: '0 0 16px', fontSize: 13 }}>Productos frescos del campo a tu mesa · La Serena y Coquimbo</p>
              <p style={{ margin: 0, fontSize: 12 }}>© {new Date().getFullYear()} {storeName}</p>
            </div>
          </footer>
        </>
      )}

      {/* ── Checkout ──────────────────────────────────────────────── */}
      {view === 'checkout' && (
        <div style={{ maxWidth: 680, margin: '0 auto', padding: '40px 24px' }}>
          <button onClick={() => setView('catalog')}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', fontSize: 14, marginBottom: 24, display: 'flex', alignItems: 'center', gap: 6, padding: 0 }}>
            ← Volver al catálogo
          </button>
          <h2 style={{ margin: '0 0 28px', fontSize: 24, fontWeight: 800, color: '#111827' }}>Finalizar pedido</h2>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 20 }}>
            {/* Resumen */}
            <div style={{ backgroundColor: '#f9fafb', borderRadius: 14, padding: 20, border: '1px solid #e5e7eb' }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: '#111827', marginBottom: 14 }}>Resumen del pedido</div>
              {cart.map(({ product, quantity }) => (
                <div key={product.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #e5e7eb', gap: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    {product.image_url && <img src={product.image_url} alt="" style={{ width: 44, height: 44, borderRadius: 8, objectFit: 'cover', border: '1px solid #e5e7eb' }} />}
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{product.title}</div>
                      <div style={{ fontSize: 12, color: '#6b7280' }}>Cant: {quantity}</div>
                    </div>
                  </div>
                  <div style={{ fontWeight: 700, fontSize: 14, color: '#111827', flexShrink: 0 }}>{fmt(parseFloat(product.price) * quantity)}</div>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 12, fontWeight: 800, fontSize: 17, color: '#111827' }}>
                <span>Total</span>
                <span>{fmt(cartTotal)}</span>
              </div>
              {cartTotal >= FREE_SHIP
                ? <div style={{ fontSize: 12, color: '#16a34a', marginTop: 6, fontWeight: 600 }}>✅ Delivery gratis incluido</div>
                : <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>💳 Pago contra entrega al recibir</div>
              }
            </div>

            {/* Formulario */}
            <div style={{ backgroundColor: 'white', borderRadius: 14, padding: 24, border: '1px solid #e5e7eb' }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: '#111827', marginBottom: 18 }}>Datos de entrega</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {[
                  { label: 'Nombre completo', key: 'name', placeholder: 'Juan Pérez', type: 'text' },
                  { label: 'WhatsApp', key: 'phone', placeholder: '56912345678', type: 'tel' },
                  { label: 'Dirección de entrega', key: 'address', placeholder: 'Calle 123, depto 4', type: 'text' },
                  { label: 'Ciudad', key: 'city', placeholder: 'La Serena', type: 'text' },
                ].map(({ label, key, placeholder, type }) => (
                  <div key={key}>
                    <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 5 }}>{label} *</label>
                    <input type={type} value={form[key]} placeholder={placeholder}
                      onChange={e => { setForm(f => ({ ...f, [key]: e.target.value })); setFormErrors(e => ({ ...e, [key]: null })); }}
                      style={{ width: '100%', padding: '11px 14px', borderRadius: 10,
                        border: `1.5px solid ${formErrors[key] ? '#ef4444' : '#e5e7eb'}`,
                        fontSize: 14, boxSizing: 'border-box', outline: 'none', color: '#111827',
                        transition: 'border-color 0.15s' }}
                      onFocus={e => e.target.style.borderColor = PRIMARY}
                      onBlur={e => e.target.style.borderColor = formErrors[key] ? '#ef4444' : '#e5e7eb'} />
                    {formErrors[key] && <div style={{ fontSize: 12, color: '#ef4444', marginTop: 3 }}>{formErrors[key]}</div>}
                  </div>
                ))}
              </div>
              <button onClick={handleSubmit} disabled={submitting || !cart.length}
                style={{ marginTop: 20, width: '100%', padding: '14px', borderRadius: 12, border: 'none',
                  backgroundColor: submitting ? '#9ca3af' : PRIMARY,
                  color: 'white', fontWeight: 800, fontSize: 16, cursor: submitting ? 'not-allowed' : 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'background 0.15s' }}>
                {submitting ? 'Enviando...' : `Confirmar pedido · ${fmt(cartTotal)}`}
                {!submitting && <ChevronRight size={18} />}
              </button>
              <p style={{ textAlign: 'center', fontSize: 12, color: '#9ca3af', marginTop: 12 }}>
                Al confirmar recibirás una notificación por WhatsApp 📱
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Carrito lateral ───────────────────────────────────────── */}
      {cartOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 200 }}>
          <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(2px)' }} onClick={() => setCartOpen(false)} />
          <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: '100%', maxWidth: 400,
            backgroundColor: 'white', boxShadow: '-8px 0 40px rgba(0,0,0,0.15)', display: 'flex', flexDirection: 'column' }}>

            {/* Header carrito */}
            <div style={{ padding: '20px 24px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 18, color: '#111827' }}>Tu carrito</div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{cartCount} producto{cartCount !== 1 ? 's' : ''}</div>
              </div>
              <button onClick={() => setCartOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: 4 }}>
                <X size={22} />
              </button>
            </div>

            {/* Free shipping progress */}
            {cartTotal > 0 && (
              <div style={{ padding: '12px 24px', backgroundColor: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
                <div style={{ fontSize: 12, color: cartTotal >= FREE_SHIP ? '#16a34a' : '#374151', fontWeight: 600, marginBottom: 6 }}>
                  {cartTotal >= FREE_SHIP ? '✅ ¡Delivery gratis!' : `Agrega ${fmt(FREE_SHIP - cartTotal)} más para delivery gratis`}
                </div>
                <div style={{ height: 6, backgroundColor: '#e5e7eb', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${Math.min(100, (cartTotal / FREE_SHIP) * 100)}%`, backgroundColor: PRIMARY, borderRadius: 3, transition: 'width 0.3s' }} />
                </div>
              </div>
            )}

            {/* Items */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
              {cart.length === 0 ? (
                <div style={{ textAlign: 'center', color: '#9ca3af', padding: '60px 0' }}>
                  <ShoppingCart size={48} style={{ marginBottom: 16, opacity: 0.2 }} />
                  <p style={{ margin: 0, fontSize: 15 }}>Tu carrito está vacío</p>
                  <button onClick={() => setCartOpen(false)} style={{ marginTop: 16, padding: '9px 20px', borderRadius: 8, border: `1px solid ${PRIMARY}`, backgroundColor: 'white', color: PRIMARY, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                    Ver productos
                  </button>
                </div>
              ) : cart.map(({ product, quantity }) => (
                <div key={product.id} style={{ display: 'flex', gap: 14, padding: '14px 0', borderBottom: '1px solid #f3f4f6' }}>
                  {product.image_url
                    ? <img src={product.image_url} alt="" style={{ width: 64, height: 64, borderRadius: 10, objectFit: 'cover', border: '1px solid #e5e7eb', flexShrink: 0 }} />
                    : <div style={{ width: 64, height: 64, borderRadius: 10, backgroundColor: '#f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, flexShrink: 0 }}>🥚</div>
                  }
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, color: '#111827', lineHeight: 1.3, marginBottom: 4 }}>{product.title}</div>
                    <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 8 }}>{fmt(product.price)} c/u</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <button onClick={() => removeOne(product.id)} style={{ width: 28, height: 28, borderRadius: 6, border: '1px solid #e5e7eb', backgroundColor: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>−</button>
                      <span style={{ fontWeight: 700, fontSize: 14, minWidth: 20, textAlign: 'center' }}>{quantity}</span>
                      <button onClick={() => addToCart(product)} style={{ width: 28, height: 28, borderRadius: 6, border: 'none', backgroundColor: PRIMARY, color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>+</button>
                      <button onClick={() => removeItem(product.id)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#d1d5db', padding: 2 }}><X size={14} /></button>
                    </div>
                  </div>
                  <div style={{ fontWeight: 700, fontSize: 14, color: '#111827', flexShrink: 0 }}>{fmt(parseFloat(product.price) * quantity)}</div>
                </div>
              ))}
            </div>

            {/* Footer carrito */}
            {cart.length > 0 && (
              <div style={{ padding: '20px 24px', borderTop: '1px solid #e5e7eb' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontSize: 14, color: '#6b7280' }}>Subtotal</span>
                  <span style={{ fontWeight: 700, fontSize: 14, color: '#111827' }}>{fmt(cartTotal)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
                  <span style={{ fontSize: 14, color: '#6b7280' }}>Envío</span>
                  <span style={{ fontWeight: 600, fontSize: 14, color: cartTotal >= FREE_SHIP ? '#16a34a' : '#111827' }}>
                    {cartTotal >= FREE_SHIP ? 'Gratis' : 'Se calcula al confirmar'}
                  </span>
                </div>
                <button onClick={() => { setCartOpen(false); setView('checkout'); }}
                  style={{ width: '100%', padding: 14, borderRadius: 12, border: 'none', backgroundColor: PRIMARY,
                    color: 'white', fontWeight: 800, fontSize: 16, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  Ir al checkout <ChevronRight size={18} />
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── WhatsApp flotante ─────────────────────────────────────── */}
      <a href={`https://wa.me/56942876413?text=Hola+${encodeURIComponent(storeName)}%21+Tengo+una+pregunta+sobre+sus+productos`}
        target="_blank" rel="noreferrer"
        style={{ position: 'fixed', bottom: 24, right: 24, width: 56, height: 56, borderRadius: '50%',
          backgroundColor: '#25d366', display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 4px 20px rgba(37,211,102,0.5)', zIndex: 150, textDecoration: 'none',
          transition: 'transform 0.2s, box-shadow 0.2s' }}
        onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.1)'; e.currentTarget.style.boxShadow = '0 6px 28px rgba(37,211,102,0.6)'; }}
        onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.boxShadow = '0 4px 20px rgba(37,211,102,0.5)'; }}>
        <MessageCircle size={28} color="white" fill="white" />
      </a>

      <style>{`
        * { box-sizing: border-box; }
        @media (max-width: 640px) {
          .mobile-search { display: block !important; }
        }
      `}</style>
    </div>
  );
}
