/**
 * ProductsPanel — Gestión de productos propios del CRM
 *
 * Permite agregar, editar, eliminar y activar/desactivar productos.
 * Botón "Importar desde Shopify" para migración con un clic.
 */
import { useState, useEffect, useCallback } from 'react';
import { Plus, Edit2, Trash2, ToggleLeft, ToggleRight, Download, X, Package, ExternalLink } from 'lucide-react';
import { useTheme } from '../theme.js';
import { api } from '../utils/api.js';

const EMPTY_FORM = { title: '', description: '', price: '', comparePrice: '', sku: '', stock: '-1', imageUrl: '', active: true };

export default function ProductsPanel({ orgSlug }) {
  const { colors, isDark } = useTheme();
  const [products, setProducts]   = useState([]);
  const [loading, setLoading]     = useState(true);
  const [showForm, setShowForm]   = useState(false);
  const [editing, setEditing]     = useState(null); // product being edited
  const [form, setForm]           = useState(EMPTY_FORM);
  const [saving, setSaving]       = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);

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
        {importResult && (
          <div style={{ marginTop: '12px', padding: '10px 14px', borderRadius: '8px',
            backgroundColor: isDark ? '#22c55e18' : '#dcfce7', border: `1px solid #22c55e44`, fontSize: '13px', color: '#16a34a' }}>
            ✅ Importación completa: {importResult.imported} nuevos, {importResult.updated} actualizados
            <button onClick={() => setImportResult(null)} style={{ marginLeft: '12px', background: 'none', border: 'none', cursor: 'pointer', color: '#16a34a' }}>✕</button>
          </div>
        )}
      </div>

      {/* Lista */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
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
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '14px' }}>
            {products.map(p => (
              <div key={p.id} style={{
                backgroundColor: colors.bgPanel, border: `1px solid ${colors.border}`,
                borderRadius: '12px', overflow: 'hidden',
                opacity: p.active ? 1 : 0.55,
                transition: 'transform 0.15s, box-shadow 0.15s',
              }}>
                {/* Imagen */}
                {p.image_url ? (
                  <div style={{ width: '100%', height: '160px', overflow: 'hidden', backgroundColor: colors.bgApp }}>
                    <img src={p.image_url} alt={p.title}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  </div>
                ) : (
                  <div style={{ width: '100%', height: '100px', backgroundColor: colors.bgApp,
                    display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Package size={32} style={{ opacity: 0.2 }} />
                  </div>
                )}
                {/* Info */}
                <div style={{ padding: '12px 14px' }}>
                  <div style={{ fontWeight: 700, fontSize: '14px', color: colors.textPrimary, marginBottom: '4px' }}>{p.title}</div>
                  {p.description && (
                    <div style={{ fontSize: '12px', color: colors.textSecondary, marginBottom: '8px',
                      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                      {p.description}
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
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
                  {/* Acciones */}
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
            ))}
          </div>
        )}
      </div>

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
