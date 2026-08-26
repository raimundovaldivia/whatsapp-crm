/**
 * ProductsPanel — Gestión de productos propios del CRM
 *
 * Permite agregar, editar, eliminar y activar/desactivar productos.
 * Botón "Importar desde Shopify" para migración con un clic.
 */
import { useState, useEffect, useCallback } from 'react';
import { Plus, Edit2, Trash2, ToggleLeft, ToggleRight, Download, X, Package, ExternalLink, Copy, Check, Settings, Store, Phone, Sparkles, Save, Loader } from 'lucide-react';
import { useTheme } from '../theme.js';
import { api } from '../utils/api.js';

const EMPTY_FORM = { title: '', description: '', price: '', comparePrice: '', sku: '', stock: '-1', imageUrl: '', active: true, category: '', isBusiness: false, bulkPrice: '', bulkMinQty: '' };

/* ── Configuración de tienda ──────────────────────────────────────── */
function StoreConfigTab({ orgSlug, colors }) {
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);
  const [error,    setError]    = useState('');
  const [success,  setSuccess]  = useState('');
  const [form, setForm] = useState({
    store_name: '', store_logo: '', store_color: '#22c55e',
    store_announcement: '', store_hero_title: '', store_hero_subtitle: '',
    store_hero_tags: '', store_whatsapp_phone: '', store_free_shipping: '10000',
    admin_alert_phone: '', store_how_to_buy: '', store_about_us: '', store_public_url: '',
    payment_mode: 'cod',
  });

  useEffect(() => {
    api.get('/store-settings')
      .then(({ data }) => {
        const s = data.settings || {};
        let tagsStr = '';
        try { tagsStr = JSON.parse(s.store_hero_tags || '[]').join(', '); } catch { tagsStr = s.store_hero_tags || ''; }
        setForm({
          store_name: s.store_name || '', store_logo: s.store_logo || '',
          store_color: s.store_color || '#22c55e',
          store_announcement: s.store_announcement || '', store_hero_title: s.store_hero_title || '',
          store_hero_subtitle: s.store_hero_subtitle || '', store_hero_tags: tagsStr,
          store_whatsapp_phone: s.store_whatsapp_phone || '',
          store_free_shipping: s.store_free_shipping || '10000',
          admin_alert_phone: s.admin_alert_phone || '',
          store_how_to_buy: s.store_how_to_buy || '',
          store_about_us: s.store_about_us || '',
          store_public_url: s.store_public_url || '',
          payment_mode: s.payment_mode || 'cod',
        });
      })
      .catch(() => setError('Error cargando configuración'))
      .finally(() => setLoading(false));
  }, []);

  const set = (key) => (e) => setForm(f => ({ ...f, [key]: e.target.value }));

  const save = async () => {
    setSaving(true); setError(''); setSuccess('');
    try {
      const tagsArray = form.store_hero_tags.split(',').map(t => t.trim()).filter(Boolean);
      await api.put('/store-settings', {
        ...form,
        store_hero_tags: JSON.stringify(tagsArray),
        store_free_shipping: String(parseInt(form.store_free_shipping) || 0),
      });
      setSuccess('✅ Configuración guardada');
    } catch (err) {
      setError(err.response?.data?.error || 'Error guardando');
    } finally { setSaving(false); }
  };

  const inp = {
    width: '100%', backgroundColor: colors.bgApp, border: `1px solid ${colors.borderStrong}`,
    borderRadius: '8px', padding: '9px 13px', color: colors.textPrimary, fontSize: '14px',
    outline: 'none', boxSizing: 'border-box',
  };
  const lbl = { fontSize: '12px', color: colors.textSecondary, marginBottom: '5px', display: 'block', fontWeight: 500 };
  const hint = { fontSize: '11px', color: colors.textMuted, marginTop: '3px' };
  const section = {
    backgroundColor: colors.bgPanel, borderRadius: '12px',
    border: `1px solid ${colors.border}`, marginBottom: '14px',
  };
  const secHead = {
    padding: '12px 18px', borderBottom: `1px solid ${colors.border}`,
    display: 'flex', alignItems: 'center', gap: '8px',
    fontSize: '14px', fontWeight: 600, color: colors.textPrimary,
  };
  const secBody = { padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '12px' };

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '40px 24px', color: colors.textSecondary, fontSize: 13 }}>
      <Loader size={15} style={{ animation: 'spin 1s linear infinite' }} /> Cargando configuración...
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
      {error   && <div style={{ marginBottom: 12, padding: '10px 14px', borderRadius: 8, backgroundColor: '#2d1a1a', color: '#f87171', fontSize: 13 }}>{error}</div>}
      {success && <div style={{ marginBottom: 12, padding: '10px 14px', borderRadius: 8, backgroundColor: colors.bgAccent, color: colors.green, fontSize: 13 }}>{success}</div>}

      {/* Identidad */}
      <div style={section}>
        <div style={secHead}><Store size={15} color={colors.green} /> Identidad</div>
        <div style={secBody}>
          <div><label style={lbl}>Nombre de la tienda</label><input style={inp} value={form.store_name} onChange={set('store_name')} placeholder="Diezrios" /></div>
          <div><label style={lbl}>URL del logo</label><input style={inp} value={form.store_logo} onChange={set('store_logo')} placeholder="https://..." /><p style={hint}>Sube la imagen a un hosting y pega la URL aquí</p></div>
          <div><label style={lbl}>Color principal</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input type="color" value={form.store_color} onChange={set('store_color')}
                style={{ width: 44, height: 36, borderRadius: 8, border: `1px solid ${colors.borderStrong}`, cursor: 'pointer', padding: 2, backgroundColor: colors.bgApp }} />
              <input style={{ ...inp, flex: 1 }} value={form.store_color} onChange={set('store_color')} placeholder="#22c55e" />
            </div>
          </div>
        </div>
      </div>

      {/* Portada */}
      <div style={section}>
        <div style={secHead}><Sparkles size={15} color={colors.green} /> Portada</div>
        <div style={secBody}>
          <div><label style={lbl}>Texto del banner superior</label><input style={inp} value={form.store_announcement} onChange={set('store_announcement')} placeholder="🚚 Delivery gratis en compras sobre $10.000" /></div>
          <div><label style={lbl}>Título principal</label><input style={inp} value={form.store_hero_title} onChange={set('store_hero_title')} placeholder="Productos frescos directo al hogar" /></div>
          <div><label style={lbl}>Subtítulo</label><input style={inp} value={form.store_hero_subtitle} onChange={set('store_hero_subtitle')} placeholder="Sin intermediarios..." /></div>
          <div><label style={lbl}>Tags (separados por coma)</label><input style={inp} value={form.store_hero_tags} onChange={set('store_hero_tags')} placeholder="🥚 Huevos libres, 🫒 Aceitunas, 🧀 Quesos" /><p style={hint}>Aparecen como pills debajo del subtítulo</p></div>
        </div>
      </div>

      {/* Entrega */}
      <div style={section}>
        <div style={secHead}><Phone size={15} color={colors.green} /> Entrega y contacto</div>
        <div style={secBody}>
          <div><label style={lbl}>Umbral envío gratis ($)</label><input style={inp} type="number" min="0" value={form.store_free_shipping} onChange={set('store_free_shipping')} placeholder="10000" /><p style={hint}>Pon 0 para desactivar</p></div>
          <div>
            <label style={lbl}>Método de pago del bot</label>
            <select style={{ ...inp, cursor: 'pointer' }} value={form.payment_mode} onChange={set('payment_mode')}>
              <option value="cod">💵 Pago contra entrega (COD)</option>
              <option value="link">🔗 Link de pago Shopify</option>
            </select>
            <p style={hint}>COD: el bot confirma el pedido sin cobrar online. Link: envía link de pago de Shopify al cliente.</p>
          </div>
          <div><label style={lbl}>WhatsApp de contacto (botón flotante)</label><input style={inp} value={form.store_whatsapp_phone} onChange={set('store_whatsapp_phone')} placeholder="56912345678" /><p style={hint}>Vacío = botón no aparece</p></div>
          <div><label style={lbl}>Teléfono admin (alertas de pedidos)</label><input style={inp} value={form.admin_alert_phone} onChange={set('admin_alert_phone')} placeholder="56912345678" /><p style={hint}>Recibe un WhatsApp por cada pedido nuevo</p></div>
          <div><label style={lbl}>URL pública de la tienda (para el bot)</label><input style={inp} value={form.store_public_url} onChange={set('store_public_url')} placeholder="https://crm.diezrios.cl/tienda/diezrios" /><p style={hint}>El bot usará esta URL cuando los clientes pidan el link del catálogo o al compartir productos</p></div>
        </div>
      </div>

      {/* Cómo comprar */}
      <div style={section}>
        <div style={secHead}><Sparkles size={15} color={colors.green} /> Cómo comprar</div>
        <div style={secBody}>
          <div>
            <label style={lbl}>Texto "Cómo comprar"</label>
            <textarea style={{ ...inp, height: 120, resize: 'vertical' }} value={form.store_how_to_buy} onChange={set('store_how_to_buy')} placeholder="Vacío = se muestra contenido por defecto con los 4 pasos." />
            <p style={hint}>Si lo dejas vacío, se muestra el flujo estándar. Escribe aquí tu proceso personalizado.</p>
          </div>
        </div>
      </div>

      {/* Nuestra historia */}
      <div style={section}>
        <div style={secHead}><Store size={15} color={colors.green} /> Nuestra historia</div>
        <div style={secBody}>
          <div>
            <label style={lbl}>Texto "Nuestra historia"</label>
            <textarea style={{ ...inp, height: 120, resize: 'vertical' }} value={form.store_about_us} onChange={set('store_about_us')} placeholder="Vacío = se muestra contenido por defecto." />
            <p style={hint}>Cuéntale a tus clientes quiénes son, qué los hace especiales. Si lo dejas vacío se muestra contenido genérico.</p>
          </div>
        </div>
      </div>

      <button onClick={save} disabled={saving}
        style={{ width: '100%', padding: '12px', borderRadius: '10px', border: 'none',
          backgroundColor: saving ? colors.borderStrong : colors.green, color: 'white',
          fontWeight: 700, fontSize: '14px', cursor: saving ? 'not-allowed' : 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
        {saving ? <><Loader size={15} style={{ animation: 'spin 1s linear infinite' }} /> Guardando...</> : <><Save size={15} /> Guardar configuración</>}
      </button>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

export default function ProductsPanel({ orgSlug }) {
  const { colors, isDark } = useTheme();
  const [activeTab, setActiveTab] = useState('productos');
  const [products, setProducts]   = useState([]);
  const [loading, setLoading]     = useState(true);
  const [showForm, setShowForm]   = useState(false);
  const [editing, setEditing]     = useState(null); // product being edited
  const [form, setForm]           = useState(EMPTY_FORM);
  const [saving, setSaving]       = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [copied, setCopied]             = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/products');
      setProducts(data.products || []);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openNew = () => { setEditing(null); setForm(EMPTY_FORM); setShowForm(true); };
  const openEdit = (p) => {
    setEditing(p);
    setForm({
      title: p.title, description: p.description || '', price: p.price,
      comparePrice: p.compare_price || '', sku: p.sku || '',
      stock: String(p.stock ?? -1), imageUrl: p.image_url || '', active: p.active,
      category: p.category || '', isBusiness: p.is_business || false,
      bulkPrice: p.bulk_price ? String(p.bulk_price) : '',
      bulkMinQty: p.bulk_min_qty ? String(p.bulk_min_qty) : '',
    });
    setShowForm(true);
  };
  const closeForm = () => { setShowForm(false); setEditing(null); };

  const handleSave = async () => {
    if (!form.title.trim() || !form.price) return;
    setSaving(true);
    try {
      const payload = {
        title: form.title.trim(), description: form.description.trim() || null,
        price: parseFloat(form.price), comparePrice: parseFloat(form.comparePrice) || null,
        sku: form.sku.trim() || null, stock: parseInt(form.stock) || -1,
        imageUrl: form.imageUrl.trim() || null, active: form.active,
        category: form.category.trim() || null, isBusiness: form.isBusiness,
        bulkPrice: parseFloat(form.bulkPrice) || null,
        bulkMinQty: parseInt(form.bulkMinQty) || null,
      };
      if (editing) {
        await api.put(`/products/${editing.id}`, payload);
      } else {
        await api.post('/products', payload);
      }
      closeForm();
      load();
    } catch (err) { alert('Error: ' + (err.response?.data?.error || err.message)); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id, title) => {
    if (!confirm(`¿Eliminar "${title}"?`)) return;
    try { await api.delete(`/products/${id}`); load(); }
    catch (err) { alert('Error: ' + err.message); }
  };

  const handleToggle = async (product) => {
    try {
      await api.put(`/products/${product.id}`, { active: !product.active });
      setProducts(prev => prev.map(p => p.id === product.id ? { ...p, active: !p.active } : p));
    } catch (err) { alert('Error: ' + err.message); }
  };

  const handleImportShopify = async () => {
    if (!confirm('¿Importar todos los productos desde Shopify? Los productos existentes con el mismo nombre se actualizarán.')) return;
    setImporting(true); setImportResult(null);
    try {
      const { data } = await api.post('/products/import-shopify');
      setImportResult(data);
      load();
    } catch (err) { alert('Error importando: ' + (err.response?.data?.error || err.message)); }
    finally { setImporting(false); }
  };

  const storeUrl = orgSlug ? `${window.location.origin}/tienda/${orgSlug}` : null;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', backgroundColor: colors.bgApp, overflow: 'hidden' }}>

      {/* Header */}
      <div style={{ padding: '20px 24px 16px', borderBottom: `1px solid ${colors.border}`, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <Package size={22} color={colors.green} />
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: colors.textPrimary }}>Productos</h2>
            <p style={{ margin: '2px 0 0', fontSize: '13px', color: colors.textSecondary }}>
              {products.length} producto{products.length !== 1 ? 's' : ''} · {products.filter(p => p.active).length} activos
            </p>
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {storeUrl && (
              <a href={storeUrl} target="_blank" rel="noreferrer"
                style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 14px', borderRadius: '8px',
                  border: `1px solid ${colors.green}`, color: colors.green, textDecoration: 'none', fontSize: '13px', fontWeight: 600 }}>
                <ExternalLink size={14} /> Ver tienda
              </a>
            )}
            <button onClick={handleImportShopify} disabled={importing}
              style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 14px', borderRadius: '8px',
                border: `1px solid ${colors.border}`, backgroundColor: 'transparent',
                color: importing ? colors.textMuted : colors.textPrimary, cursor: importing ? 'not-allowed' : 'pointer', fontSize: '13px' }}>
              <Download size={14} /> {importing ? 'Importando...' : 'Importar desde Shopify'}
            </button>
            <button onClick={openNew}
              style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 16px', borderRadius: '8px',
                backgroundColor: colors.green, border: 'none', color: 'white', cursor: 'pointer', fontSize: '13px', fontWeight: 600 }}>
              <Plus size={15} /> Agregar
            </button>
          </div>
        </div>
        {/* Link de tienda pública */}
        {storeUrl && (
          <div style={{ marginTop: '14px', display: 'flex', alignItems: 'center', gap: '8px',
            backgroundColor: colors.bgApp, border: `1px solid ${colors.border}`, borderRadius: '10px', padding: '10px 14px' }}>
            <span style={{ fontSize: '12px', color: colors.textSecondary, flexShrink: 0 }}>🔗 Link de tu tienda:</span>
            <span style={{ flex: 1, fontSize: '13px', color: colors.textPrimary, fontFamily: 'monospace',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{storeUrl}</span>
            <button onClick={() => { navigator.clipboard.writeText(storeUrl); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
              title="Copiar link" style={{ background: 'none', border: 'none', cursor: 'pointer', color: copied ? colors.green : colors.textSecondary,
                display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', flexShrink: 0 }}>
              {copied ? <><Check size={14} /> Copiado</> : <><Copy size={14} /> Copiar</>}
            </button>
            <a href={storeUrl} target="_blank" rel="noreferrer"
              style={{ color: colors.green, textDecoration: 'none', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
              <ExternalLink size={14} />
            </a>
          </div>
        )}

        {importResult && (
          <div style={{ marginTop: '12px', padding: '10px 14px', borderRadius: '8px',
            backgroundColor: isDark ? '#22c55e18' : '#dcfce7', border: `1px solid #22c55e44`, fontSize: '13px', color: '#16a34a' }}>
            ✅ Importación completa: {importResult.imported} nuevos, {importResult.updated} actualizados
            {' · '}{importResult.imagesHostedOnR2 ? '📦 Imágenes guardadas en R2 (independiente de Shopify)' : '⚠️ Imágenes aún en CDN de Shopify — configura R2 para independizarte'}
            <button onClick={() => setImportResult(null)} style={{ marginLeft: '12px', background: 'none', border: 'none', cursor: 'pointer', color: '#16a34a' }}>✕</button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: `1px solid ${colors.border}`, padding: '0 24px', gap: '2px', flexShrink: 0 }}>
        {[{ key: 'productos', label: 'Productos', icon: Package }, { key: 'configuracion', label: 'Configuración', icon: Settings }].map(t => (
          <button key={t.key} onClick={() => setActiveTab(t.key)}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '10px 14px', border: 'none',
              backgroundColor: 'transparent', cursor: 'pointer', fontSize: '13px', fontWeight: activeTab === t.key ? 600 : 400,
              color: activeTab === t.key ? colors.green : colors.textSecondary,
              borderBottom: activeTab === t.key ? `2px solid ${colors.green}` : '2px solid transparent',
              marginBottom: -1 }}>
            <t.icon size={14} />{t.label}
          </button>
        ))}
      </div>

      {/* Tab: Configuración */}
      {activeTab === 'configuracion' && <StoreConfigTab orgSlug={orgSlug} colors={colors} />}

      {/* Tab: Productos — Lista */}
      {activeTab === 'productos' && <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
        {loading ? (
          <div style={{ textAlign: 'center', color: colors.textSecondary, padding: '40px' }}>Cargando...</div>
        ) : products.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: colors.textSecondary }}>
            <Package size={40} style={{ opacity: 0.3, marginBottom: '12px' }} />
            <p style={{ margin: '0 0 16px' }}>No hay productos todavía</p>
            <button onClick={openNew} style={{ padding: '10px 20px', borderRadius: '8px', backgroundColor: colors.green, border: 'none', color: 'white', cursor: 'pointer', fontWeight: 600 }}>
              Agregar primer producto
            </button>
          </div>
        ) : (() => {
          // Agrupar por categoría
          const groups = {};
          products.forEach(p => {
            const key = p.category || '—';
            if (!groups[key]) groups[key] = [];
            groups[key].push(p);
          });
          const sorted = Object.keys(groups).sort((a, b) => a === '—' ? 1 : b === '—' ? -1 : a.localeCompare(b));

          const ProductCard = ({ p }) => (
            <div key={p.id} style={{
              backgroundColor: colors.bgPanel, border: `1px solid ${colors.border}`,
              borderRadius: '12px', overflow: 'hidden', opacity: p.active ? 1 : 0.55,
            }}>
              {p.image_url ? (
                <div style={{ width: '100%', height: '160px', overflow: 'hidden', backgroundColor: colors.bgApp }}>
                  <img src={p.image_url} alt={p.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                </div>
              ) : (
                <div style={{ width: '100%', height: '80px', backgroundColor: colors.bgApp, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Package size={28} style={{ opacity: 0.2 }} />
                </div>
              )}
              <div style={{ padding: '12px 14px' }}>
                <div style={{ fontWeight: 700, fontSize: '14px', color: colors.textPrimary, marginBottom: '4px' }}>{p.title}</div>
                {p.description && (
                  <div style={{ fontSize: '12px', color: colors.textSecondary, marginBottom: '8px',
                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {p.description}
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '16px', fontWeight: 700, color: colors.textPrimary }}>
                    ${Number(p.price).toLocaleString('es-CL')}
                  </span>
                  {p.compare_price && parseFloat(p.compare_price) > parseFloat(p.price) && (
                    <span style={{ fontSize: '12px', color: colors.textMuted, textDecoration: 'line-through' }}>
                      ${Number(p.compare_price).toLocaleString('es-CL')}
                    </span>
                  )}
                  {p.stock >= 0 && (
                    <span style={{ fontSize: '11px', color: p.stock > 0 ? colors.green : colors.red, marginLeft: 'auto' }}>
                      {p.stock > 0 ? `${p.stock} en stock` : 'Sin stock'}
                    </span>
                  )}
                </div>
                {(p.is_business || (p.bulk_price && p.bulk_min_qty) || (p.compare_price && parseFloat(p.compare_price) > parseFloat(p.price))) && (
                  <div style={{ marginBottom: '8px', display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                    {p.is_business && (
                      <span style={{ fontSize: '10px', fontWeight: 700, backgroundColor: '#6366f120', color: '#6366f1',
                        border: '1px solid #6366f155', borderRadius: '20px', padding: '2px 8px' }}>
                        🏢 Solo empresas
                      </span>
                    )}
                    {p.compare_price && parseFloat(p.compare_price) > parseFloat(p.price) && (
                      <span style={{ fontSize: '10px', fontWeight: 700, backgroundColor: '#ef444420', color: '#ef4444',
                        border: '1px solid #ef444455', borderRadius: '20px', padding: '2px 8px' }}>
                        🏷️ −{Math.round((1 - parseFloat(p.price)/parseFloat(p.compare_price))*100)}% dcto
                      </span>
                    )}
                    {p.bulk_price && p.bulk_min_qty && (
                      <span style={{ fontSize: '10px', fontWeight: 700, backgroundColor: '#f59e0b20', color: '#d97706',
                        border: '1px solid #f59e0b55', borderRadius: '20px', padding: '2px 8px' }}>
                        🧾 {p.bulk_min_qty}+ u.: ${Number(p.bulk_price).toLocaleString('es-CL')}
                      </span>
                    )}
                  </div>
                )}
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button onClick={() => handleToggle(p)} title={p.active ? 'Desactivar' : 'Activar'}
                    style={{ padding: '6px 10px', borderRadius: '7px', border: `1px solid ${colors.border}`,
                      backgroundColor: 'transparent', cursor: 'pointer', color: p.active ? colors.green : colors.textMuted }}>
                    {p.active ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}
                  </button>
                  <button onClick={() => openEdit(p)} title="Editar"
                    style={{ flex: 1, padding: '6px', borderRadius: '7px', border: `1px solid ${colors.border}`,
                      backgroundColor: 'transparent', cursor: 'pointer', color: colors.textSecondary,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px', fontSize: '13px' }}>
                    <Edit2 size={13} /> Editar
                  </button>
                  <button onClick={() => handleDelete(p.id, p.title)} title="Eliminar"
                    style={{ padding: '6px 10px', borderRadius: '7px', border: `1px solid ${colors.border}`,
                      backgroundColor: 'transparent', cursor: 'pointer', color: colors.red }}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </div>
          );

          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>
              {sorted.map(cat => (
                <div key={cat}>
                  {/* Encabezado de categoría */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
                    <span style={{ fontSize: '15px', fontWeight: 700, color: colors.textPrimary }}>
                      {cat === '—' ? 'Sin categoría' : cat}
                    </span>
                    <span style={{ fontSize: '12px', color: colors.textMuted,
                      backgroundColor: colors.bgApp, border: `1px solid ${colors.border}`,
                      borderRadius: '20px', padding: '2px 10px' }}>
                      {groups[cat].length} producto{groups[cat].length !== 1 ? 's' : ''}
                    </span>
                    <div style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
                  </div>
                  {/* Grid de productos */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '14px' }}>
                    {groups[cat].map(p => <ProductCard key={p.id} p={p} />)}
                  </div>
                </div>
              ))}
            </div>
          );
        })()}
      </div>}

      {/* Formulario modal */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, backgroundColor: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}
          onClick={closeForm}>
          <div onClick={e => e.stopPropagation()}
            style={{ backgroundColor: colors.bgPanel, borderRadius: '14px', padding: '24px',
              width: '100%', maxWidth: '480px', display: 'flex', flexDirection: 'column', gap: '14px',
              maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.4)' }}>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: colors.textPrimary }}>
                {editing ? 'Editar producto' : 'Nuevo producto'}
              </h3>
              <button onClick={closeForm} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.textSecondary }}>
                <X size={18} />
              </button>
            </div>

            {[
              { label: 'Nombre *', key: 'title', placeholder: 'Ej: Camiseta azul talla M' },
              { label: 'Descripción', key: 'description', placeholder: 'Descripción del producto', multiline: true },
              { label: 'Precio *', key: 'price', placeholder: '15900', type: 'number' },
              { label: 'Precio antes (tachado)', key: 'comparePrice', placeholder: '19900', type: 'number' },
              { label: 'Categoría', key: 'category', placeholder: 'Huevos, Quesos, Aceitunas...' },
              { label: 'SKU', key: 'sku', placeholder: 'CAM-AZU-M' },
              { label: 'Stock (-1 = sin límite)', key: 'stock', placeholder: '-1', type: 'number' },
              { label: 'URL de imagen', key: 'imageUrl', placeholder: 'https://...' },
            ].map(({ label, key, placeholder, type, multiline }) => (
              <div key={key}>
                <label style={{ fontSize: '12px', fontWeight: 600, color: colors.textSecondary, display: 'block', marginBottom: '5px' }}>
                  {label}
                </label>
                {multiline ? (
                  <textarea value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                    placeholder={placeholder} rows={3}
                    style={{ width: '100%', padding: '9px 12px', borderRadius: '8px', border: `1px solid ${colors.border}`,
                      backgroundColor: colors.bgApp, color: colors.textPrimary, fontSize: '14px',
                      fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box' }} />
                ) : (
                  <input type={type || 'text'} value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                    placeholder={placeholder}
                    style={{ width: '100%', padding: '9px 12px', borderRadius: '8px', border: `1px solid ${colors.border}`,
                      backgroundColor: colors.bgApp, color: colors.textPrimary, fontSize: '14px', boxSizing: 'border-box' }} />
                )}
              </div>
            ))}

            {/* Descuento por volumen */}
            <div style={{ backgroundColor: colors.bgApp, border: `1px solid ${colors.border}`, borderRadius: '10px', padding: '12px 14px' }}>
              <div style={{ fontSize: '12px', fontWeight: 600, color: colors.textSecondary, marginBottom: '10px' }}>
                🧾 Descuento por volumen (opcional)
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div>
                  <label style={{ fontSize: '11px', color: colors.textMuted, display: 'block', marginBottom: '4px' }}>Precio por unidad (bulk)</label>
                  <input type="number" value={form.bulkPrice} onChange={e => setForm(f => ({ ...f, bulkPrice: e.target.value }))}
                    placeholder="Ej: 900"
                    style={{ width: '100%', padding: '8px 10px', borderRadius: '7px', border: `1px solid ${colors.border}`,
                      backgroundColor: colors.bgPanel, color: colors.textPrimary, fontSize: '14px', boxSizing: 'border-box' }} />
                </div>
                <div>
                  <label style={{ fontSize: '11px', color: colors.textMuted, display: 'block', marginBottom: '4px' }}>Mínimo de unidades</label>
                  <input type="number" min="2" value={form.bulkMinQty} onChange={e => setForm(f => ({ ...f, bulkMinQty: e.target.value }))}
                    placeholder="Ej: 6"
                    style={{ width: '100%', padding: '8px 10px', borderRadius: '7px', border: `1px solid ${colors.border}`,
                      backgroundColor: colors.bgPanel, color: colors.textPrimary, fontSize: '14px', boxSizing: 'border-box' }} />
                </div>
              </div>
              {form.bulkPrice && form.bulkMinQty && (
                <div style={{ marginTop: '8px', fontSize: '11px', color: colors.green }}>
                  ✓ El bot dirá: "Comprando {form.bulkMinQty}+ unidades → ${Number(form.bulkPrice).toLocaleString('es-CL')}/u"
                </div>
              )}
            </div>

            {/* Preview imagen */}
            {form.imageUrl && (
              <img src={form.imageUrl} alt="Preview"
                style={{ width: '100%', height: '160px', objectFit: 'cover', borderRadius: '8px', border: `1px solid ${colors.border}` }}
                onError={e => e.target.style.display = 'none'} />
            )}

            <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
              <input type="checkbox" checked={form.active} onChange={e => setForm(f => ({ ...f, active: e.target.checked }))} />
              <span style={{ fontSize: '14px', color: colors.textPrimary }}>Producto activo (visible en la tienda)</span>
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer',
              backgroundColor: form.isBusiness ? '#6366f110' : 'transparent',
              border: `1px solid ${form.isBusiness ? '#6366f155' : colors.border}`,
              borderRadius: '8px', padding: '10px 12px' }}>
              <input type="checkbox" checked={form.isBusiness} onChange={e => setForm(f => ({ ...f, isBusiness: e.target.checked }))} />
              <div>
                <span style={{ fontSize: '14px', color: form.isBusiness ? '#6366f1' : colors.textPrimary, fontWeight: form.isBusiness ? 600 : 400 }}>
                  🏢 Solo para empresas (B2B)
                </span>
                <div style={{ fontSize: '11px', color: colors.textMuted, marginTop: '2px' }}>
                  El bot NO mostrará este producto ni su precio a clientes particulares
                </div>
              </div>
            </label>

            <button onClick={handleSave} disabled={saving || !form.title.trim() || !form.price}
              style={{ padding: '12px', borderRadius: '8px', border: 'none',
                backgroundColor: colors.green, color: 'white', fontWeight: 700, fontSize: '14px',
                cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}>
              {saving ? 'Guardando...' : editing ? 'Guardar cambios' : 'Crear producto'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
