import { useEffect, useState } from 'react';
import { api } from '../utils/api.js';

export default function OrderProductEditor({ product, colors, onSaved, onClose }) {
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api.get('/products').then(({ data }) => {
      if (cancelled) return;
      const current = (data.products || data.data || []).find(p => String(p.id) === String(product.id));
      if (!current) throw new Error('El producto ya no está disponible. Cierra y vuelve a abrir la orden.');
      setForm({ title: current.title || '', price: String(current.price ?? ''), description: current.description || '' });
    }).catch(e => { if (!cancelled) setError(e.response?.data?.error || e.message); });
    return () => { cancelled = true; };
  }, [product.id]);

  const save = async e => {
    e.preventDefault();
    const price = Number(form.price);
    if (!form.title.trim() || !form.price.trim() || !Number.isFinite(price) || price < 0) {
      setError('Escribe un nombre y un precio válido, igual o mayor a cero.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const { data } = await api.put(`/products/${product.id}`, {
        title: form.title.trim(), price, description: form.description.trim(),
      });
      onSaved(data.product);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally { setSaving(false); }
  };
  const inputStyle = { width:'100%', boxSizing:'border-box', padding:'10px', borderRadius:'8px', border:`1px solid ${colors.border}`, background:colors.bgSub, color:colors.textPrimary, fontSize:'14px' };
  return (
    <div style={{ position:'fixed', inset:0, zIndex:1100, background:'rgba(0,0,0,.65)', display:'flex', alignItems:'center', justifyContent:'center', padding:'16px' }}>
      <section role="dialog" aria-modal="true" aria-label="Editar producto del catálogo" style={{ width:'100%', maxWidth:'460px', maxHeight:'85vh', overflowY:'auto', padding:'20px', borderRadius:'14px', background:colors.bgPanel, border:`1px solid ${colors.border}`, color:colors.textPrimary }}>
        <h3 style={{ margin:'0 0 10px' }}>Editar producto</h3>
        <p style={{ fontSize:'13px', color:colors.textSecondary }}>Los cambios se guardan en el catálogo y se aplican a esta orden y a nuevas ventas. Los pedidos ya creados mantienen sus datos.</p>
        {product._specialPrice && <p style={{ fontSize:'13px', color:colors.green }}>Este cliente tiene un precio especial de ${Number(product.price).toLocaleString('es-CL')}, que se conservará en su orden. Aquí editas el precio general.</p>}
        {!form && !error && <p>Cargando producto…</p>}
        <form onSubmit={save} style={{ display:'grid', gap:'12px' }}>
          {form && <>
            <label>Nombre del producto<input autoFocus required disabled={saving} value={form.title} onChange={e => setForm(f => ({ ...f, title:e.target.value }))} style={inputStyle} /></label>
            <label>Precio del catálogo (CLP)<input required type="number" min="0" step="1" disabled={saving} value={form.price} onChange={e => setForm(f => ({ ...f, price:e.target.value }))} style={inputStyle} /></label>
            <label>Descripción<textarea rows={3} disabled={saving} value={form.description} onChange={e => setForm(f => ({ ...f, description:e.target.value }))} style={{ ...inputStyle, resize:'vertical' }} /></label>
          </>}
          {error && <div role="alert" style={{ color:colors.red, fontSize:'13px' }}>{error}</div>}
          <div style={{ display:'flex', justifyContent:'flex-end', gap:'8px' }}>
            <button type="button" disabled={saving} onClick={onClose} style={{ padding:'9px 14px', borderRadius:'8px', border:`1px solid ${colors.border}`, background:'none', color:colors.textSecondary, cursor:'pointer' }}>Cancelar</button>
            <button type="submit" disabled={saving || !form} style={{ padding:'9px 14px', borderRadius:'8px', border:0, background:colors.green, color:'#fff', fontWeight:700, cursor:saving?'wait':'pointer', opacity:saving || !form ? .6 : 1 }}>{saving ? 'Guardando…' : 'Guardar cambios'}</button>
          </div>
        </form>
      </section>
    </div>
  );
}
