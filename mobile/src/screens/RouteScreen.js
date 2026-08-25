import React, { useRef, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  Dimensions, Linking, Platform,
} from 'react-native';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';

const { height: SCREEN_H } = Dimensions.get('window');

const C = {
  bg:     '#0f172a',
  card:   '#1e293b',
  border: '#334155',
  green:  '#22c55e',
  orange: '#fb923c',
  blue:   '#38bdf8',
  text:   '#f1f5f9',
  muted:  '#94a3b8',
};

const STOP_COLORS = {
  pending:   C.orange,
  entregado: C.green,
  cancelled: '#f87171',
};

export default function RouteScreen({ route: navRoute, navigation }) {
  const { routeId, routeName, route: routeData } = navRoute.params;
  const { route: stops, totalDistance, totalDuration, optimized, stopStatuses: initialStatuses } = routeData;

  const mapRef = useRef(null);

  // Inicializar estados desde lo que viene del backend (stop_statuses de DB)
  const [stopStates, setStopStates] = useState(initialStatuses || {});

  function getStopKey(stop) {
    return `${stop.source}_${stop.id}`;
  }

  function getStopColor(stop) {
    const state = stopStates[getStopKey(stop)] || 'pending';
    return STOP_COLORS[state] || STOP_COLORS.pending;
  }

  function focusStop(stop) {
    if (stop.lat && stop.lng && mapRef.current) {
      mapRef.current.animateToRegion({
        latitude:      stop.lat,
        longitude:     stop.lng,
        latitudeDelta:  0.005,
        longitudeDelta: 0.005,
      }, 600);
    }
  }

  function openStopDetail(stop) {
    navigation.navigate('Stop', {
      stop,
      routeId,
      stopKey:    getStopKey(stop),
      stopNumber: stop.stopNumber,
      totalStops: stops.length,
      onComplete: (newStatus) => {
        setStopStates(prev => ({ ...prev, [getStopKey(stop)]: newStatus }));
      },
    });
  }

  function openFullRouteInMaps() {
    const addresses = stops.map(s => encodeURIComponent(s.fullAddress)).join('/');
    const url = Platform.OS === 'ios'
      ? `maps://maps.apple.com/?daddr=${encodeURIComponent(stops[stops.length - 1].fullAddress)}`
      : `https://www.google.com/maps/dir/${addresses}`;
    Linking.openURL(url);
  }

  const stopsWithCoords = stops.filter(s => s.lat && s.lng);
  const initialRegion   = stopsWithCoords.length > 0 ? {
    latitude:      stopsWithCoords.reduce((s, p) => s + p.lat, 0) / stopsWithCoords.length,
    longitude:     stopsWithCoords.reduce((s, p) => s + p.lng, 0) / stopsWithCoords.length,
    latitudeDelta:  0.08,
    longitudeDelta: 0.08,
  } : {
    latitude: -33.45, longitude: -70.65,
    latitudeDelta: 0.2, longitudeDelta: 0.2,
  };

  const doneCount   = Object.values(stopStates).filter(v => v === 'entregado').length;
  const failedCount = Object.values(stopStates).filter(v => v === 'cancelled').length;

  return (
    <View style={s.container}>
      {/* Mapa */}
      <View style={s.mapContainer}>
        <MapView
          ref={mapRef}
          style={s.map}
          provider={PROVIDER_GOOGLE}
          initialRegion={initialRegion}
          showsUserLocation
          showsMyLocationButton>

          {stops.map((stop) => {
            if (!stop.lat || !stop.lng) return null;
            const color = getStopColor(stop);
            return (
              <Marker
                key={getStopKey(stop)}
                coordinate={{ latitude: stop.lat, longitude: stop.lng }}
                onPress={() => openStopDetail(stop)}>
                <View style={[s.markerBubble, { backgroundColor: color }]}>
                  <Text style={s.markerNum}>{stop.stopNumber}</Text>
                </View>
              </Marker>
            );
          })}

          {stopsWithCoords.length >= 2 && (
            <Polyline
              coordinates={stopsWithCoords.map(s => ({ latitude: s.lat, longitude: s.lng }))}
              strokeColor={C.green}
              strokeWidth={3}
              lineDashPattern={[10, 5]}
            />
          )}
        </MapView>

        {/* Stats overlay */}
        <View style={s.statsOverlay}>
          {totalDistance ? <Text style={s.statText}>{totalDistance}</Text> : null}
          {totalDuration ? <Text style={s.statText}>{totalDuration}</Text> : null}
          <Text style={[s.statText, { color: C.green }]}>✓ {doneCount}/{stops.length}</Text>
          {!optimized && <Text style={[s.statText, { color: C.orange }]}>⚠ Sin optimizar</Text>}
        </View>
      </View>

      {/* Lista de paradas */}
      <View style={s.listContainer}>
        <View style={s.listHeader}>
          <Text style={s.listTitle}>Paradas ({stops.length})</Text>
          <TouchableOpacity onPress={openFullRouteInMaps} style={s.mapsBtn}>
            <Text style={s.mapsBtnText}>Abrir en Maps</Text>
          </TouchableOpacity>
        </View>

        <FlatList
          data={stops}
          keyExtractor={stop => getStopKey(stop)}
          renderItem={({ item: stop }) => {
            const state  = stopStates[getStopKey(stop)] || 'pending';
            const color  = getStopColor(stop);
            const isDone = state === 'entregado' || state === 'cancelled';
            return (
              <TouchableOpacity
                style={[s.stopCard, isDone && s.stopDone]}
                onPress={() => { focusStop(stop); openStopDetail(stop); }}
                activeOpacity={0.75}>
                <View style={[s.stopNum, { backgroundColor: color }]}>
                  <Text style={s.stopNumText}>{stop.stopNumber}</Text>
                </View>
                <View style={s.stopBody}>
                  <Text style={[s.stopName, isDone && s.textDone]} numberOfLines={1}>
                    {stop.customerName}
                  </Text>
                  <Text style={s.stopAddr} numberOfLines={1}>{stop.fullAddress}</Text>
                  {stop.durationText ? (
                    <Text style={s.stopTime}>{stop.distanceText} · {stop.durationText}</Text>
                  ) : null}
                </View>
                <View style={[s.badge, { backgroundColor: color + '22', borderColor: color + '44' }]}>
                  <Text style={[s.badgeText, { color }]}>
                    {state === 'entregado' ? 'Entregado' : state === 'cancelled' ? 'Fallido' : 'Pendiente'}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          }}
        />

        {(doneCount + failedCount) === stops.length && stops.length > 0 && (
          <View style={s.summary}>
            <Text style={s.summaryText}>
              🎉 Ruta completada: {doneCount} entregados · {failedCount} fallidos
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container:    { flex: 1, backgroundColor: C.bg },
  mapContainer: { height: SCREEN_H * 0.42, position: 'relative' },
  map:          { ...StyleSheet.absoluteFillObject },

  markerBubble: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#fff' },
  markerNum:    { color: '#fff', fontWeight: '800', fontSize: 13 },

  statsOverlay: {
    position: 'absolute', top: 56, right: 12,
    backgroundColor: 'rgba(15,23,42,0.85)', borderRadius: 10, padding: 10, gap: 4,
    borderWidth: 1, borderColor: C.border,
  },
  statText:     { color: C.muted, fontSize: 12, fontWeight: '600' },

  listContainer:{ flex: 1 },
  listHeader:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border },
  listTitle:    { color: C.text, fontWeight: '700', fontSize: 15 },
  mapsBtn:      { backgroundColor: C.blue + '22', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: C.blue + '44' },
  mapsBtnText:  { color: C.blue, fontSize: 12, fontWeight: '600' },

  stopCard:     { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border, gap: 12 },
  stopDone:     { opacity: 0.55 },
  stopNum:      { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  stopNumText:  { color: '#fff', fontWeight: '800', fontSize: 14 },
  stopBody:     { flex: 1, gap: 2 },
  stopName:     { color: C.text, fontWeight: '700', fontSize: 14 },
  textDone:     { textDecorationLine: 'line-through', color: C.muted },
  stopAddr:     { color: C.muted, fontSize: 12 },
  stopTime:     { color: C.blue, fontSize: 11 },
  badge:        { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1 },
  badgeText:    { fontSize: 11, fontWeight: '700' },

  summary:      { backgroundColor: C.card, margin: 16, borderRadius: 12, padding: 16, alignItems: 'center' },
  summaryText:  { color: C.text, fontWeight: '700', fontSize: 14, textAlign: 'center' },
});
