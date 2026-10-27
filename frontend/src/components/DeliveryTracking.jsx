import React, { useEffect } from 'react';
import './delivery-tracking.css';
import OrderStatusLookup from './OrderStatusLookup.jsx';
import LiveDeliveryMap from './LiveDeliveryMap.jsx';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

export default function DeliveryTracking({ token, lookup }) {
  useEffect(() => { document.title = 'Seguimiento de tu pedido'; }, []);
  if (lookup) return <OrderStatusLookup backendUrl={BACKEND_URL} storeSlug={lookup.storeSlug} />;
  return <main className="delivery-tracking-page">
    <div className="delivery-tracking-card">
      <p className="delivery-tracking-eyebrow">Seguimiento de tu pedido</p>
      <h1>Tu entrega</h1>
      <LiveDeliveryMap key={token} backendUrl={BACKEND_URL} token={token} />
      <a className="order-lookup-back" href="/seguimiento">Consultar un pedido por teléfono</a>
    </div>
  </main>;
}
