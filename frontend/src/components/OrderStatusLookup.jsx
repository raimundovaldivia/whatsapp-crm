import React, { useEffect, useRef, useState } from 'react';
import { fetchOrderStatus } from '../utils/delivery-tracking.mjs';

export default function OrderStatusLookup({ backendUrl, storeSlug }) {
  const [phone, setPhone] = useState('');
  const [orderNumber, setOrderNumber] = useState('');
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef(null);
  useEffect(() => () => request.current?.abort(), []);

  function edit(setter, value) {
    request.current?.abort();
    request.current = null;
    setter(value);
    setOrder(null);
    setError('');
    setBusy(false);
  }

  async function submit(event) {
    event.preventDefault();
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setOrder(null);
    setError('');
    try {
      const result = await fetchOrderStatus(backendUrl, {
        phone, orderNumber, ...(storeSlug ? { storeSlug } : { hostname: window.location.hostname }),
      }, controller.signal);
      if (!controller.signal.aborted) setOrder(result);
    } catch (err) {
      if (!controller.signal.aborted) setError(err.message || 'No pudimos consultar el pedido. Inténtalo nuevamente.');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <main className="delivery-tracking-page">
    <div className="delivery-tracking-card order-lookup-card">
      <a className="order-lookup-back" href={storeSlug ? `/tienda/${storeSlug}` : '/'}>← Volver a la tienda</a>
      <p className="delivery-tracking-eyebrow">Seguimiento de tu pedido</p>
      <h1>¿Cómo va tu pedido?</h1>
      <p className="order-lookup-intro">Ingresa el teléfono que usaste al comprar y el número que recibiste al confirmar tu pedido.</p>
      <form className="order-lookup-form" onSubmit={submit} aria-busy={busy}>
        <label htmlFor="lookup-phone">Teléfono</label>
        <input id="lookup-phone" name="phone" type="tel" autoComplete="tel" required maxLength={30}
          placeholder="Ej. +56 9 1234 5678" value={phone} onChange={e => edit(setPhone, e.target.value)} />
        <label htmlFor="lookup-order">Número de pedido</label>
        <input id="lookup-order" name="orderNumber" type="text" autoComplete="off" required maxLength={40}
          placeholder="Ej. DR-123 o #1234" value={orderNumber} onChange={e => edit(setOrderNumber, e.target.value)} aria-describedby="lookup-help" />
        <p id="lookup-help" className="delivery-tracking-note">Lo encontrarás en el mensaje o correo de confirmación de tu compra.</p>
        <button type="submit" disabled={busy}>{busy ? 'Buscando tu pedido…' : 'Consultar mi pedido'}</button>
      </form>
      {error && <p className="order-lookup-error" role="alert">{error}</p>}
      {order && <section className="order-lookup-result" role="status" aria-live="polite" aria-label="Estado del pedido">
        <p className="delivery-tracking-eyebrow">{order.storeName}</p>
        <h2>Pedido {order.orderNumber}</h2>
        <p className={`order-lookup-badge order-lookup-badge-${order.status}`}>{order.statusLabel}</p>
        <dl>
          {order.orderedDate && <><dt>Fecha del pedido</dt><dd>{order.orderedDate}</dd></>}
          {order.deliveryDate && <><dt>Fecha de entrega registrada</dt><dd>{order.deliveryDate}</dd></>}
        </dl>
        {!order.deliveryDate && !['delivered', 'partial', 'cancelled'].includes(order.status) && <p>La fecha de entrega aún está por confirmar.</p>}
        {order.status === 'in_transit' && <p>Si recibiste un enlace de reparto por WhatsApp, ábrelo para ver la ubicación.</p>}
      </section>}
      <p className="delivery-tracking-note">Consultamos solo el pedido que indiques. No necesitas crear una cuenta.</p>
    </div>
  </main>;
}
