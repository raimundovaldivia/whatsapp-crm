/**
 * OrdersScreen — Vista del repartidor.
 * Muestra la ruta asignada por el admin. No permite seleccionar pedidos.
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ActivityIndicator, ScrollView, RefreshControl, Alert,
} from 'react-native';
import { getActiveRoute, logout } from '../services/api';

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
  sent:        'Enviada',
  in_progress: 'En progreso',
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

export default function OrdersScreen({ navigation, onLogout }) {
  const [loading,      setLoading]      = useState(true);
  const [refreshing,   setRefreshing]   = useState(false);
  const [route,        setRoute]        = useState(null);
  const [error,        setError]        = useState(null);

  const loadRoute = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const data = await getActiveRoute();
      setRoute(data.route || null);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Error de conexión');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { loadRoute(); }, []);

  function handleStartRoute() {
    if (!route) return;
    const stops = Array.isArray(route.optimized_route) ? route.optimized_route : [];
    if (stops.length === 0) {
      Alert.alert('Ruta vacía', 'Esta ruta no tiene paradas con coordenadas aún.');
      return;
    }
    navigation.navigate('Route', {
      routeId:   route.id,
      routeName: route.name,
      route: {
        route:         stops,
        totalDistance: route.total_distance,
        totalDuration: route.total_duration,
        optimized:     true,
        stopStatuses:  typeof route.stop_statuses === 'object' ? route.stop_statuses : {},
      },
    });
  }

  async function handleLogout() {
    Alert.alert('Cerrar sesión', '¿Salir de la aplicación?', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Salir', style: 'destructive', onPress: async () => { await logout(); onLogout?.(); } },
    ]);
  }

  // ── Calcular resumen de paradas ──────────────────────────────────
  const stops      = route ? (Array.isArray(route.optimized_route) ? route.optimized_route : []) : [];
  const statuses   = route ? (typeof route.stop_statuses === 'object' ? route.stop_statuses : {}) : {};
  const doneCount  = stops.filter(s => statuses[`${s.source}_${s.id}`] === 'entregado').length;
  const failCount  = stops.filter(s => statuses[`${s.source}_${s.id}`] === 'cancelled').length;
  const pendCount  = stops.length - doneCount - failCount;
  const pct        = stops.length > 0 ? Math.round(((doneCount + failCount) / stops.length) * 100) : 0;

  return (
    <View style={s.container}>
      {/* Header */}
      <View style={s.header}>
        <View>
          <Text style={s.headerTitle}>🚚 Mis Repartos</Text>
          <Text style={s.headerSub}>Ruta asignada por el admin</Text>
        </View>
        <TouchableOpacity onPress={handleLogout} style={s.logoutBtn}>
          <Text style={s.logoutText}>Salir</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={s.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => loadRoute(true)} tintColor={C.green} />}
        contentContainerStyle={s.scrollContent}>

        {/* Loading */}
        {loading && (
          <View style={s.center}>
            <ActivityIndicator size="large" color={C.green} />
            <Text style={s.centerText}>Cargando ruta asignada...</Text>
          </View>
        )}

        {/* Error */}
        {!loading && error && (
          <View style={s.errorBox}>
            <Text style={s.errorIcon}>⚠️</Text>
            <Text style={s.errorText}>{error}</Text>
            <TouchableOpacity style={s.retryBtn} onPress={() => loadRoute()}>
              <Text style={s.retryText}>Reintentar</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Sin ruta */}
        {!loading && !error && !route && (
          <View style={s.emptyBox}>
            <Text style={s.emptyIcon}>📭</Text>
            <Text style={s.emptyTitle}>Sin ruta asignada</Text>
            <Text style={s.emptyText}>
              Cuando el administrador te envíe una ruta de reparto, aparecerá aquí.
            </Text>
            <TouchableOpacity style={s.refreshBtn} onPress={() => loadRoute(true)}>
              <Text style={s.refreshText}>Actualizar</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Ruta asignada */}
        {!loading && !error && route && (
          <>
            {/* Card de la ruta */}
            <View style={s.routeCard}>
              <View style={s.routeHeader}>
                <Text style={s.routeName}>{route.name}</Text>
                <View style={[s.statusBadge, { backgroundColor: (STATUS_COLOR[route.status] || C.muted) + '22', borderColor: (STATUS_COLOR[route.status] || C.muted) + '55' }]}>
                  <Text style={[s.statusText, { color: STATUS_COLOR[route.status] || C.muted }]}>
                    {STATUS_LABEL[route.status] || route.status}
                  </Text>
                </View>
              </View>

              {/* Repartidor */}
              {route.driver_name && (
                <Text style={s.driverName}>👤 {route.driver_name}</Text>
              )}

              {/* Stats row */}
              <View style={s.statsRow}>
                <View style={s.statItem}>
                  <Text style={s.statNum}>{stops.length}</Text>
                  <Text style={s.statLabel}>Paradas</Text>
                </View>
                {route.total_distance && (
                  <View style={s.statItem}>
                    <Text style={s.statNum}>{route.total_distance}</Text>
                    <Text style={s.statLabel}>Distancia</Text>
                  </View>
                )}
                {route.total_duration && (
                  <View style={s.statItem}>
                    <Text style={s.statNum}>{route.total_duration}</Text>
                    <Text style={s.statLabel}>Duración</Text>
                  </View>
                )}
              </View>

              {/* Progreso */}
              {stops.length > 0 && (
                <View style={s.progressSection}>
                  <View style={s.progressBar}>
                    <View style={[s.progressFill, { width: `${pct}%` }]} />
                  </View>
                  <Text style={s.progressText}>
                    {doneCount} entregados · {failCount} fallidos · {pendCount} pendientes
                  </Text>
                </View>
              )}
            </View>

            {/* Lista rápida de paradas */}
            {stops.length > 0 && (
              <View style={s.stopsList}>
                <Text style={s.stopsTitle}>Paradas</Text>
                {stops.map((stop, idx) => {
                  const key    = `${stop.source}_${stop.id}`;
                  const st     = statuses[key] || 'pending';
                  const color  = st === 'entregado' ? C.green : st === 'cancelled' ? C.red : C.orange;
                  return (
                    <View key={key} style={[s.stopRow, st !== 'pending' && s.stopRowDone]}>
                      <View style={[s.stopNum, { backgroundColor: color }]}>
                        <Text style={s.stopNumText}>{idx + 1}</Text>
                      </View>
                      <View style={s.stopInfo}>
                        <Text style={[s.stopName, st !== 'pending' && s.textDim]} numberOfLines={1}>
                          {stop.customerName}
                        </Text>
                        <Text style={s.stopAddr} numberOfLines={1}>{stop.fullAddress}</Text>
                      </View>
                      <Text style={[s.stopStatus, { color }]}>
                        {st === 'entregado' ? '✓' : st === 'cancelled' ? '✕' : '•'}
                      </Text>
                    </View>
                  );
                })}
              </View>
            )}

            {/* Botón principal */}
            {route.status !== 'completed' && route.status !== 'cancelled' && stops.length > 0 && (
              <TouchableOpacity style={s.startBtn} onPress={handleStartRoute} activeOpacity={0.85}>
                <Text style={s.startBtnText}>
                  {route.status === 'in_progress' ? '▶  Continuar reparto' : '▶  Comenzar reparto'}
                </Text>
              </TouchableOpacity>
            )}

            {/* Completado */}
            {route.status === 'completed' && (
              <View style={s.doneBox}>
                <Text style={s.doneIcon}>🎉</Text>
                <Text style={s.doneText}>¡Reparto completado!</Text>
                <Text style={s.doneSub}>{doneCount} entregados · {failCount} fallidos</Text>
              </View>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container:    { flex: 1, backgroundColor: C.bg },
  header:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 56, paddingBottom: 16, paddingHorizontal: 20, borderBottomWidth: 1, borderBottomColor: C.border },
  headerTitle:  { color: C.text, fontSize: 22, fontWeight: '800' },
  headerSub:    { color: C.muted, fontSize: 12, marginTop: 2 },
  logoutBtn:    { backgroundColor: C.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  logoutText:   { color: C.muted, fontSize: 13, fontWeight: '600' },

  scroll:       { flex: 1 },
  scrollContent:{ padding: 16, gap: 12, paddingBottom: 40 },

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
  routeHeader:  { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  routeName:    { color: C.text, fontSize: 18, fontWeight: '800', flex: 1, marginRight: 8 },
  statusBadge:  { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1 },
  statusText:   { fontSize: 12, fontWeight: '700' },
  driverName:   { color: C.muted, fontSize: 13 },

  statsRow:     { flexDirection: 'row', gap: 12 },
  statItem:     { flex: 1, backgroundColor: C.bg, borderRadius: 10, padding: 12, alignItems: 'center' },
  statNum:      { color: C.text, fontSize: 16, fontWeight: '800' },
  statLabel:    { color: C.muted, fontSize: 11, marginTop: 2 },

  progressSection: { gap: 6 },
  progressBar:  { height: 6, backgroundColor: C.border, borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: C.green, borderRadius: 3 },
  progressText: { color: C.muted, fontSize: 11, textAlign: 'right' },

  stopsList:    { backgroundColor: C.card, borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: C.border },
  stopsTitle:   { color: C.text, fontWeight: '700', fontSize: 14, padding: 14, borderBottomWidth: 1, borderBottomColor: C.border },
  stopRow:      { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border, gap: 10 },
  stopRowDone:  { opacity: 0.6 },
  stopNum:      { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  stopNumText:  { color: '#fff', fontWeight: '800', fontSize: 12 },
  stopInfo:     { flex: 1 },
  stopName:     { color: C.text, fontWeight: '600', fontSize: 14 },
  textDim:      { color: C.muted },
  stopAddr:     { color: C.muted, fontSize: 12 },
  stopStatus:   { fontSize: 18, fontWeight: '800' },

  startBtn:     { backgroundColor: C.green, borderRadius: 14, padding: 18, alignItems: 'center', marginTop: 4 },
  startBtnText: { color: '#fff', fontWeight: '800', fontSize: 16 },

  doneBox:      { alignItems: 'center', padding: 32, gap: 8 },
  doneIcon:     { fontSize: 48 },
  doneText:     { color: C.text, fontSize: 20, fontWeight: '800' },
  doneSub:      { color: C.muted, fontSize: 14 },
});
