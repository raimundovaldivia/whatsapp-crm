/**
 * Tienda.jsx — Tienda pública responsive (mobile-first)
 */
import { useState, useEffect, useCallback } from 'react';
import { ShoppingCart, X, ChevronRight, CheckCircle, Search, MessageCircle, Menu } from 'lucide-react';

const API_BASE = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

const apiFetch = async (path) => {
  const r = await fetch(`${API_BASE}${path}`);
  if (!r.ok) throw new Error((await r.json()).error || 'Error');
  return r.json();
};
const apiPost = async (path, body) => {
  const r = await fetch(`${API_BASE}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Error');
  return d;
};
const fmt = (n) => `$${Number(n).toLocaleString('es-CL')}`;
const FONT = "system-ui, -apple-system, sans-serif";

export default function Tienda({ slug }) {
  const [store,       setStore]       = useState(null);
  const [products,    setProducts]    = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [notFound,    setNotFound]    = useState(false);
  const [search,      setSearch]      = useState('');
  const [showSearch,  setShowSearch]  = useState(false);
  const [cart,        setCart]        = useState([]);
  const [cartOpen,    setCartOpen]    = useState(false);
  const [view,        setView]        = useState('catalog');
  const [form,        setForm]        = useState({ name: '', phone: '', address: '', city: '' });
  const [submitting,  setSubmitting]  = useState(false);
  const [orderResult, setOrderResult] = useState(null);
  const [formErrors,  setFormErrors]  = useState({});
  const [isMobile,    setIsMobile]    = useState(() => window.innerWidth < 640);
  const [isTablet,    setIsTablet]    = useState(() => window.innerWidth < 1024);

  // Responsive breakpoints
  useEffect(() => {
    const update = () => {
      setIsMobile(window.innerWidth < 640);
      setIsTablet(window.innerWidth < 1024);
    };
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  // Liberar overflow del CSS global del CRM
  useEffect(() => {
    const prev = { overflow: document.body.style.overflow, height: document.body.style.height, bg: document.body.style.background, color: document.body.style.color };
    document.body.style.overflow   = 'auto';
    document.body.style.height     = 'auto';
    document.body.style.background = '#ffffff';
    document.body.style.color      = '#111827';
    const root = document.getElementById('root');
    const prevRoot = root ? { height: root.style.height, display: root.style.display } : null;
    if (root) { root.style.height = 'auto'; root.style.display = 'block'; }
    return () => {
      document.body.style.overflow   = prev.overflow;
      document.body.style.height     = prev.height;
      document.body.style.background = prev.bg;
      document.body.style.color      = prev.color;
      if (root && prevRoot) { root.style.height = prevRoot.height; root.style.display = prevRoot.display; }
    };
  }, []);

  // Bloquear scroll del body cuando carrito está abierto
  useEffect(() => {
    document.body.style.overflow = cartOpen ? 'hidden' : 'auto';
  }, [cartOpen]);

  useEffect(() => {
    (async () => {
      try {
        const [s, p] = await Promise.all([apiFetch(`/store/${slug}/info`), apiFetch(`/store/${slug}/products`)]);
        setStore(s); setProducts(p.products || []);
      } catch { setNotFound(true); }
      finally { setLoading(false); }
    })();
  }, [slug]);

  const PRIMARY      = store?.color        || '#22c55e';
  const FREE_SHIP    = store?.freeShipping  ?? 10000;
  const ANNOUNCEMENT = store?.announcement  || `🚚 Delivery gratis en compras sobre ${fmt(FREE_SHIP)}`;
  const HERO_TITLE   = store?.heroTitle     || 'Productos frescos directo al hogar';
  const HERO_SUB     = store?.heroSubtitle  || 'Sin intermediarios. Animales criados en libertad, productos que llegan frescos a tu puerta.';
  const HERO_TAGS    = store?.heroTags      || ['🥚 Huevos libres', '🫒 Aceitunas', '🧀 Quesos', '🚚 Lun – Sáb'];
  const WA_PHONE     = store?.whatsappPhone || null;

  const cartCount = cart.reduce((s, i) => s + i.quantity, 0);
  const cartTotal = cart.reduce((s, i) => s + parseFloat(i.product.price) * i.quantity, 0);
  const filtered  = products.filter(p => !search || p.title.toLowerCase().includes(search.toLowerCase()));

  const addToCart  = useCallback((p) => setCart(prev => {
    const ex = prev.find(i => i.product.id === p.id);
    return ex ? prev.map(i => i.product.id === p.id ? { ...i, quantity: i.quantity + 1 } : i) : [...prev, { product: p, quantity: 1 }];
  }), []);
  const removeOne  = useCallback((id) => setCart(prev => {
    const ex = prev.find(i => i.product.id === id);
    if (!ex) return prev;
    return ex.quantity === 1 ? prev.filter(i => i.product.id !== id) : prev.map(i => i.product.id === id ? { ...i, quantity: i.quantity - 1 } : i);
  }), []);
  const removeItem = useCallback((id) => setCart(prev => prev.filter(i => i.product.id !== id)), []);
  const getQty     = (id) => cart.find(i => i.product.id === id)?.quantity || 0;

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
      const result = await apiPost(`/store/${slug}/orders`, { ...form, items: cart.map(i => ({ productId: i.product.id, quantity: i.quantity })) });
      setOrderResult(result); setCart([]); setView('success');
    } catch (err) { alert(err.message); }
    finally { setSubmitting(false); }
  };

  const storeName = store?.name || 'Tienda';
  const logoUrl   = store?.logo;

  // ── Loading ──────────────────────────────────────────────────────
  if (loading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT }}>
      <div style={{ textAlign: 'center', color: '#6b7280' }}>
        <div style={{ width: 36, height: 36, border: '3px solid #e5e7eb', borderTopColor: '#22c55e', borderRadius: '50%', margin: '0 auto 12px', animation: 'spin .8s linear infinite' }} />
        Cargando...
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    </div>
  );

  if (notFound) return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontFamily: FONT, gap: 12 }}>
      <div style={{ fontSize: 48 }}>🏪</div>
      <div style={{ fontSize: 20, fontWeight: 700 }}>Tienda no encontrada</div>
    </div>
  );

  // ── Éxito ────────────────────────────────────────────────────────
  if (view === 'success') return (
    <div style={{ minHeight: '100vh', backgroundColor: '#f9fafb', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: FONT }}>
      <div style={{ background: 'white', borderRadius: 16, padding: isMobile ? '32px 20px' : '40px 32px', maxWidth: 440, width: '100%', textAlign: 'center', boxShadow: '0 4px 24px rgba(0,0,0,0.08)' }}>
        <div style={{ width: 72, height: 72, borderRadius: '50%', backgroundColor: `${PRIMARY}20`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
          <CheckCircle size={40} color={PRIMARY} />
        </div>
        <h2 style={{ margin: '0 0 8px', fontSize: 22, fontWeight: 800 }}>¡Pedido recibido!</h2>
        <p style={{ margin: '0 0 20px', color: '#6b7280', fontSize: 14, lineHeight: 1.6 }}>
          Confirmación enviada por WhatsApp al <strong>{form.phone}</strong>.
        </p>
        <div style={{ background: '#f9fafb', borderRadius: 10, padding: 16, marginBottom: 24, textAlign: 'left', fontSize: 14, lineHeight: 2 }}>
          <div>📍 {form.address}, {form.city}</div>
          <div>💵 Total: {fmt(orderResult?.total)}</div>
          <div>💳 Pago contra entrega</div>
        </div>
        <button onClick={() => { setView('catalog'); setForm({ name: '', phone: '', address: '', city: '' }); }}
          style={{ padding: '12px 24px', borderRadius: 10, border: 'none', backgroundColor: PRIMARY, color: 'white', fontWeight: 700, cursor: 'pointer', fontSize: 15 }}>
          Seguir comprando
        </button>
      </div>
    </div>
  );

  // ── Render principal ─────────────────────────────────────────────
  return (
    <div style={{ minHeight: '100vh', backgroundColor: 'white', fontFamily: FONT, color: '#111827' }}>

      {/* Announcement bar */}
      <div style={{ backgroundColor: '#111827', color: 'white', textAlign: 'center', padding: '9px 16px', fontSize: isMobile ? 12 : 13, fontWeight: 500 }}>
        {ANNOUNCEMENT}
      </div>

      {/* Header */}
      <header style={{ backgroundColor: 'white', borderBottom: '1px solid #e5e7eb', position: 'sticky', top: 0, zIndex: 100, boxShadow: '0 1px 6px rgba(0,0,0,0.06)' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: isMobile ? '12px 16px' : '14px 24px', display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* Logo */}
          <a href="#" onClick={e => { e.preventDefault(); setView('catalog'); setCartOpen(false); setSearch(''); }} style={{ textDecoration: 'none', flexShrink: 0, marginRight: 4 }}>
            {logoUrl
              ? <img src={logoUrl} alt={storeName} style={{ height: isMobile ? 36 : 44, width: 'auto', objectFit: 'contain' }} />
              : <span style={{ fontSize: isMobile ? 17 : 20, fontWeight: 900, color: '#111827', letterSpacing: -0.5 }}>{storeName}</span>}
          </a>

          {/* Search bar — desktop */}
          {!isTablet && (
            <div style={{ flex: 1, maxWidth: 440, display: 'flex', alignItems: 'center', backgroundColor: '#f3f4f6', borderRadius: 10, padding: '8px 14px', gap: 8 }}>
              <Search size={15} color="#9ca3af" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar productos..."
                style={{ flex: 1, border: 'none', background: 'transparent', outline: 'none', fontSize: 14, color: '#111827' }} />
              {search && <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: 0, display: 'flex' }}><X size={14} /></button>}
            </div>
          )}

          <div style={{ flex: isTablet ? 1 : 0 }} />

          {/* Search icon — tablet/mobile */}
          {isTablet && (
            <button onClick={() => setShowSearch(s => !s)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#374151', padding: 6, display: 'flex', alignItems: 'center' }}>
              <Search size={20} />
            </button>
          )}

          {/* Cart */}
          <button onClick={() => setCartOpen(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: isMobile ? '9px 14px' : '10px 18px', borderRadius: 10, backgroundColor: PRIMARY, border: 'none', color: 'white', fontWeight: 700, cursor: 'pointer', fontSize: 14, flexShrink: 0 }}>
            <ShoppingCart size={18} />
            {!isMobile && 'Carrito'}
            {cartCount > 0 && (
              <span style={{ backgroundColor: 'white', color: PRIMARY, borderRadius: 10, padding: '1px 6px', fontSize: 11, fontWeight: 800 }}>{cartCount}</span>
            )}
          </button>
        </div>

        {/* Search bar expandible — tablet/mobile */}
        {isTablet && showSearch && (
          <div style={{ padding: '0 16px 12px', borderTop: '1px solid #f3f4f6' }}>
            <div style={{ display: 'flex', alignItems: 'center', backgroundColor: '#f3f4f6', borderRadius: 10, padding: '9px 14px', gap: 8 }}>
              <Search size={15} color="#9ca3af" />
              <input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar productos..."
                style={{ flex: 1, border: 'none', background: 'transparent', outline: 'none', fontSize: 14, color: '#111827' }} />
              {search && <button onClick={() => { setSearch(''); setShowSearch(false); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', display: 'flex', padding: 0 }}><X size={14} /></button>}
            </div>
          </div>
        )}
      </header>

      {/* Delivery progress bar (cuando hay items en carrito) */}
      {cartTotal > 0 && (
        <div style={{ backgroundColor: cartTotal >= FREE_SHIP ? '#f0fdf4' : '#fefce8', borderBottom: `1px solid ${cartTotal >= FREE_SHIP ? '#bbf7d0' : '#fef08a'}`, padding: '8px 16px', textAlign: 'center' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: cartTotal >= FREE_SHIP ? '#166534' : '#854d0e', marginBottom: 5 }}>
            {cartTotal >= FREE_SHIP ? '✅ ¡Delivery gratis incluido!' : `Agrega ${fmt(FREE_SHIP - cartTotal)} más para delivery gratis`}
          </div>
          <div style={{ maxWidth: 300, margin: '0 auto', height: 5, backgroundColor: '#e5e7eb', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.min(100, (cartTotal / FREE_SHIP) * 100)}%`, backgroundColor: PRIMARY, borderRadius: 3, transition: 'width .3s' }} />
          </div>
        </div>
      )}

      {/* ── CATÁLOGO ──────────────────────────────────────────────── */}
      {view === 'catalog' && (
        <>
          {/* Hero */}
          <section style={{ background: 'linear-gradient(135deg,#f0fdf4 0%,#ecfdf5 60%,#f9fafb 100%)', padding: isMobile ? '36px 16px 40px' : '56px 24px' }}>
            <div style={{ maxWidth: 1200, margin: '0 auto' }}>
              {/* Badge */}
              <div style={{ display: 'inline-block', backgroundColor: `${PRIMARY}20`, color: PRIMARY, fontSize: 11, fontWeight: 700, padding: '4px 12px', borderRadius: 20, marginBottom: 14, letterSpacing: 0.5, textTransform: 'uppercase' }}>
                Del campo a tu mesa
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 40, flexWrap: 'wrap' }}>
                {/* Copy */}
                <div style={{ flex: 1, minWidth: 260 }}>
                  <h1 style={{ margin: '0 0 14px', fontSize: isMobile ? 30 : 'clamp(28px,4vw,46px)', fontWeight: 900, lineHeight: 1.12, letterSpacing: -1 }}>
                    <span style={{ color: PRIMARY }}>{HERO_TITLE}</span>
                  </h1>
                  <p style={{ margin: '0 0 20px', fontSize: isMobile ? 14 : 16, color: '#6b7280', lineHeight: 1.7, maxWidth: 420 }}>
                    {HERO_SUB}
                  </p>
                  {/* Tags */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 22 }}>
                    {HERO_TAGS.map(t => (
                      <span key={t} style={{ backgroundColor: 'white', border: '1px solid #e5e7eb', borderRadius: 20, padding: '4px 12px', fontSize: isMobile ? 12 : 13, fontWeight: 500, color: '#374151' }}>{t}</span>
                    ))}
                  </div>
                  <button onClick={() => document.getElementById('catalogo')?.scrollIntoView({ behavior: 'smooth' })}
                    style={{ padding: isMobile ? '12px 22px' : '14px 28px', borderRadius: 12, border: 'none', backgroundColor: PRIMARY, color: 'white', fontWeight: 800, fontSize: isMobile ? 14 : 16, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    Ver productos <ChevronRight size={16} />
                  </button>
                  {/* Social proof */}
                  <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 18 }}>⭐⭐⭐⭐⭐</span>
                    <span style={{ fontSize: 13, color: '#6b7280' }}>+500 caseritos felices</span>
                  </div>
                </div>

                {/* Stats — en móvil van horizontales debajo del copy */}
                <div style={{ display: 'flex', gap: isMobile ? 10 : 16, flexWrap: 'wrap', justifyContent: isMobile ? 'flex-start' : 'center', width: isMobile ? '100%' : 'auto' }}>
                  {[{ num: '100%', label: 'Campo libre', icon: '🌿' }, { num: '0', label: 'Intermediarios', icon: '🤝' }, { num: '52', label: 'Sem. al año', icon: '📅' }].map(s => (
                    <div key={s.label} style={{ background: 'white', borderRadius: 12, padding: isMobile ? '14px 16px' : '20px 22px', textAlign: 'center', boxShadow: '0 2px 10px rgba(0,0,0,0.06)', border: '1px solid #e5e7eb', minWidth: isMobile ? 88 : 100, flex: isMobile ? 1 : 'none' }}>
                      <div style={{ fontSize: isMobile ? 22 : 26 }}>{s.icon}</div>
                      <div style={{ fontSize: isMobile ? 20 : 24, fontWeight: 900, color: PRIMARY, lineHeight: 1.2, marginTop: 6 }}>{s.num}</div>
                      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 3, fontWeight: 500 }}>{s.label}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          {/* Catálogo */}
          <section id="catalogo" style={{ maxWidth: 1200, margin: '0 auto', padding: isMobile ? '32px 16px' : '48px 24px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 8 }}>
              <h2 style={{ margin: 0, fontSize: isMobile ? 22 : 26, fontWeight: 800 }}>
                {search ? `"${search}"` : 'Todos los productos'}
              </h2>
              <span style={{ fontSize: 13, color: '#9ca3af' }}>{filtered.length} producto{filtered.length !== 1 ? 's' : ''}</span>
            </div>

            {filtered.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px 0', color: '#9ca3af' }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>🔍</div>
                <p>No encontramos "{search}"</p>
                <button onClick={() => setSearch('')} style={{ marginTop: 12, padding: '8px 18px', borderRadius: 8, border: `1px solid ${PRIMARY}`, background: 'white', color: PRIMARY, cursor: 'pointer', fontWeight: 600 }}>Ver todos</button>
              </div>
            ) : (
              <div style={{
                display: 'grid',
                gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : isTablet ? 'repeat(3, 1fr)' : 'repeat(auto-fill, minmax(220px,1fr))',
                gap: isMobile ? 12 : 18,
              }}>
                {filtered.map(product => {
                  const qty        = getQty(product.id);
                  const hasDiscount = product.compare_price && parseFloat(product.compare_price) > parseFloat(product.price);
                  const outOfStock  = product.stock === 0;
                  return (
                    <div key={product.id}
                      style={{ background: 'white', borderRadius: isMobile ? 10 : 14, overflow: 'hidden',
                        border: '1px solid #e5e7eb', opacity: outOfStock ? 0.65 : 1,
                        boxShadow: '0 1px 4px rgba(0,0,0,0.04)', display: 'flex', flexDirection: 'column' }}>

                      {/* Image */}
                      <div style={{ position: 'relative', height: isMobile ? 140 : 200, backgroundColor: '#f9fafb', overflow: 'hidden', flexShrink: 0 }}>
                        {product.image_url
                          ? <img src={product.image_url} alt={product.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          : <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 40 }}>🥚</div>}
                        {outOfStock && <div style={{ position: 'absolute', top: 8, left: 8, background: '#111827', color: 'white', fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 20 }}>Agotado</div>}
                        {hasDiscount && !outOfStock && (
                          <div style={{ position: 'absolute', top: 8, left: 8, background: '#ef4444', color: 'white', fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 20 }}>
                            -{Math.round((1 - product.price / product.compare_price) * 100)}%
                          </div>
                        )}
                      </div>

                      {/* Info */}
                      <div style={{ padding: isMobile ? '10px 12px 12px' : '14px 16px 16px', display: 'flex', flexDirection: 'column', flex: 1 }}>
                        <div style={{ fontWeight: 700, fontSize: isMobile ? 13 : 14, color: '#111827', lineHeight: 1.35, marginBottom: 4,
                          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                          {product.title}
                        </div>
                        {!isMobile && product.description && (
                          <div style={{ fontSize: 12, color: '#9ca3af', lineHeight: 1.5, marginBottom: 8,
                            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                            {product.description}
                          </div>
                        )}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: isMobile ? 10 : 12, marginTop: 'auto' }}>
                          <span style={{ fontSize: isMobile ? 15 : 17, fontWeight: 800 }}>{fmt(product.price)}</span>
                          {hasDiscount && <span style={{ fontSize: 11, color: '#9ca3af', textDecoration: 'line-through' }}>{fmt(product.compare_price)}</span>}
                        </div>
                        {outOfStock ? (
                          <div style={{ textAlign: 'center', padding: '8px', borderRadius: 8, backgroundColor: '#f3f4f6', color: '#9ca3af', fontSize: 12, fontWeight: 600 }}>Sin stock</div>
                        ) : qty === 0 ? (
                          <button onClick={() => addToCart(product)}
                            style={{ width: '100%', padding: isMobile ? '9px 0' : '10px', borderRadius: 9, border: 'none', backgroundColor: PRIMARY, color: 'white', fontWeight: 700, cursor: 'pointer', fontSize: isMobile ? 13 : 14 }}>
                            Añadir
                          </button>
                        ) : (
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#f9fafb', borderRadius: 9, padding: '3px 5px', border: `1.5px solid ${PRIMARY}` }}>
                            <button onClick={() => removeOne(product.id)} style={{ width: 32, height: 32, borderRadius: 7, border: 'none', background: 'white', cursor: 'pointer', fontWeight: 700, fontSize: 18, color: '#374151', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>−</button>
                            <span style={{ fontWeight: 800, fontSize: 15, minWidth: 20, textAlign: 'center' }}>{qty}</span>
                            <button onClick={() => addToCart(product)} style={{ width: 32, height: 32, borderRadius: 7, border: 'none', background: PRIMARY, color: 'white', cursor: 'pointer', fontWeight: 700, fontSize: 18, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>+</button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Cómo funciona */}
          <section style={{ backgroundColor: '#f9fafb', borderTop: '1px solid #e5e7eb', padding: isMobile ? '40px 16px' : '56px 24px' }}>
            <div style={{ maxWidth: 1200, margin: '0 auto', textAlign: 'center' }}>
              <p style={{ margin: '0 0 6px', fontSize: 11, fontWeight: 700, color: PRIMARY, textTransform: 'uppercase', letterSpacing: 1 }}>Cómo funciona</p>
              <h2 style={{ margin: '0 0 32px', fontSize: isMobile ? 22 : 26, fontWeight: 800 }}>Del campo a tu puerta</h2>
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: isMobile ? 12 : 20 }}>
                {[
                  { n: '1', icon: '🛒', t: 'Elige', d: 'Arma tu pedido.' },
                  { n: '2', icon: '📅', t: 'Pide', d: 'Lun a sáb hasta las 11 AM.' },
                  { n: '3', icon: '🌿', t: 'Preparamos', d: 'Directo del campo.' },
                  { n: '4', icon: '🚚', t: 'Llega', d: FREE_SHIP > 0 ? `Gratis sobre ${fmt(FREE_SHIP)}.` : 'A coordinar.' },
                ].map(s => (
                  <div key={s.n} style={{ background: 'white', borderRadius: 12, padding: isMobile ? '18px 12px' : '24px 16px', border: '1px solid #e5e7eb' }}>
                    <div style={{ width: 36, height: 36, borderRadius: '50%', background: `${PRIMARY}20`, color: PRIMARY, fontWeight: 800, fontSize: 15, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 10px' }}>{s.n}</div>
                    <div style={{ fontSize: 28, marginBottom: 8 }}>{s.icon}</div>
                    <div style={{ fontWeight: 700, fontSize: isMobile ? 13 : 14, marginBottom: 4 }}>{s.t}</div>
                    <div style={{ fontSize: isMobile ? 11 : 12, color: '#6b7280', lineHeight: 1.5 }}>{s.d}</div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* Footer */}
          <footer style={{ background: '#111827', color: '#9ca3af', padding: isMobile ? '28px 16px' : '32px 24px', textAlign: 'center' }}>
            <div style={{ maxWidth: 1200, margin: '0 auto' }}>
              {logoUrl
                ? <img src={logoUrl} alt={storeName} style={{ height: isMobile ? 32 : 40, filter: 'brightness(0) invert(1)', marginBottom: 10, opacity: 0.8 }} />
                : <div style={{ fontSize: isMobile ? 16 : 18, fontWeight: 800, color: 'white', marginBottom: 10 }}>{storeName}</div>}
              <p style={{ margin: '0 0 10px', fontSize: 13 }}>Productos frescos del campo a tu mesa</p>
              <p style={{ margin: 0, fontSize: 12 }}>© {new Date().getFullYear()} {storeName}</p>
            </div>
          </footer>
        </>
      )}

      {/* ── CHECKOUT ──────────────────────────────────────────────── */}
      {view === 'checkout' && (
        <div style={{ maxWidth: 680, margin: '0 auto', padding: isMobile ? '24px 16px' : '40px 24px' }}>
          <button onClick={() => setView('catalog')}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', fontSize: 14, marginBottom: 20, display: 'flex', alignItems: 'center', gap: 6, padding: 0 }}>
            ← Volver
          </button>
          <h2 style={{ margin: '0 0 24px', fontSize: isMobile ? 20 : 24, fontWeight: 800 }}>Finalizar pedido</h2>

          {/* Resumen */}
          <div style={{ background: '#f9fafb', borderRadius: 14, padding: isMobile ? 16 : 20, border: '1px solid #e5e7eb', marginBottom: 16 }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 14 }}>Resumen</div>
            {cart.map(({ product, quantity }) => (
              <div key={product.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #e5e7eb', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {product.image_url && <img src={product.image_url} alt="" style={{ width: 40, height: 40, borderRadius: 8, objectFit: 'cover', border: '1px solid #e5e7eb' }} />}
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3 }}>{product.title}</div>
                    <div style={{ fontSize: 12, color: '#6b7280' }}>× {quantity}</div>
                  </div>
                </div>
                <div style={{ fontWeight: 700, fontSize: 14, flexShrink: 0 }}>{fmt(parseFloat(product.price) * quantity)}</div>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 12, fontWeight: 800, fontSize: 16 }}>
              <span>Total</span><span>{fmt(cartTotal)}</span>
            </div>
            <div style={{ fontSize: 12, color: cartTotal >= FREE_SHIP ? '#16a34a' : '#6b7280', marginTop: 4 }}>
              {cartTotal >= FREE_SHIP ? '✅ Delivery gratis' : '💳 Pago contra entrega'}
            </div>
          </div>

          {/* Formulario */}
          <div style={{ background: 'white', borderRadius: 14, padding: isMobile ? 16 : 24, border: '1px solid #e5e7eb' }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 18 }}>Datos de entrega</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {[
                { label: 'Nombre completo', key: 'name', placeholder: 'Juan Pérez', type: 'text' },
                { label: 'WhatsApp', key: 'phone', placeholder: '56912345678', type: 'tel' },
                { label: 'Dirección', key: 'address', placeholder: 'Calle 123, depto 4', type: 'text' },
                { label: 'Ciudad', key: 'city', placeholder: 'La Serena', type: 'text' },
              ].map(({ label, key, placeholder, type }) => (
                <div key={key}>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 5 }}>{label} *</label>
                  <input type={type} value={form[key]} placeholder={placeholder}
                    onChange={e => { setForm(f => ({ ...f, [key]: e.target.value })); setFormErrors(f => ({ ...f, [key]: null })); }}
                    style={{ width: '100%', padding: '11px 14px', borderRadius: 10, border: `1.5px solid ${formErrors[key] ? '#ef4444' : '#e5e7eb'}`, fontSize: 14, boxSizing: 'border-box', outline: 'none' }}
                    onFocus={e => e.target.style.borderColor = PRIMARY}
                    onBlur={e => e.target.style.borderColor = formErrors[key] ? '#ef4444' : '#e5e7eb'} />
                  {formErrors[key] && <div style={{ fontSize: 12, color: '#ef4444', marginTop: 3 }}>{formErrors[key]}</div>}
                </div>
              ))}
            </div>
            <button onClick={handleSubmit} disabled={submitting}
              style={{ marginTop: 20, width: '100%', padding: 14, borderRadius: 12, border: 'none', backgroundColor: submitting ? '#9ca3af' : PRIMARY, color: 'white', fontWeight: 800, fontSize: 16, cursor: submitting ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              {submitting ? 'Enviando...' : `Confirmar · ${fmt(cartTotal)}`}
              {!submitting && <ChevronRight size={18} />}
            </button>
            <p style={{ textAlign: 'center', fontSize: 12, color: '#9ca3af', marginTop: 12 }}>
              Recibirás confirmación por WhatsApp 📱
            </p>
          </div>
        </div>
      )}

      {/* ── CARRITO LATERAL ───────────────────────────────────────── */}
      {cartOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 200 }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(2px)' }} onClick={() => setCartOpen(false)} />
          <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: isMobile ? '92vw' : '100%', maxWidth: 400, background: 'white', boxShadow: '-6px 0 32px rgba(0,0,0,0.12)', display: 'flex', flexDirection: 'column' }}>
            {/* Header */}
            <div style={{ padding: '18px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 17 }}>Tu carrito</div>
                <div style={{ fontSize: 12, color: '#6b7280' }}>{cartCount} producto{cartCount !== 1 ? 's' : ''}</div>
              </div>
              <button onClick={() => setCartOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: 4, display: 'flex' }}><X size={22} /></button>
            </div>

            {/* Progreso envío */}
            {cartTotal > 0 && (
              <div style={{ padding: '10px 20px', background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: cartTotal >= FREE_SHIP ? '#16a34a' : '#374151', marginBottom: 5 }}>
                  {cartTotal >= FREE_SHIP ? '✅ ¡Delivery gratis!' : `Faltan ${fmt(FREE_SHIP - cartTotal)} para envío gratis`}
                </div>
                <div style={{ height: 5, background: '#e5e7eb', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${Math.min(100, (cartTotal / FREE_SHIP) * 100)}%`, background: PRIMARY, borderRadius: 3, transition: 'width .3s' }} />
                </div>
              </div>
            )}

            {/* Items */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '14px 20px' }}>
              {cart.length === 0 ? (
                <div style={{ textAlign: 'center', color: '#9ca3af', padding: '50px 0' }}>
                  <ShoppingCart size={44} style={{ marginBottom: 14, opacity: 0.2 }} />
                  <p style={{ margin: 0, fontSize: 15 }}>Carrito vacío</p>
                  <button onClick={() => setCartOpen(false)} style={{ marginTop: 14, padding: '8px 18px', borderRadius: 8, border: `1px solid ${PRIMARY}`, background: 'white', color: PRIMARY, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>Ver productos</button>
                </div>
              ) : cart.map(({ product, quantity }) => (
                <div key={product.id} style={{ display: 'flex', gap: 12, padding: '12px 0', borderBottom: '1px solid #f3f4f6' }}>
                  {product.image_url
                    ? <img src={product.image_url} alt="" style={{ width: 60, height: 60, borderRadius: 10, objectFit: 'cover', border: '1px solid #e5e7eb', flexShrink: 0 }} />
                    : <div style={{ width: 60, height: 60, borderRadius: 10, background: '#f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, flexShrink: 0 }}>🥚</div>}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, lineHeight: 1.3, marginBottom: 3,
                      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{product.title}</div>
                    <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>{fmt(product.price)} c/u</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <button onClick={() => removeOne(product.id)} style={{ width: 28, height: 28, borderRadius: 6, border: '1px solid #e5e7eb', background: 'white', cursor: 'pointer', fontWeight: 700, fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>−</button>
                      <span style={{ fontWeight: 700, fontSize: 14, minWidth: 18, textAlign: 'center' }}>{quantity}</span>
                      <button onClick={() => addToCart(product)} style={{ width: 28, height: 28, borderRadius: 6, border: 'none', background: PRIMARY, color: 'white', cursor: 'pointer', fontWeight: 700, fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>+</button>
                      <button onClick={() => removeItem(product.id)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#d1d5db', display: 'flex', padding: 2 }}><X size={13} /></button>
                    </div>
                  </div>
                  <div style={{ fontWeight: 700, fontSize: 14, flexShrink: 0 }}>{fmt(parseFloat(product.price) * quantity)}</div>
                </div>
              ))}
            </div>

            {/* Footer carrito */}
            {cart.length > 0 && (
              <div style={{ padding: '16px 20px', borderTop: '1px solid #e5e7eb' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, fontSize: 14, color: '#6b7280' }}>
                  <span>Subtotal</span><span style={{ fontWeight: 600, color: '#111827' }}>{fmt(cartTotal)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16, fontSize: 13, color: '#6b7280' }}>
                  <span>Envío</span><span style={{ fontWeight: 600, color: cartTotal >= FREE_SHIP ? '#16a34a' : '#111827' }}>{cartTotal >= FREE_SHIP ? 'Gratis' : 'Al confirmar'}</span>
                </div>
                <button onClick={() => { setCartOpen(false); setView('checkout'); }}
                  style={{ width: '100%', padding: 14, borderRadius: 12, border: 'none', background: PRIMARY, color: 'white', fontWeight: 800, fontSize: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  Ir al checkout <ChevronRight size={18} />
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* WhatsApp flotante */}
      {WA_PHONE && <a href={`https://wa.me/${WA_PHONE.replace(/\D/g, '')}`} target="_blank" rel="noreferrer"
        style={{ position: 'fixed', bottom: isMobile ? 20 : 24, right: isMobile ? 16 : 24,
          width: isMobile ? 50 : 56, height: isMobile ? 50 : 56, borderRadius: '50%',
          backgroundColor: '#25d366', display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 4px 20px rgba(37,211,102,0.45)', zIndex: 150, textDecoration: 'none' }}>
        <MessageCircle size={isMobile ? 24 : 28} color="white" fill="white" />
      </a>}

    </div>
  );
}
