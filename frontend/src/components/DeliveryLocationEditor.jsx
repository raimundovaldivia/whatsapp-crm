import { useState } from 'react';
import { api } from '../utils/api.js';
import * as ui from '../ui.js';

export default function DeliveryLocationEditor({ order, routeId, colors, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [manual, setManual] = useState(false);
  const [coordinates, setCoordinates] = useState('');
  const [street, setStreet] = useState('');
  const [city, setCity] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const actionStyle = { background: 'none', border: 0, color: colors.blue, padding: 0, cursor: 'pointer', fontSize: 12 };

  function open() {
    setManual(!!order.manualLocation || !order.fullAddress);
    setCoordinates(order.manualLocation ? `${order.lat}, ${order.lng}` : '');
    setStreet(order.address ?? order.fullAddress ?? '');
    setCity(order.city || '');
    setError('');
    setEditing(true);
  }

  async function save(event) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      const endpoint = routeId ? `/delivery/routes/${routeId}/stops/address` : '/delivery/orders/address';
      const target = routeId ? { stopKey: `${order.source}_${order.id}` } : { source: order.source, id: order.id };
      const location = manual ? { coordinates: coordinates.trim() } : { address: street.trim(), city: city.trim(), updateContact: true };
      const { data } = await api.patch(endpoint, { ...target, ...location });
      onSaved(data.stop);
      setEditing(false);
    } catch (e) {
      setError(e.response?.data?.error || 'No se pudo guardar la ubicación. Intenta nuevamente.');
    } finally {
      setSaving(false);
    }
  }

  if (!editing) return <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: colors.textMuted }}>
    {order.fullAddress && <span>{order.fullAddress} </span>}
    {order.manualLocation && <span>📍 {order.lat}, {order.lng} </span>}
    <button type="button" style={actionStyle} onClick={event => { event.stopPropagation(); open(); }}>
      {order.fullAddress || order.manualLocation ? 'Editar ubicación' : '+ Agregar ubicación'}
    </button>
  </div>;

  const input = { ...ui.input(colors), width: '100%', minWidth: 0, boxSizing: 'border-box', fontSize: 12 };
  return <form onSubmit={save} onClick={event => event.stopPropagation()} style={{ flex: 1, minWidth: 0, display: 'grid', gap: 6 }}>
    <select aria-label="Cómo ubicar el despacho" style={input} value={manual ? 'point' : 'address'} disabled={saving}
      onChange={event => { setManual(event.target.value === 'point'); setError(''); }}>
      <option value="address">Buscar por dirección</option>
      <option value="point">Usar coordenadas</option>
    </select>
    {manual ? <label style={{ color: colors.textSecondary, fontSize: 12 }}>
      Latitud, longitud
      <input autoFocus required aria-label="Latitud, longitud" value={coordinates} disabled={saving} style={input}
        placeholder="-29.905, -71.251" onChange={event => setCoordinates(event.target.value)} />
    </label> : <>
      <input required aria-label="Calle y número" placeholder="Calle y número" maxLength={300} style={input}
        value={street} disabled={saving} onChange={event => setStreet(event.target.value)} />
      <input aria-label="Ciudad" placeholder="Ciudad" maxLength={100} style={input}
        value={city} disabled={saving} onChange={event => setCity(event.target.value)} />
    </>}
    {error && <span role="alert" style={{ color: colors.red, fontSize: 12 }}>{error}</span>}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <button disabled={saving} style={ui.btn(colors, 'primary')}>{saving ? 'Guardando…' : 'Guardar ubicación'}</button>
      <button type="button" disabled={saving} style={actionStyle} onClick={() => setEditing(false)}>Cancelar</button>
    </div>
  </form>;
}
