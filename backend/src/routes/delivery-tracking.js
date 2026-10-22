const express = require('express');
const tracking = require('../services/delivery-tracking');

const router = express.Router();

router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

router.get('/:token/status', async (req, res) => {
  try {
    const state = await tracking.getTrackingStatus(req.params.token);
    if (!state) return res.status(404).json({ error: 'Enlace no válido' });
    return res.status(state.active ? 200 : 410).json(state);
  } catch (error) {
    console.error('[Delivery tracking] Estado no disponible:', error.message);
    return res.status(503).json({ error: 'Seguimiento temporalmente no disponible' });
  }
});

router.get('/:token', (req, res) => {
  if (!tracking.TOKEN_PATTERN.test(String(req.params.token || ''))) return res.status(404).send('Enlace no válido');
  res.set('Content-Security-Policy', "default-src 'none'; script-src 'self' https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src https://*.tile.openstreetmap.org data:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  res.type('html').send(`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Seguimiento de tu pedido</title><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>body{margin:0;font-family:system-ui,sans-serif;background:#f8fafc;color:#172033}.card{max-width:720px;margin:auto;padding:20px}h1{font-size:1.35rem;margin:0 0 8px}.status{margin:0 0 14px;color:#526174}#map{height:62vh;min-height:330px;border-radius:16px;background:#e7edf3}.note{font-size:.82rem;color:#68778b;margin-top:12px}</style></head>
<body><main class="card"><h1>Tu pedido va en camino 🚚</h1><p id="status" class="status">Buscando la ubicación del repartidor…</p><div id="map"></div><p class="note">La ubicación se actualiza mientras el repartidor mantiene activa la app de despacho. El enlace deja de funcionar al cerrar la entrega.</p></main>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><script>
const statusEl=document.getElementById('status');let map,marker;
async function refresh(){try{const r=await fetch(location.pathname+'/status',{cache:'no-store'});const s=await r.json();if(!r.ok||!s.active){statusEl.textContent=s.status==='delivered'?'Pedido entregado ✅':'El seguimiento ya finalizó.';return;}if(s.latitude==null){statusEl.textContent='El reparto comenzó. Esperando la primera ubicación…';return;}const p=[s.latitude,s.longitude];if(!map){map=L.map('map').setView(p,15);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap',maxZoom:19}).addTo(map);marker=L.marker(p).addTo(map);}else{marker.setLatLng(p);map.panTo(p);}const age=s.updatedAt?Math.max(0,Math.round((Date.now()-Date.parse(s.updatedAt))/60000)):0;statusEl.textContent=age<1?'Ubicación actualizada recién':('Ubicación actualizada hace '+age+' min');}catch{statusEl.textContent='No pudimos actualizar la ubicación. Reintentaremos automáticamente.';}}
refresh();setInterval(refresh,15000);
</script></body></html>`);
});

module.exports = router;
