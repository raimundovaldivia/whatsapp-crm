/**
 * RouteScreen — Mapa y lista de paradas de una ruta.
 *
 * Recibe solo routeId por navegación y carga la ruta del backend. Se recarga
 * al volver desde StopScreen, así los estados marcados se reflejan sin pasar
 * callbacks (que React Navigation no puede serializar).
 *
 * El mapa se muestra solo si hay paradas con coordenadas (las agrega la
 * optimización con Google Maps). Sin coordenadas, la lista ocupa toda la
 * pantalla en vez de mostrar un mapa vacío de otra ciudad.
 */
import React, { useRef, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  Dimensions, Linking, Platform, ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import { getRoute } from '../services/api';

const { height: SCREEN_H } = Dimensions.get('window');

const C = {
  bg:     '#0f172a',
  card:   '#1e293b',
  border: '#334155',
  green:  '#22c55e',
  orange: '#fb923c',
  blue:   '#38bdf8',
  red:    '#f87171',
  text:   '#f1f5f9',
  muted:  '#94a3b8',
};

const STOP_COLORS = {
  pending:   C.orange,
  entregado: C.green,
  cancelled: C.red,
};

const PAY_LABEL = { efectivo: '💵 Efectivo', transferencia: '🏦 Transferencia', otro: 'Otro' };

function stopsOf(route) {
  const opt = Array.isArray(route?.optimized_route) ? route.optimized_route : [];
  if (opt.length > 0) return opt;
  const raw = Array.isArray(route?.orders) ? route.orders : [];
  return raw.map((o, i) => ({ ...o, stopNumber: i + 1 }));
}

const stopKeyOf = stop => `${stop.source}_${stop.id}`;

export default function RouteScreen({ route: navRoute, navigation }) {
  const { routeId } = navRoute.params;
  const mapRef = useRef(null);

  const [route,   setRoute]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await getRoute(routeId);
      setRoute(r);
      setError(null);
      if (r?.name) navigation.setOptions({ title: r.name });
    } catch (err) {
      if (err.response?.status !== 401) setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }, [routeId, navigation]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (loading && !route) {
    return (
      <View style={s.center}>
        <ActivityIndicator size="large" color={C.green} />
      </View>
    );
  }
  if (error && !route) {
    return (
      <View style={s.center}>
        <Text style={s.errorText}>{error}</Text>
        <TouchableOpacity style={s.retryBtn} onPress={load}><Text style={s.retryText}>Reintentar</Text></TouchableOpacity>
      </View>
    );
  }

  const stops      = stopsOf(route);
  const statuses   = route?.stop_statuses && typeof route.stop_statuses === 'object' ? route.stop_statuses : {};
  const payments   = route?.stop_payments && typeof route.stop_payments === 'object' ? route.stop_payments : {};
  const stateOf    = stop => statuses[stopKeyOf(stop)] || 'pending';
  const colorOf    = stop => STOP_COLORS[stateOf(stop)] || STOP_COLORS.pending;

  const stopsWithCoords = stops.filter(st => typeof st.lat === 'number' && typeof st.lng === 'number');
  const hasMap = stopsWithCoords.length > 0;

  const initialRegion = hasMap ? {
    latitude:       stopsWithCoords.reduce((acc, p) => acc + p.lat, 0) / stopsWithCoords.length,
    longitude:      stopsWithCoords.reduce((acc, p) => acc + p.lng, 0) / stopsWithCoords.length,
    latitudeDelta:  0.08,
    longitudeDelta: 0.08,
  } : null;

  const doneCount   = stops.filter(st => stateOf(st) === 'entregado').length;
  const failedCount = stops.filter(st => stateOf(st) === 'cancelled').length;
  const allDone     = stops.length > 0 && doneCount + failedCount === stops.length;

  // Próxima parada pendiente: se resalta para que el chofer no tenga que buscar
  const nextPending = stops.find(st => stateOf(st) === 'pending');

  function focusStop(stop) {
    if (hasMap && typeof stop.lat === 'number' && mapRef.current) {
      mapRef.current.animateToRegion({
        latitude: stop.lat, longitude: stop.lng, latitudeDelta: 0.005, longitudeDelta: 0.005,
      }, 600);
    }
  }

  function openStopDetail(stop) {
    navigation.navigate('Stop', {
      stop,
      routeId,
      stopKey:    stopKeyOf(stop),
      stopNumber: stop.stopNumber,
      totalStops: stops.length,
    });
  }

  function openFullRouteInMaps() {
    const addrs = stops.map(st => st.fullAddress).filter(Boolean);
    if (addrs.length === 0) return;
    const url = Platform.OS === 'ios'
      ? `maps://maps.apple.com/?daddr=${encodeURIComponent(addrs[addrs.length - 1])}`
      : `https://www.google.com/maps/dir/${addrs.map(encodeURIComponent).join('/')}`;
    Linking.openURL(url).catch(() =>
      Linking.openURL(`https://www.google.com/maps/dir/${addrs.map(encodeURIComponent).join('/')}`)
    );
  }

  return (
    <View style={s.container}>
      {/* Mapa (solo con coordenadas) */}
      {hasMap && (
        <View style={s.mapContainer}>
          <MapView
            ref={mapRef}
            style={s.map}
            // Google en Android (Expo Go trae su key; el build necesita la tuya).
            // En iOS se usa Apple Maps, que no requiere key.
            provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : undefined}
            initialRegion={initialRegion}
            showsUserLocation
            showsMyLocationButton>
            {stopsWithCoords.map(stop => (
              <Marker
                key={stopKeyOf(stop)}
                coordinate={{ latitude: stop.lat, longitude: stop.lng }}
                onPress={() => openStopDetail(stop)}>
                <View style={[s.markerBubble, { backgroundColor: colorOf(stop) }]}>
                  <Text style={s.markerNum}>{stop.stopNumber}</Text>
                </View>
              </Marker>
            ))}
            {stopsWithCoords.length >= 2 && (
              <Polyline
                coordinates={stopsWithCoords.map(st => ({ latitude: st.lat, longitude: st.lng }))}
                strokeColor={C.green}
                strokeWidth={3}
                lineDashPattern={[10, 5]}
              />
            )}
          </MapView>

          <View style={s.statsOverlay}>
            {!!route.total_distance && <Text style={s.statText}>{route.total_distance}</Text>}
            {!!route.total_duration && <Text style={s.statText}>{route.total_duration}</Text>}
            <Text style={[s.statText, { color: C.green }]}>✓ {doneCount}/{stops.length}</Text>
          </View>
        </View>
      )}

      {/* Lista de paradas */}
      <View style={s.listContainer}>
        <View style={s.listHeader}>
          <Text style={s.listTitle}>
            Paradas ({stops.length}){!hasMap ? `  ·  ✓ ${doneCount}/${stops.length}` : ''}
          </Text>
          <TouchableOpacity onPress={openFullRouteInMaps} style={s.mapsBtn}>
            <Text style={s.mapsBtnText}>Abrir en Maps</Text>
          </TouchableOpacity>
        </View>

        <FlatList
          data={stops}
          keyExtractor={stopKeyOf}
          refreshing={loading}
          onRefresh={load}
          renderItem={({ item: stop }) => {
            const state  = stateOf(stop);
            const color  = colorOf(stop);
            const isDone = state !== 'pending';
            const isNext = nextPending && stopKeyOf(nextPending) === stopKeyOf(stop);
            const pay    = payments[stopKeyOf(stop)];
            return (
              <TouchableOpacity
                style={[s.stopCard, isDone && s.stopDone, isNext && s.stopNext]}
                onPress={() => { focusStop(stop); openStopDetail(stop); }}
                activeOpacity={0.75}>
                <View style={[s.stopNum, { backgroundColor: color }]}>
                  <Text style={s.stopNumText}>{stop.stopNumber}</Text>
                </View>
                <View style={s.stopBody}>
                  <Text style={[s.stopName, isDone && s.textDone]} numberOfLines={1}>
                    {stop.customerName}
                  </Text>
                  <Text style={s.stopAddr} numberOfLines={1}>{stop.fullAddress || 'Sin dirección'}</Text>
                  {stop.durationText ? (
                    <Text style={s.stopTime}>{stop.distanceText} · {stop.durationText}</Text>
                  ) : null}
                  {isDone && pay ? (
                    <Text style={s.stopPay}>{PAY_LABEL[pay] || pay}</Text>
                  ) : null}
                </View>
                <View style={[s.badge, { backgroundColor: color + '22', borderColor: color + '44' }]}>
                  <Text style={[s.badgeText, { color }]}>
                    {state === 'entregado' ? 'Entregado' : state === 'cancelled' ? 'Fallido' : isNext ? 'Siguiente' : 'Pendiente'}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          }}
          ListFooterComponent={allDone ? (
            <View style={s.summary}>
              <Text style={s.summaryText}>
                🎉 Ruta completada: {doneCount} entregados · {failedCount} fallidos
              </Text>
            </View>
          ) : null}
        />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container:    { flex: 1, backgroundColor: C.bg },
  center:       { flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  errorText:    { color: C.red, fontSize: 14, textAlign: 'center' },
  retryBtn:     { backgroundColor: C.card, borderRadius: 10, paddingHorizontal: 20, paddingVertical: 10, borderWidth: 1, borderColor: C.border },
  retryText:    { color: C.text, fontWeight: '600' },

  mapContainer: { height: SCREEN_H * 0.38, position: 'relative' },
  map:          { ...StyleSheet.absoluteFillObject },

  markerBubble: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#fff' },
  markerNum:    { color: '#fff', fontWeight: '800', fontSize: 13 },

  statsOverlay: {
    position: 'absolute', top: 12, right: 12,
    backgroundColor: 'rgba(15,23,42,0.85)', borderRadius: 10, padding: 10, gap: 4,
    borderWidth: 1, borderColor: C.border,
  },
  statText:     { color: C.muted, fontSize: 12, fontWeight: '600' },

  listContainer:{ flex: 1 },
  listHeader:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border },
  listTitle:    { color: C.text, fontWeight: '700', fontSize: 15 },
  mapsBtn:      { backgroundColor: C.blue + '22', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: C.blue + '44' },
  mapsBtnText:  { color: C.blue, fontSize: 12, fontWeight: '600' },

  stopCard:     { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.border, gap: 12 },
  stopDone:     { opacity: 0.55 },
  stopNext:     { backgroundColor: C.orange + '12', borderLeftWidth: 3, borderLeftColor: C.orange },
  stopNum:      { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  stopNumText:  { color: '#fff', fontWeight: '800', fontSize: 14 },
  stopBody:     { flex: 1, gap: 2 },
  stopName:     { color: C.text, fontWeight: '700', fontSize: 15 },
  textDone:     { textDecorationLine: 'line-through', color: C.muted },
  stopAddr:     { color: C.muted, fontSize: 12 },
  stopTime:     { color: C.blue, fontSize: 11 },
  stopPay:      { color: C.muted, fontSize: 11, marginTop: 2 },
  badge:        { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1 },
  badgeText:    { fontSize: 11, fontWeight: '700' },

  summary:      { backgroundColor: C.card, margin: 16, borderRadius: 12, padding: 16, alignItems: 'center' },
  summaryText:  { color: C.text, fontWeight: '700', fontSize: 14, textAlign: 'center' },
});
