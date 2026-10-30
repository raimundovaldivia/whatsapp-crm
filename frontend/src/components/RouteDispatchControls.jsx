import { useRef, useState } from 'react';
import { api } from '../utils/api.js';
import * as ui from '../ui.js';

export default function RouteDispatchControls({ route, loadReady, colors, onUpdated }) {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [payment, setPayment] = useState('');
  const [note, setNote] = useState('');
  const [notified, setNotified] = useState({});
  const stops = Array.isArray(route.optimized_route) && route.optimized_route.length
    ? route.optimized_route : (route.orders || []);
  const finished = new Set(['entregado', 'partial', 'cancelled', 'postponed', 'not_delivered']);

  async function run(action) {
    if (running.current) return;
    running.current = true; setBusy(true); setError(''); setMessage('');
    try { await action(); }
    catch (e) { setError(e.response?.data?.message || e.response?.data?.error || 'No se pudo guardar. Revisa el estado antes de reintentar.'); }
    finally { running.current = false; setBusy(false); }
  }

  const start = () => run(async () => {
    const { data } = await api.patch(`/delivery/routes/${route.id}/start`);
    onUpdated(data.route);
    const notices = data.customerNotifications;
    setMessage(`Reparto iniciado. Avisos enviados: ${notices?.sent || 0}. Avisos fallidos: ${notices?.failed || 0}.`);
    if (notices?.failed) setError('La ruta comenzó, pero algunos avisos fallaron. Revisa el chat de esos clientes.');
  });

  const notify = stopKey => run(async () => {
    const { data } = await api.post(`/delivery/routes/${route.id}/notify-en-route`, { stopKey });
    if (!data.sent) throw new Error('Aviso no enviado');
    setNotified(previous => ({ ...previous, [stopKey]: true }));
    setMessage('Aviso de pedido en camino enviado a WhatsApp.');
  });

  const deliver = event => {
    event.preventDefault();
    return run(async () => {
      const { data } = await api.patch(`/delivery/routes/${route.id}/stops`, {
        stopKey: selected, status: 'entregado', note,
        ...(payment ? { paymentMethod: payment } : {}),
      });
      onUpdated({ ...route, status: data.routeStatus, stop_statuses: data.stopStatuses,
        stop_payments: data.stopPayments, stop_payment_amounts: data.stopPaymentAmounts });
      setSelected(null); setNote(''); setPayment('');
      setMessage(data.routeStatus === 'completed' ? 'Entrega registrada. Ruta completada.' : 'Entrega registrada.');
      if (data.customerFollowup?.status === 'failed') setError('La entrega quedó registrada, pero falló el mensaje de seguimiento al cliente. Revisa su chat.');
    });
  };

  if (route.status === 'completed' && !message && !error) return null;
  return <section aria-label="Operar reparto" style={{ marginBottom: 16, padding: 14, border: `1px solid ${colors.border}`, borderRadius: 10 }}>
    <h3 style={{ margin: '0 0 8px', fontSize: 14, color: colors.textPrimary }}>Operar reparto</h3>
    {route.status === 'sent' && <>
      <p style={{ color: colors.textSecondary, fontSize: 12 }}>Al iniciar, los pedidos pasan a En camino y se avisa por WhatsApp a los clientes de esta ruta.</p>
      <button disabled={busy || !loadReady} onClick={start} style={ui.btn(colors, 'primary')}>Iniciar reparto y avisar</button>
      {!loadReady && <p style={{ color: colors.textMuted, fontSize: 12 }}>Completa la revisión de todos los productos de la carga para iniciar.</p>}
    </>}
    {route.status === 'in_progress' && stops.map((stop, index) => {
      const key = `${stop.source}_${stop.id}`;
      if (finished.has(route.stop_statuses?.[key])) return null;
      return <div key={key} style={{ padding: '10px 0', borderBottom: `1px solid ${colors.border}` }}>
        <div style={{ color: colors.textPrimary, fontWeight: 600 }}>{index + 1}. {stop.orderName || `#${stop.id}`} · {stop.customerName}</div>
        <p style={{ color: colors.textSecondary, fontSize: 12 }}>{stop.fullAddress || stop.address}</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button disabled={busy || notified[key]} onClick={() => notify(key)} style={ui.btn(colors, 'secondary')}>
            {notified[key] ? 'Aviso enviado' : 'Avisar que va en camino'}
          </button>
          <button disabled={busy} onClick={() => { setSelected(key); setPayment(''); setNote(''); }} style={ui.btn(colors, 'primary')}>Registrar entrega</button>
        </div>
        {selected === key && <form onSubmit={deliver} style={{ display: 'grid', gap: 10, marginTop: 12 }}>
          <label style={{ color: colors.textSecondary }}>Pago de esta entrega
            <select aria-label="Pago de esta entrega" value={payment} onChange={e => setPayment(e.target.value)} disabled={busy} style={{ ...ui.input(colors), width: '100%' }}>
              <option value="">Pago pendiente / sin cobro</option>
              <option value="efectivo">Efectivo recibido</option>
              <option value="transferencia">Transferencia por verificar</option>
            </select>
          </label>
          <label style={{ color: colors.textSecondary }}>Nota de entrega
            <textarea aria-label="Nota de entrega" value={note} maxLength={500} onChange={e => setNote(e.target.value)} disabled={busy} style={{ ...ui.input(colors), width: '100%' }} />
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" disabled={busy} style={ui.btn(colors, 'primary')}>Confirmar entrega</button>
            <button type="button" disabled={busy} onClick={() => setSelected(null)} style={ui.btn(colors, 'secondary')}>Volver</button>
          </div>
        </form>}
      </div>;
    })}
    {busy && <p role="status">Guardando…</p>}
    {message && <p role="status" style={{ color: colors.textPrimary, fontSize: 13 }}>{message}</p>}
    {error && <p role="alert" style={{ color: colors.red, fontSize: 13 }}>{error}</p>}
  </section>;
}
