import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { fetchTrackingStatus } from '../utils/delivery-tracking.mjs';
import './delivery-tracking.css';
import OrderStatusLookup from './OrderStatusLookup.jsx';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

export default function DeliveryTracking({ token, lookup }) {
  if (lookup) return <OrderStatusLookup backendUrl={BACKEND_URL} storeSlug={lookup.storeSlug} />;
  return <LiveDeliveryTracking token={token} />;
}

function LiveDeliveryTracking({ token }) {
  const [state, setState] = useState(null);
  const [failed, setFailed] = useState(false);
  const mapElement = useRef(null);
  const map = useRef(null);
  const marker = useRef(null);

  useEffect(() => {
    document.title = 'Seguimiento de tu pedido';
    let cancelled = false;
    let timer;
    const controller = new AbortController();
    const refresh = async () => {
      let active = true;
      try {
        const next = await fetchTrackingStatus(BACKEND_URL, token, controller.signal);
        if (cancelled) return;
        setState(next);
        setFailed(false);
        active = next.active;
      } catch {
        if (cancelled) return;
        setFailed(true);
      }
      if (!cancelled && active) timer = setTimeout(refresh, 15000);
    };
    refresh();
    return () => { cancelled = true; controller.abort(); clearTimeout(timer); };
  }, [token]);

  useEffect(() => {
    const hasLocation = state?.active && Number.isFinite(state.latitude) && Number.isFinite(state.longitude);
    if (!hasLocation) {
      map.current?.remove();
      map.current = null;
      marker.current = null;
      return;
    }
    const point = [state.latitude, state.longitude];
    if (!map.current) {
      map.current = L.map(mapElement.current).setView(point, 15);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap', maxZoom: 19, referrerPolicy: 'origin',
      }).addTo(map.current);
      marker.current = L.circleMarker(point, {
        radius: 10, color: '#fff', weight: 3, fillColor: '#173b2b', fillOpacity: 1,
      }).addTo(map.current);
    } else {
      marker.current.setLatLng(point);
      map.current.panTo(point);
    }
  }, [state]);

  useEffect(() => () => { map.current?.remove(); map.current = null; marker.current = null; }, []);

  const age = state?.updatedAt ? Math.max(0, Math.round((Date.now() - Date.parse(state.updatedAt)) / 60000)) : null;
  const status = failed ? 'No pudimos actualizar la ubicación. Reintentaremos automáticamente.'
    : !state ? 'Buscando la ubicación del repartidor…'
      : state.status === 'invalid' ? 'El enlace no es válido o ya no está disponible.'
        : !state.active ? (state.status === 'delivered' ? 'Pedido entregado ✅' : 'El seguimiento ya finalizó.')
          : state.latitude == null ? 'El reparto comenzó. Esperando la primera ubicación…'
            : age == null ? 'Ubicación del repartidor' : age < 1 ? 'Ubicación actualizada recién' : `Ubicación actualizada hace ${age} min`;
  const showMap = Boolean(state?.active && Number.isFinite(state.latitude) && Number.isFinite(state.longitude));

  return <main className="delivery-tracking-page">
    <div className="delivery-tracking-card">
      <p className="delivery-tracking-eyebrow">Seguimiento de tu pedido</p>
      <h1>{state && !state.active ? 'Tu entrega' : 'Tu pedido va en camino 🚚'}</h1>
      <p role="status" aria-live="polite">{status}</p>
      <div ref={mapElement} className="delivery-tracking-map" hidden={!showMap} aria-label="Ubicación del repartidor" />
      {(!state || state.active) && <p className="delivery-tracking-note">La ubicación se actualiza mientras el repartidor mantiene activa la app de despacho. El enlace deja de funcionar al cerrar la entrega.</p>}
      <a className="order-lookup-back" href="/seguimiento">Consultar un pedido por teléfono</a>
    </div>
  </main>;
}
