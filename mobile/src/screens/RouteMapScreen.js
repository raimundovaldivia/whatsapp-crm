import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { getRoute } from '../services/api';
import { stopLabel } from '../utils/stopLabel';

const C = { bg: '#0f172a', card: '#1e293b', border: '#334155', green: '#22c55e', orange: '#fb923c', blue: '#38bdf8', text: '#f1f5f9', muted: '#94a3b8' };

function stopsOf(route) {
  const optimized = Array.isArray(route?.optimized_route) ? route.optimized_route : [];
  if (optimized.length) return optimized;
  return (Array.isArray(route?.orders) ? route.orders : []).map((stop, index) => ({ ...stop, stopNumber: index + 1 }));
}

function mapHtml(stops, statuses, labelMode) {
  const points = stops
    .map((stop, index) => ({
      lat: Number(stop.lat),
      lng: Number(stop.lng),
      label: String(stopLabel(stop.stopNumber || index + 1, labelMode)),
      name: String(stop.customerName || `Parada ${index + 1}`),
      address: String(stop.fullAddress || 'Sin dirección'),
      status: statuses[`${stop.source}_${stop.id}`] || 'pending',
    }))
    .filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lng));
  const safePoints = JSON.stringify(points).replace(/</g, '\\u003c');
  return `<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
html,body,#map{height:100%;margin:0;background:#0f172a} .leaflet-control-attribution{font-size:9px}
.pin{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font:800 12px system-ui;border:2px solid #fff;box-shadow:0 2px 7px #0008;background:#fb923c}
.pin.done{background:#22c55e}.pin.failed{background:#f87171}.pin.postponed{background:#a78bfa}.leaflet-popup-content{font:13px system-ui;line-height:1.35}.leaflet-popup-content b{font-size:14px}
</style></head><body><div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const points=${safePoints};
const map=L.map('map',{zoomControl:true});
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map);
const coords=[];
points.forEach(p=>{
  coords.push([p.lat,p.lng]);
  const state=p.status==='entregado'?'done':p.status==='cancelled'||p.status==='not_delivered'?'failed':p.status==='postponed'?'postponed':'';
  const icon=L.divIcon({className:'',html:'<div class="pin '+state+'">'+p.label+'</div>',iconSize:[30,30],iconAnchor:[15,15]});
  L.marker([p.lat,p.lng],{icon}).addTo(map).bindPopup('<b>'+escapeHtml(p.label+'. '+p.name)+'</b><br>'+escapeHtml(p.address));
});
if(coords.length>1)L.polyline(coords,{color:'#38bdf8',weight:4,opacity:.8,dashArray:'9,7'}).addTo(map);
if(coords.length)map.fitBounds(coords,{padding:[32,32],maxZoom:15});else map.setView([-29.9027,-71.2519],12);
function escapeHtml(value){return value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}
</script></body></html>`;
}

export default function RouteMapScreen({ route: navRoute, navigation }) {
  const { routeId, routeName, labelMode = 'numbers' } = navRoute.params || {};
  const insets = useSafeAreaInsets();
  const webRef = useRef(null);
  const [deliveryRoute, setDeliveryRoute] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const value = await getRoute(routeId);
      setDeliveryRoute(value);
      setError('');
      navigation.setOptions({ title: value?.name || routeName || 'Mapa de la ruta' });
    } catch (err) {
      setError(err.response?.data?.error || 'No se pudo cargar la ruta');
    } finally { setLoading(false); }
  }, [routeId, routeName, navigation]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const stops = stopsOf(deliveryRoute);
  const statuses = deliveryRoute?.stop_statuses && typeof deliveryRoute.stop_statuses === 'object' ? deliveryRoute.stop_statuses : {};
  const located = stops.filter(stop => Number.isFinite(Number(stop.lat)) && Number.isFinite(Number(stop.lng)));
  const html = useMemo(() => mapHtml(stops, statuses, labelMode), [JSON.stringify(stops), JSON.stringify(statuses), labelMode]);
  const next = stops.find(stop => !statuses[`${stop.source}_${stop.id}`] || statuses[`${stop.source}_${stop.id}`] === 'pending');

  function navigateNext() {
    if (!next?.fullAddress) return Alert.alert('Sin dirección', 'La siguiente parada no tiene una dirección válida.');
    const url = PlatformSelectMaps(next.fullAddress);
    Linking.openURL(url).catch(() => Alert.alert('No se pudo abrir Maps', 'Revisa que Google Maps esté instalado.'));
  }

  if (loading && !deliveryRoute) return <View style={s.center}><ActivityIndicator size="large" color={C.green} /></View>;
  if (error && !deliveryRoute) return <View style={s.center}><Text style={s.error}>{error}</Text><TouchableOpacity style={s.retry} onPress={load}><Text style={s.retryText}>Reintentar</Text></TouchableOpacity></View>;

  return (
    <View style={[s.container, { paddingBottom: insets.bottom }]}> 
      <View style={s.summary}>
        <View style={{ flex: 1 }}>
          <Text style={s.summaryTitle}>{stops.length} paradas en orden</Text>
          <Text style={s.summaryText}>{located.length === stops.length ? 'Todas ubicadas en el mapa' : `${located.length} ubicadas · ${stops.length - located.length} sin coordenadas`}</Text>
        </View>
        <TouchableOpacity style={s.centerBtn} onPress={() => webRef.current?.reload()}><Text style={s.centerBtnText}>Centrar</Text></TouchableOpacity>
      </View>
      <WebView
        ref={webRef}
        source={{ html }}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        style={s.map}
        startInLoadingState
        renderLoading={() => <View style={s.mapLoading}><ActivityIndicator color={C.green} /><Text style={s.loadingText}>Cargando mapa…</Text></View>}
      />
      {next && (
        <View style={s.footer}>
          <View style={{ flex: 1 }}>
            <Text style={s.nextLabel}>SIGUIENTE PARADA</Text>
            <Text style={s.nextName} numberOfLines={1}>{stopLabel(next.stopNumber, labelMode)}. {next.customerName}</Text>
            <Text style={s.nextAddress} numberOfLines={1}>{next.fullAddress || 'Sin dirección registrada'}</Text>
          </View>
          <TouchableOpacity style={s.navigateBtn} onPress={navigateNext}><Text style={s.navigateText}>Abrir navegación</Text></TouchableOpacity>
        </View>
      )}
    </View>
  );
}

function PlatformSelectMaps(address) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}&travelmode=driving`;
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24, backgroundColor: C.bg },
  error: { color: '#f87171', textAlign: 'center' },
  retry: { borderWidth: 1, borderColor: C.border, borderRadius: 10, paddingHorizontal: 18, paddingVertical: 10 },
  retryText: { color: C.text, fontWeight: '700' },
  summary: { minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 15, borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.card },
  summaryTitle: { color: C.text, fontSize: 15, fontWeight: '800' },
  summaryText: { color: C.muted, fontSize: 11, marginTop: 3 },
  centerBtn: { borderWidth: 1, borderColor: C.blue + '66', backgroundColor: C.blue + '1f', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 9 },
  centerBtnText: { color: C.blue, fontSize: 12, fontWeight: '700' },
  map: { flex: 1, backgroundColor: C.bg },
  mapLoading: { ...StyleSheet.absoluteFillObject, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', gap: 10 },
  loadingText: { color: C.muted, fontSize: 12 },
  footer: { minHeight: 82, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 15, paddingVertical: 10, backgroundColor: C.card, borderTopWidth: 1, borderTopColor: C.border },
  nextLabel: { color: C.muted, fontSize: 10, fontWeight: '700', letterSpacing: .7 },
  nextName: { color: C.text, fontSize: 14, fontWeight: '800', marginTop: 3 },
  nextAddress: { color: C.muted, fontSize: 11, marginTop: 3 },
  navigateBtn: { backgroundColor: C.blue, borderRadius: 11, paddingHorizontal: 17, paddingVertical: 11 },
  navigateText: { color: '#082f49', fontSize: 13, fontWeight: '900' },
});
