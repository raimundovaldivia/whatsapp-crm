import { useEffect, useRef, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { api } from '../utils/api.js';
import { useTheme } from '../theme.js';

const fold = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export default function CampaignProductFilter({ products, term, disabled, onApply, onClear }) {
  const { colors } = useTheme();
  const dialog = useRef(null);
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [checked, setChecked] = useState(new Set());
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setCatalog(null);
    setError('');
    api.get('/contacts/product-filter-options').then(({ data }) => {
      if (!current) return;
      const options = [...data.products].sort((a, b) =>
        Number(a.inactive) - Number(b.inactive) || a.title.localeCompare(b.title, 'es', { numeric: true }));
      setCatalog(options);
      setChecked(previous => new Set(options.filter(p => previous.has(p.id)).map(p => p.id)));
    }).catch(err => {
      if (current) setError(err.response?.data?.error || 'No se pudo cargar el catálogo.');
    });
    return () => { current = false; };
  }, [open, attempt]);

  function showPicker() {
    setChecked(new Set(products.map(p => p.id)));
    setSearch('');
    setCatalog(null);
    setError('');
    setOpen(true);
    dialog.current.showModal();
  }

  function toggle(id) {
    setChecked(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function apply() {
    setApplying(true);
    try {
      const chosen = catalog.filter(p => checked.has(p.id));
      if (!chosen.length) onClear();
      else await onApply(chosen);
      dialog.current.close();
    } catch (err) {
      setError(err.response?.data?.error || 'No se pudo aplicar el filtro. Vuelve a intentarlo.');
    } finally {
      setApplying(false);
    }
  }

  const words = fold(search).trim().split(/\s+/);
  const visible = catalog?.filter(p => words.every(word => fold(p.title).includes(word)));
  const active = products.length > 0 || Boolean(term);
  const label = products.length > 1 ? `${products.length} productos` : products[0]?.title || term || 'Productos';
  const control = { background: colors.bgCard, color: colors.textPrimary, border: `1px solid ${colors.border}`, borderRadius: 7, padding: '7px 10px', font: 'inherit' };
  return <div style={{ display: 'flex', gap: 4, maxWidth: '100%', alignItems: 'center', fontSize: 13 }}>
    <button type="button" aria-haspopup="dialog" disabled={disabled} onClick={showPicker}
      title={active ? (products.map(p => p.title).join(', ') || term) : 'Filtrar por productos comprados'}
      style={{ ...control, display: 'flex', alignItems: 'center', gap: 6, maxWidth: 250, borderColor: active ? colors.green : colors.border }}>
      <span style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{label}</span><ChevronDown size={14} />
    </button>
    {active && <button type="button" aria-label="Quitar filtro de productos" title="Quitar filtro de productos" disabled={disabled}
      onClick={onClear} style={control}><X size={12} /></button>}
    <dialog ref={dialog} aria-label="Filtrar por productos comprados" onClose={() => setOpen(false)}
      onCancel={e => { if (applying) e.preventDefault(); }}
      style={{ ...control, padding: 16, width: 'min(420px, calc(100vw - 32px))', boxSizing: 'border-box', maxHeight: '85vh', borderRadius: 12 }}>
      {open && <div style={{ display: 'grid', gap: 10 }}>
        <strong style={{ fontSize: 16 }}>Compraron alguno de estos productos</strong>
        <input autoFocus type="search" aria-label="Buscar en el catálogo" placeholder="Buscar producto…"
          value={search} onChange={e => setSearch(e.target.value)} style={control} />
        {error && <div role="alert">{error} {!catalog && <button type="button" onClick={() => setAttempt(n => n + 1)}>Reintentar</button>}</div>}
        {!catalog && !error && <div role="status">Cargando productos…</div>}
        {catalog && <div role="group" aria-label="Productos del catálogo" style={{ maxHeight: '44vh', overflowY: 'auto' }}>
          {visible.map(p => <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 2px', cursor: 'pointer' }}>
            <input type="checkbox" checked={checked.has(p.id)} onChange={() => toggle(p.id)} disabled={applying} />
            <span>{p.title}{p.business ? ' · Empresa' : ''}{p.inactive ? ' · Inactivo' : ''}</span>
          </label>)}
          {!visible.length && <span>{catalog.length ? 'Sin coincidencias.' : 'El catálogo está vacío.'}</span>}
        </div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span aria-live="polite" style={{ flex: 1 }}>{checked.size} seleccionados</span>
          <button type="button" disabled={applying} onClick={() => dialog.current.close()} style={control}>Cancelar</button>
          <button type="button" disabled={!catalog || applying || disabled || (!checked.size && !active)} onClick={apply}
            style={{ ...control, color: colors.green }}>{applying ? 'Filtrando…' : 'Filtrar'}</button>
        </div>
      </div>}
    </dialog>
  </div>;
}
