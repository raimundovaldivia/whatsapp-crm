/**
 * OrdersScreen — Rutas asignadas al repartidor.
 *
 * Muestra TODAS las rutas activas del chofer (puede tener más de una en el
 * día: mañana y tarde). Se refresca sola cada vez que la pantalla vuelve al
 * frente, así el progreso marcado en StopScreen se ve al regresar sin pasar
 * callbacks por la navegación.
 */
import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ActivityIndicator, ScrollView, RefreshControl, Alert,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getActiveRoutes } from '../services/api';
import UpdateStatus from '../components/UpdateStatus';
import { flushExpenses } from '../utils/expenseQueue';

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

const STATUS_LABEL = {
  draft:       'Borrador',
  sent:        'Nueva',
  in_progress: 'En curso',
  completed:   'Completada',
  cancelled:   'Cancelada',
};
const STATUS_COLOR = {
  draft:       C.muted,
  sent:        C.blue,
  in_progress: C.orange,
  completed:   C.green,
  cancelled:   C.red,
};

/** Paradas de una ruta: optimized_route si existe, si no los pedidos en orden. */
function stopsOf(route) {
  const opt = Array.isArray(route?.optimized_route) ? route.optimized_route : [];
  if (opt.length > 0) return opt;
  const raw = Array.isArray(route?.orders) ? route.orders : [];
  return raw.map((o, i) => ({ ...o, stopNumber: i + 1 }));
}

function summarize(route) {
  const stops    = stopsOf(route);
  const statuses = route?.stop_statuses && typeof route.stop_statuses === 'object' ? route.stop_statuses : {};
  const done = stops.filter(s => statuses[`${s.source}_${s.id}`] === 'entregado').length;
  const fail = stops.filter(s => statuses[`${s.source}_${s.id}`] === 'cancelled').length;
  const pend = stops.length - done - fail;
  const pct  = stops.length > 0 ? Math.round(((done + fail) / stops.length) * 100) : 0;
  return { stops, statuses, done, fail, pend, pct };
}

export default function OrdersScreen({ navigation, user, onLogout }) {
  const insets = useSafeAreaInsets();
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [routes,     setRoutes]     = useState([]);
  const [error,      setError]      = useState(null);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const data = await getActiveRoutes();
      setRoutes(data.routes || []);
    } catch (err) {
      if (err.response?.status !== 401) {
        setError(err.response?.data?.error || err.message || 'Error de conexión');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Recargar cada vez que la pantalla vuelve al frente
  useFocusEffect(useCallback(() => {
    load();
    // Gastos que quedaron sin subir por falta de señal: reintentar al abrir
    flushExpenses().then(r => { if (r.uploaded > 0) Alert.alert('Gastos subidos', `Se subieron ${r.uploaded} gasto(s) pendientes ✅`); }).catch(() => {});
  }, [load]));

  function openRoute(route) {
    const stops = stopsOf(route);
    if (stops.length === 0) {
      Alert.alert('Ruta vacía', 'Esta ruta no tiene paradas.');
      return;
    }
    navigation.navigate('Route', { routeId: route.id, routeName: route.name });
  }

  function handleLogout() {
    Alert.alert('Cerrar sesión', '¿Salir de la aplicación?', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Salir', style: 'destructive', onPress: () => onLogout?.() },
    ]);
  }

  const firstName = (user?.name || '').trim().split(/\s+/)[0];

  return (
    <View style={[s.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={s.header}>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle}>🚚 Mis rutas</Text>
          <Text style={s.headerSub}>{firstName ? `Hola ${firstName}` : 'Rutas asignadas'}</Text>
        </View>
        <TouchableOpacity onPress={() => navigation.navigate('History')} style={s.histBtn}>
          <Text style={s.histText}>🗂️ Historial</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={handleLogout} style={s.logoutBtn}>
          <Text style={s.logoutText}>Salir</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={s.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.green} />}
        contentContainerStyle={s.scrollContent}>

        {loading && (
          <View style={s.center}>
            <ActivityIndicator size="large" color={C.green} />
            <Text style={s.centerText}>Buscando rutas asignadas...</Text>
          </View>
        )}

        {!loading && error && (
          <View style={s.errorBox}>
            <Text style={s.errorIcon}>⚠️</Text>
            <Text style={s.errorText}>{error}</Text>
            <TouchableOpacity style={s.retryBtn} onPress={() => load()}>
              <Text style={s.retryText}>Reintentar</Text>
            </TouchableOpacity>
          </View>
        )}

        {!loading && !error && routes.length === 0 && (
          <View style={s.emptyBox}>
            <Text style={s.emptyIcon}>📭</Text>
            <Text style={s.emptyTitle}>Sin rutas por ahora</Text>
            <Text style={s.emptyText}>
              Cuando te asignen un reparto desde el CRM, va a aparecer aquí. Desliza hacia abajo para actualizar.
            </Text>
            <TouchableOpacity style={s.refreshBtn} onPress={() => load(true)}>
              <Text style={s.refreshText}>Actualizar</Text>
            </TouchableOpacity>
          </View>
        )}

        {!loading && !error && routes.map(route => {
          const { stops, statuses, done, fail, pend, pct } = summarize(route);
          const color = STATUS_COLOR[route.status] || C.muted;
          const isActive = route.status === 'sent' || route.status === 'in_progress';
          return (
            <TouchableOpacity key={route.id} style={s.routeCard} onPress={() => openRoute(route)} activeOpacity={0.85}>
              <View style={s.routeHeader}>
                <Text style={s.routeName} numberOfLines={2}>{route.name}</Text>
                <View style={[s.statusBadge, { backgroundColor: color + '22', borderColor: color + '55' }]}>
                  <Text style={[s.statusText, { color }]}>{STATUS_LABEL[route.status] || route.status}</Text>
                </View>
              </View>

              <View style={s.statsRow}>
                <View style={s.statItem}>
                  <Text style={s.statNum}>{stops.length}</Text>
                  <Text style={s.statLabel}>Paradas</Text>
                </View>
                {!!route.total_distance && (
                  <View style={s.statItem}>
                    <Text style={s.statNum}>{route.total_distance}</Text>
                    <Text style={s.statLabel}>Distancia</Text>
                  </View>
                )}
                {!!route.total_duration && (
                  <View style={s.statItem}>
                    <Text style={s.statNum}>{route.total_duration}</Text>
                    <Text style={s.statLabel}>Tiempo</Text>
                  </View>
                )}
              </View>

              {stops.length > 0 && (
                <View style={s.progressSection}>
                  <View style={s.progressBar}>
                    <View style={[s.progressFill, { width: `${pct}%` }]} />
                  </View>
                  <Text style={s.progressText}>
                    {done} entregados · {fail} fallidos · {pend} pendientes
                  </Text>
                </View>
              )}

              {/* Próximas paradas */}
              {stops.length > 0 && (
                <View style={s.stopsPreview}>
                  {stops.slice(0, 4).map((stop, idx) => {
                    const st = statuses[`${stop.source}_${stop.id}`] || 'pending';
                    const c  = st === 'entregado' ? C.green : st === 'cancelled' ? C.red : C.orange;
                    return (
                      <View key={`${stop.source}_${stop.id}`} style={s.stopRow}>
                        <View style={[s.stopNum, { backgroundColor: c }]}>
                          <Text style={s.stopNumText}>{stop.stopNumber || idx + 1}</Text>
                        </View>
                        <Text style={[s.stopName, st !== 'pending' && s.textDim]} numberOfLines={1}>
                          {stop.customerName}
                        </Text>
                        <Text style={[s.stopStatus, { color: c }]}>
                          {st === 'entregado' ? '✓' : st === 'cancelled' ? '✕' : '•'}
                        </Text>
                      </View>
                    );
                  })}
                  {stops.length > 4 && (
                    <Text style={s.moreStops}>+{stops.length - 4} más</Text>
                  )}
                </View>
              )}

              {isActive && (
                <View style={s.startBtn}>
                  <Text style={s.startBtnText}>
                    {route.status === 'in_progress' ? '▶  Continuar reparto' : '▶  Comenzar reparto'}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          );
        })}
        <UpdateStatus style={{ marginBottom: 24 }} />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container:    { flex: 1, backgroundColor: C.bg },
  header:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 12, paddingBottom: 14, paddingHorizontal: 20, borderBottomWidth: 1, borderBottomColor: C.border },
  headerTitle:  { color: C.text, fontSize: 22, fontWeight: '800' },
  headerSub:    { color: C.muted, fontSize: 13, marginTop: 2 },
  logoutBtn:    { backgroundColor: C.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  logoutText:   { color: C.muted, fontSize: 13, fontWeight: '600' },
  histBtn:      { backgroundColor: C.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, marginRight: 8 },
  histText:     { color: C.text, fontSize: 13, fontWeight: '700' },

  scroll:       { flex: 1 },
  scrollContent:{ padding: 16, gap: 14, paddingBottom: 40 },

  center:       { paddingVertical: 80, alignItems: 'center', gap: 12 },
  centerText:   { color: C.muted, fontSize: 14 },

  errorBox:     { alignItems: 'center', paddingVertical: 60, gap: 12 },
  errorIcon:    { fontSize: 40 },
  errorText:    { color: C.red, fontSize: 14, textAlign: 'center', paddingHorizontal: 20 },
  retryBtn:     { backgroundColor: C.card, borderRadius: 10, paddingHorizontal: 20, paddingVertical: 10, borderWidth: 1, borderColor: C.border },
  retryText:    { color: C.text, fontWeight: '600' },

  emptyBox:     { alignItems: 'center', paddingVertical: 80, gap: 12 },
  emptyIcon:    { fontSize: 56 },
  emptyTitle:   { color: C.text, fontSize: 20, fontWeight: '800' },
  emptyText:    { color: C.muted, fontSize: 14, textAlign: 'center', paddingHorizontal: 32, lineHeight: 20 },
  refreshBtn:   { backgroundColor: C.green, borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12, marginTop: 8 },
  refreshText:  { color: '#fff', fontWeight: '700', fontSize: 15 },

  routeCard:    { backgroundColor: C.card, borderRadius: 16, padding: 18, borderWidth: 1, borderColor: C.border, gap: 12 },
  routeHeader:  { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 },
  routeName:    { color: C.text, fontSize: 18, fontWeight: '800', flex: 1 },
  statusBadge:  { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1 },
  statusText:   { fontSize: 12, fontWeight: '700' },

  statsRow:     { flexDirection: 'row', gap: 10 },
  statItem:     { flex: 1, backgroundColor: C.bg, borderRadius: 10, padding: 10, alignItems: 'center' },
  statNum:      { color: C.text, fontSize: 16, fontWeight: '800' },
  statLabel:    { color: C.muted, fontSize: 11, marginTop: 2 },

  progressSection: { gap: 6 },
  progressBar:  { height: 6, backgroundColor: C.border, borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: C.green, borderRadius: 3 },
  progressText: { color: C.muted, fontSize: 11, textAlign: 'right' },

  stopsPreview: { gap: 8 },
  stopRow:      { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stopNum:      { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  stopNumText:  { color: '#fff', fontWeight: '800', fontSize: 11 },
  stopName:     { color: C.text, fontWeight: '600', fontSize: 14, flex: 1 },
  textDim:      { color: C.muted, textDecorationLine: 'line-through' },
  stopStatus:   { fontSize: 16, fontWeight: '800' },
  moreStops:    { color: C.muted, fontSize: 12, paddingLeft: 34 },

  startBtn:     { backgroundColor: C.green, borderRadius: 12, padding: 14, alignItems: 'center', marginTop: 2 },
  startBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
});
