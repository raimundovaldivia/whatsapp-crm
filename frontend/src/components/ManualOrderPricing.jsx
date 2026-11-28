import { useEffect, useState } from 'react';
import { api } from '../utils/api.js';

const money = value => '$' + value.toLocaleString('es-CL');
const initial = { discount: '', discountType: 'percent', manualTotal: '' };

export function useManualOrderPricing(phone, items, enabled = true) {
  const [adjustments, setAdjustments] = useState(initial);
  const [response, setResponse] = useState(null);
  const [revision, setRevision] = useState(0);
  const payload = { phone, items, ...adjustments };
  const key = enabled && items.length ? JSON.stringify(payload) : '';
  useEffect(() => {
    if (!key) return;
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const { data } = await api.post('/products/order-quote', JSON.parse(key));
        if (active) setResponse({ key, revision, quote: data });
      } catch (err) {
        if (active) setResponse({ key, revision, error: err.response?.data?.error || 'No pudimos verificar los precios.' });
      }
    }, 180);
    return () => { active = false; clearTimeout(timer); };
  }, [key, revision]);
  const current = key && response?.key === key && response.revision === revision ? response : null;
  return {
    adjustments, quote: current?.quote, error: current?.error, pending: !!key && !current,
    change: changes => setAdjustments(previous => ({ ...previous, ...changes })),
    refresh: () => setRevision(n => n + 1),
    reset: () => { setAdjustments(initial); setResponse(null); setRevision(n => n + 1); },
    orderBody: { ...payload, manualPricing: true, quoteSignature: current?.quote?.signature },
  };
}

export default function ManualOrderPricing({ colors, pricing, items, onLineChange }) {
  if (!items.length) return null;
  const { quote, adjustments, change } = pricing;
  const input = { minWidth: 0, width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 6,
    border: '1px solid ' + colors.border, background: colors.bgSub, color: colors.textPrimary, fontSize: 13 };
  const row = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 6 };
  const label = { fontSize: 12, color: colors.textSecondary };
  const discountInput = (name, value, type = 'percent', update) => (
    <span style={{ display: 'flex', gap: 4, width: 135 }}>
      <input type="number" min="0" max={type === 'percent' ? 100 : undefined} step={type === 'percent' ? 'any' : 1}
        aria-label={name} value={value ?? ''} placeholder="0" onChange={e => update({ discount: e.target.value })} style={input} />
      <select aria-label={'Unidad de ' + name} value={type || 'percent'} onChange={e => update({ discountType: e.target.value })} style={{ ...input, width: 54 }}>
        <option value="percent">%</option><option value="fixed">$</option>
      </select>
    </span>
  );
  const manual = adjustments.manualTotal !== '';
  return <section aria-label="Precios y descuentos" style={{ display: 'grid', gap: 9, padding: '10px 0', borderTop: '1px solid ' + colors.border }}>
    <strong style={{ color: colors.textPrimary, fontSize: 13 }}>Precios y descuentos</strong>
    {items.map((item, index) => {
      const line = quote?.items[index];
      const name = item.name || 'Producto ' + (index + 1);
      return <div key={index} style={{ borderBottom: '1px solid ' + colors.border, paddingBottom: 7 }}>
        <div style={{ ...row, ...label }}><strong>{item.quantity || 0} × {name}</strong>
          {line && <strong>{money(line.before_order_discount)}</strong>}</div>
        {line && line.base_total > line.volume_total && <div style={{ ...label, color: colors.green }}>Por cantidad: −{money(line.base_total - line.volume_total)}</div>}
        <div style={{ ...row, ...label, marginTop: 4 }}><span>Descuento del producto</span>
          {discountInput('Descuento de ' + name, item.discount, item.discountType, changes => onLineChange(index, changes))}</div>
      </div>;
    })}
    {!manual && <div style={{ ...label, ...row }}><span>Descuento adicional del pedido</span>
      {discountInput('Descuento adicional del pedido', adjustments.discount, adjustments.discountType, change)}</div>}
    <label style={{ ...label, ...row }}>Total manual ($)
      <input type="number" min="0" step="1" value={adjustments.manualTotal} placeholder="Automático" style={{ ...input, width: 135 }}
        onChange={e => change({ manualTotal: e.target.value, discount: '' })} /></label>
    {quote && quote.orderAdjustment !== 0 && <div style={{ ...label, ...row }}><span>{quote.orderAdjustment < 0 ? 'Descuento adicional' : 'Ajuste adicional'}</span>
      <b>{quote.orderAdjustment < 0 ? '−' : '+'}{money(Math.abs(quote.orderAdjustment))}</b></div>}
    {quote?.saving > 0 && <div style={{ ...label, ...row, color: colors.green }}><span>Ahorro total</span>
      <b>{money(quote.saving)} ({(100 * quote.saving / quote.baseTotal).toLocaleString('es-CL', { maximumFractionDigits: 2 })}%)</b></div>}
    {pricing.pending && <span role="status" style={label}>Calculando precios…</span>}
    {pricing.error && <div role="alert" style={{ ...row, color: colors.red, fontSize: 12 }}>{pricing.error}
      <button type="button" onClick={pricing.refresh} style={{ ...input, width: 'auto' }}>Reintentar</button></div>}
  </section>;
}
