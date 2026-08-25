/**
 * Tienda.jsx — Tienda pública COD (sin login)
 *
 * Accesible en /tienda/:slug sin autenticación.
 * Muestra catálogo, carrito lateral y checkout.
 */
import { useState, useEffect, useCallback } from 'react';
import { ShoppingCart, Plus, Minus, X, ChevronRight, CheckCircle, Package } from 'lucide-react';

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

export default function Tienda({ slug }) {
  const [store, setStore]       = useState(null);
  const [products, setProducts] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [cart, setCart]         = useState([]); // [{product, quantity}]
  const [cartOpen, setCartOpen] = useState(false);
  const [view, setView]         = useState('catalog'); // 'catalog' | 'checkout' | 'success'
  const [form, setForm]         = useState({ name: '', phone: '', address: '', city: '' });
  const [submitting, setSubmitting] = useState(false);
  const [orderResult, setOrderResult] = useState(null);
  const [formErrors, setFormErrors]   = useState({});

  useEffect(() => {
    (async () => {
      try {
        const [storeData, prodData] = await Promise.all([
          apiFetch(`/store/${slug}/info`),
          apiFetch(`/store/${slug}/products`),
        ]);
        setStore(storeData);
        setProducts(prodData.products || []);
      } catch {
        setNotFound(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [slug]);

  const primary = store?.color || '#22c55e';

  const cartTotal  = cart.reduce((s, i) => s + parseFloat(i.product.price) * i.quantity, 0);
  const cartCount  = cart.reduce((s, i) => s + i.quantity, 0);

  const addToCart = useCallback((product) => {
    setCart(prev => {
      const existing = prev.find(i => i.product.id === product.id);
      if (existing) return prev.map(i => i.product.id === product.id ? { ...i, quantity: i.quantity + 1 } : i);
      return [...prev, { product, quantity: 1 }];
    });
  }, []);

  const removeOne = useCallback((productId) => {
    setCart(prev => {
      const existing = prev.find(i => i.product.id === productId);
      if (!existing) return prev;
      if (existing.quantity === 1) return prev.filter(i => i.product.id !== productId);
      return prev.map(i => i.product.id === productId ? { ...i, quantity: i.quantity - 1 } : i);
    });
  }, []);

  const removeFromCart = useCallback((productId) => {
    setCart(prev => prev.filter(i => i.product.id !== productId));
  }, []);

  const getQty = (productId) => cart.find(i => i.product.id === productId)?.quantity || 0;

  const validate = () => {
    const errors = {};
    if (!form.name.trim())    errors.name    = 'Requerido';
    if (!form.phone.trim())   errors.phone   = 'Requerido';
    if (!form.address.trim()) errors.address = 'Requerido';
    if (!form.city.trim())    errors.city    = 'Requerido';
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    setSubmitting(true);
    try {
      const items = cart.map(i => ({ productId: i.product.id, quantity: i.quantity }));
      const result = await apiPost(`/store/${slug}/orders`, { ...form, items });
      setOrderResult(result);
      setCart([]);
      setView('success');
    } catch (err) {
      alert(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  // ── Estados de carga ──────────────────────────────────────────────
  if (loading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#f9fafb' }}>
      <div style={{ fontSize: '16px', color: '#6b7280' }}>Cargando tienda...</div>
    </div>
  );

  if (notFound) return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', backgroundColor: '#f9fafb', gap: '16px' }}>
      <Package size={48} style={{ opacity: 0.3 }} />
      <div style={{ fontSize: '18px', fontWeight: 700, color: '#111827' }}>Tienda no encontrada</div>
      <div style={{ fontSize: '14px', color: '#6b7280' }}>Verifica el enlace e intenta nuevamente.</div>
    </div>
  );

  // ── Página de éxito ───────────────────────────────────────────────
  if (view === 'success') return (
    <div style={{ minHeight: '100vh', backgroundColor: '#f9fafb', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
      <div style={{ backgroundColor: 'white', borderRadius: '16px', padding: '40px', maxWidth: '420px', width: '100%', textAlign: 'center', boxShadow: '0 4px 24px rgba(0,0,0,0.08)' }}>
        <CheckCircle size={56} color={primary} style={{ marginBottom: '16px' }} />
        <h2 style={{ margin: '0 0 8px', fontSize: '22px', fontWeight: 700, color: '#111827' }}>¡Pedido recibido!</h2>
        <p style={{ margin: '0 0 16px', color: '#6b7280', fontSize: '15px' }}>
          Te enviamos la confirmación por WhatsApp al número {form.phone}.
        </p>
        <div style={{ backgroundColor: '#f3f4f6', borderRadius: '10px', padding: '16px', marginBottom: '24px', textAlign: 'left', fontSize: '14px', color: '#374151' }}>
          <div><b>Entrega:</b> {form.address}, {form.city}</div>
          <div><b>Total:</b> ${orderResult?.total?.toLocaleString('es-CL')}</div>
          <div><b>Pago:</b> Contra entrega</div>
        </div>
        <button onClick={() => { setView('catalog'); setForm({ name: '', phone: '', address: '', city: '' }); }}
          style={{ padding: '12px 28px', borderRadius: '10px', border: 'none', backgroundColor: primary, color: 'white', fontWeight: 700, cursor: 'pointer', fontSize: '15px' }}>
          Seguir comprando
        </button>
      </div>
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#f9fafb', fontFamily: 'system-ui, -apple-system, sans-serif' }}>

      {/* Header */}
      <header style={{ backgroundColor: 'white', borderBottom: '1px solid #e5e7eb', position: 'sticky', top: 0, zIndex: 100 }}>
        <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontWeight: 800, fontSize: '20px', color: '#111827' }}>{store?.name}</div>
          <button onClick={() => setCartOpen(true)}
            style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 18px', borderRadius: '10px',
              backgroundColor: primary, border: 'none', color: 'white', fontWeight: 700, cursor: 'pointer', fontSize: '14px', position: 'relative' }}>
            <ShoppingCart size={18} />
            Carrito
            {cartCount > 0 && (
              <span style={{ backgroundColor: 'white', color: primary, borderRadius: '10px', padding: '1px 7px',
                fontSize: '12px', fontWeight: 800, marginLeft: '2px' }}>
                {cartCount}
              </span>
            )}
          </button>
        </div>
      </header>

      {/* Catálogo */}
      {view === 'catalog' && (
        <main style={{ maxWidth: '1100px', margin: '0 auto', padding: '32px 20px' }}>
          {products.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '80px 0', color: '#9ca3af' }}>
              <Package size={48} style={{ marginBottom: '12px', opacity: 0.3 }} />
              <p>La tienda no tiene productos disponibles aún.</p>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '20px' }}>
              {products.map(product => {
                const qty = getQty(product.id);
                const hasDiscount = product.compare_price && parseFloat(product.compare_price) > parseFloat(product.price);
                return (
                  <div key={product.id} style={{ backgroundColor: 'white', borderRadius: '14px', overflow: 'hidden', boxShadow: '0 2px 8px rgba(0,0,0,0.06)', border: '1px solid #e5e7eb' }}>
                    {product.image_url ? (
                      <div style={{ height: '200px', overflow: 'hidden', backgroundColor: '#f3f4f6' }}>
                        <img src={product.image_url} alt={product.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      </div>
                    ) : (
                      <div style={{ height: '120px', backgroundColor: '#f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <Package size={36} style={{ opacity: 0.2 }} />
                      </div>
                    )}
                    <div style={{ padding: '14px' }}>
                      <div style={{ fontWeight: 700, fontSize: '15px', color: '#111827', marginBottom: '4px' }}>{product.title}</div>
                      {product.description && (
                        <div style={{ fontSize: '13px', color: '#6b7280', marginBottom: '8px',
                          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                          {product.description}
                        </div>
                      )}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                        <span style={{ fontSize: '17px', fontWeight: 800, color: '#111827' }}>
                          ${Number(product.price).toLocaleString('es-CL')}
                        </span>
                        {hasDiscount && (
                          <span style={{ fontSize: '13px', color: '#9ca3af', textDecoration: 'line-through' }}>
                            ${Number(product.compare_price).toLocaleString('es-CL')}
                          </span>
                        )}
                        {hasDiscount && (
                          <span style={{ backgroundColor: '#fee2e2', color: '#dc2626', fontSize: '11px', fontWeight: 700, padding: '2px 6px', borderRadius: '6px' }}>
                            -{Math.round((1 - product.price / product.compare_price) * 100)}%
                          </span>
                        )}
                      </div>
                      {/* Contador */}
                      {qty === 0 ? (
                        <button onClick={() => addToCart(product)}
                          style={{ width: '100%', padding: '10px', borderRadius: '9px', border: 'none',
                            backgroundColor: primary, color: 'white', fontWeight: 700, cursor: 'pointer', fontSize: '14px' }}>
                          Agregar al carrito
                        </button>
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#f3f4f6', borderRadius: '9px', padding: '4px' }}>
                          <button onClick={() => removeOne(product.id)}
                            style={{ width: '36px', height: '36px', borderRadius: '7px', border: 'none', backgroundColor: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
                            <Minus size={16} />
                          </button>
                          <span style={{ fontWeight: 700, fontSize: '15px', color: '#111827' }}>{qty}</span>
                          <button onClick={() => addToCart(product)}
                            style={{ width: '36px', height: '36px', borderRadius: '7px', border: 'none', backgroundColor: primary, color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <Plus size={16} />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </main>
      )}

      {/* Checkout */}
      {view === 'checkout' && (
        <main style={{ maxWidth: '600px', margin: '0 auto', padding: '32px 20px' }}>
          <button onClick={() => setView('catalog')}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', fontSize: '14px', marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '4px' }}>
            ← Volver al catálogo
          </button>
          <h2 style={{ margin: '0 0 24px', fontSize: '22px', fontWeight: 700, color: '#111827' }}>Finalizar pedido</h2>

          {/* Resumen */}
          <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '16px', marginBottom: '20px', border: '1px solid #e5e7eb' }}>
            {cart.map(({ product, quantity }) => (
              <div key={product.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f3f4f6', fontSize: '14px', color: '#374151' }}>
                <span>{product.title} × {quantity}</span>
                <span style={{ fontWeight: 600 }}>${(parseFloat(product.price) * quantity).toLocaleString('es-CL')}</span>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: '10px', fontWeight: 800, fontSize: '16px', color: '#111827' }}>
              <span>Total</span>
              <span>${cartTotal.toLocaleString('es-CL')}</span>
            </div>
            <div style={{ fontSize: '12px', color: '#6b7280', marginTop: '6px' }}>💳 Pago contra entrega</div>
          </div>

          {/* Formulario */}
          <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '20px', border: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {[
              { label: 'Nombre completo *', key: 'name', placeholder: 'Juan Pérez' },
              { label: 'WhatsApp *', key: 'phone', placeholder: '56912345678', type: 'tel' },
              { label: 'Dirección de entrega *', key: 'address', placeholder: 'Calle 123, depto 4' },
              { label: 'Ciudad *', key: 'city', placeholder: 'Santiago' },
            ].map(({ label, key, placeholder, type }) => (
              <div key={key}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#374151', marginBottom: '5px' }}>{label}</label>
                <input type={type || 'text'} value={form[key]} placeholder={placeholder}
                  onChange={e => { setForm(f => ({ ...f, [key]: e.target.value })); setFormErrors(e => ({ ...e, [key]: null })); }}
                  style={{ width: '100%', padding: '10px 12px', borderRadius: '9px', border: `1px solid ${formErrors[key] ? '#ef4444' : '#d1d5db'}`,
                    fontSize: '14px', boxSizing: 'border-box', outline: 'none', color: '#111827' }} />
                {formErrors[key] && <div style={{ fontSize: '12px', color: '#ef4444', marginTop: '3px' }}>{formErrors[key]}</div>}
              </div>
            ))}

            <button onClick={handleSubmit} disabled={submitting || cart.length === 0}
              style={{ padding: '14px', borderRadius: '10px', border: 'none', backgroundColor: primary,
                color: 'white', fontWeight: 800, fontSize: '16px', cursor: submitting ? 'not-allowed' : 'pointer',
                opacity: submitting ? 0.7 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
              {submitting ? 'Enviando pedido...' : `Confirmar pedido — $${cartTotal.toLocaleString('es-CL')}`}
              {!submitting && <ChevronRight size={18} />}
            </button>
          </div>
        </main>
      )}

      {/* Panel carrito */}
      {cartOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 200 }}>
          <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)' }} onClick={() => setCartOpen(false)} />
          <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: '100%', maxWidth: '380px',
            backgroundColor: 'white', boxShadow: '-4px 0 24px rgba(0,0,0,0.12)', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '18px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontWeight: 700, fontSize: '17px', color: '#111827' }}>Carrito ({cartCount})</span>
              <button onClick={() => setCartOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}>
                <X size={20} />
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
              {cart.length === 0 ? (
                <div style={{ textAlign: 'center', color: '#9ca3af', padding: '40px 0' }}>
                  <ShoppingCart size={36} style={{ marginBottom: '12px', opacity: 0.3 }} />
                  <p>Tu carrito está vacío</p>
                </div>
              ) : cart.map(({ product, quantity }) => (
                <div key={product.id} style={{ display: 'flex', gap: '12px', padding: '12px 0', borderBottom: '1px solid #f3f4f6' }}>
                  {product.image_url && (
                    <img src={product.image_url} alt={product.title} style={{ width: '56px', height: '56px', objectFit: 'cover', borderRadius: '8px', flexShrink: 0 }} />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: '14px', color: '#111827' }}>{product.title}</div>
                    <div style={{ fontSize: '13px', color: '#6b7280' }}>${Number(product.price).toLocaleString('es-CL')} c/u</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
                      <button onClick={() => removeOne(product.id)} style={{ width: '28px', height: '28px', borderRadius: '6px', border: '1px solid #e5e7eb', backgroundColor: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Minus size={12} /></button>
                      <span style={{ fontWeight: 700, fontSize: '14px', minWidth: '20px', textAlign: 'center' }}>{quantity}</span>
                      <button onClick={() => addToCart(product)} style={{ width: '28px', height: '28px', borderRadius: '6px', border: 'none', backgroundColor: primary, color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Plus size={12} /></button>
                      <button onClick={() => removeFromCart(product.id)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={14} /></button>
                    </div>
                  </div>
                  <div style={{ fontWeight: 700, fontSize: '14px', color: '#111827', flexShrink: 0 }}>
                    ${(parseFloat(product.price) * quantity).toLocaleString('es-CL')}
                  </div>
                </div>
              ))}
            </div>
            {cart.length > 0 && (
              <div style={{ padding: '16px 20px', borderTop: '1px solid #e5e7eb' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800, fontSize: '17px', color: '#111827', marginBottom: '14px' }}>
                  <span>Total</span>
                  <span>${cartTotal.toLocaleString('es-CL')}</span>
                </div>
                <button onClick={() => { setCartOpen(false); setView('checkout'); }}
                  style={{ width: '100%', padding: '14px', borderRadius: '10px', border: 'none', backgroundColor: primary,
                    color: 'white', fontWeight: 800, fontSize: '15px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                  Ir al checkout <ChevronRight size={18} />
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
