import { useEffect, useState } from 'react';
import { api } from '../utils/api.js';
import * as ui from '../ui.js';

const path = '/settings/instagram-keywords';
const blankItem = () => ({ key: '', price: '' });

export default function InstagramKeywordOffers({ colors }) {
  const [config, setConfig] = useState(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    api.get(path).then(({ data }) => { if (active) setConfig(data); })
      .catch(() => { if (active) setError('No se pudieron cargar las palabras clave.'); });
    return () => { active = false; };
  }, []);
  function change(rules) {
    setConfig({ ...config, rules });
    setError('');
    setSaved(false);
  }
  function update(index, patch) {
    change(config.rules.map((rule, i) => i === index ? { ...rule, ...patch } : rule));
  }
  async function save() {
    setSaving(true);
    setError('');
    try {
      const rules = config.rules.map(rule => ({ ...rule, items: rule.items.map(item => ({ ...item, price: Number(item.price) })) }));
      const { data } = await api.put(path, { rules, version: config.version });
      setConfig({ ...config, ...data });
      setSaved(true);
    } catch (err) { setError(err.response?.data?.error || 'No se pudieron guardar las ofertas.'); }
    finally { setSaving(false); }
  }
  const button = ui.btn(colors);
  return <section style={ui.card(colors)}>
    <h3 style={{ margin: 0, color: colors.textPrimary }}>Ofertas por palabra en Instagram</h3>
    <p style={{ color: colors.textSecondary }}>Cuando alguien envíe la palabra por privado o responda una historia con ella, el bot le mostrará estos precios y los usará en su pedido.</p>
    {error && <p role="alert" style={{ color: colors.danger }}>{error}</p>}
    {config && <fieldset disabled={saving} style={{ border: 0, margin: 0, padding: 0 }}>
      {config.rules.map((rule, index) => {
        const editItem = (row, patch) => update(index, { items: rule.items.map((it, i) => i === row ? { ...it, ...patch } : it) });
        return <fieldset key={index} style={{ ...ui.card(colors), marginBottom: 12 }}>
          <legend>{rule.keyword || 'Nueva palabra'}</legend>
          <label>Palabra o frase <input style={ui.input(colors)} maxLength={60} value={rule.keyword}
            onChange={e => update(index, { keyword: e.target.value })} /></label>{' '}
          <label><input type="checkbox" checked={rule.enabled} onChange={e => update(index, { enabled: e.target.checked })} /> Activa</label>
          {rule.items.map((item, row) => <div key={row} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, margin: '10px 0' }}>
            <label>Producto <select value={item.key} style={ui.select(colors, { maxWidth: '100%' })} onChange={e => editItem(row, { key: e.target.value })}>
              <option value="">Seleccionar producto</option>
              {item.key && !config.products.some(p => p.key === item.key) && <option value={item.key}>Producto retirado</option>}
              {config.products.map(p => <option key={p.key} value={p.key}>{p.title}</option>)}
            </select></label>
            <label>Precio por unidad ($) <input type="number" min="1" step="1" value={item.price}
              style={ui.input(colors, { width: 95 })} onChange={e => editItem(row, { price: e.target.value })} /></label>
            <button type="button" style={button} onClick={() => update(index, { items: rule.items.filter((_, i) => i !== row) })}>Quitar producto</button>
          </div>)}
          <button type="button" style={button} onClick={() => update(index, { items: [...rule.items, blankItem()] })}>Agregar producto</button>{' '}
          <button type="button" style={ui.btn(colors, 'ghost')} onClick={() => change(config.rules.filter((_, i) => i !== index))}>Eliminar palabra</button>
        </fieldset>;
      })}
      <button type="button" style={button} onClick={() => change([...config.rules, { keyword: '', enabled: true, items: [blankItem()] }])}>Agregar palabra</button>{' '}
      <button type="button" style={ui.btn(colors, 'primary')} onClick={save}>Guardar ofertas</button>
      {saved && <span role="status"> Ofertas guardadas.</span>}
    </fieldset>}
  </section>;
}
