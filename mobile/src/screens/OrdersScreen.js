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
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { getActiveRoutes } from '../services/api';
import UpdateStatus from '../components/UpdateStatus';
import { flushExpenses } from '../utils/expenseQueue';
import { C, R, shadow, shadowSoft } from '../theme';

const STATUS_LABEL = {
  draft:       'Borrador',
  sent:        'Preparar carga',
  in_progress: 'En curso',
  completed:   'Completada',
  cancelled:   'Cancelada',
  not_delivered: 'Sin entrega',
};
const STATUS_COLOR = {
  draft:       C.muted,
  sent:        C.blue,
  in_progress: C.orange,
  completed:   C.green,
  cancelled:   C.red,
  not_delivered: C.blue,
};

/** Paradas de una ruta: optimized_route si existe, si no los pedidos en orden. */
function stopsOf(route) {
  const opt = Array.isArray(route?.optimized_route) ? route.optimized_route : [];
  if (opt.length > 0) return opt;
  const raw = Array.isArray(route?.orders) ? route.orders : [];
  return raw.map((o, i) => ({ ...o, stopNumber: i + 1 }));
}

const isPriorityRetry = stop => stop?.isRetry === true || stop?.deliveryPriority === 'retry' || Number(stop?.dispatchCount || 0) > 0;

function summarize(route) {
  const stops    = stopsOf(route);
  const statuses = route?.stop_statuses && typeof route.stop_statuses === 'object' ? route.stop_statuses : {};
  const done = stops.filter(s => statuses[`${s.source}_${s.id}`] === 'entregado').length;
  const fail = stops.filter(s => ['cancelled', 'not_delivered'].includes(statuses[`${s.source}_${s.id}`])).length;
  const postponed = stops.filter(s => statuses[`${s.source}_${s.id}`] === 'postponed').length;
  const pend = stops.filter(s => !statuses[`${s.source}_${s.id}`] || statuses[`${s.source}_${s.id}`] === 'pending').length;
  const pct  = stops.length > 0 ? Math.round(((done + fail + postponed) / stops.length) * 100) : 0;
  const priorityCount = stops.filter(isPriorityRetry).length;
  return { stops, statuses, done, fail, postponed, pend, pct, priorityCount };
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
        <View style={s.headerBrand}>
          <View style={s.headerMark}><MaterialCommunityIcons name="truck-fast-outline" size={22} color={C.green} /></View>
          <View style={{ flex: 1 }}>
            <Text style={s.headerKicker}>CENTRO DE OPERACIONES</Text>
            <Text style={s.headerTitle}>{firstName ? `Hola, ${firstName}` : 'Mis rutas'}</Text>
            <Text style={s.headerSub}>Revisa tu jornada y continúa donde quedaste</Text>
          </View>
        </View>
        <TouchableOpacity onPress={handleLogout} style={s.logoutBtn}>
          <MaterialCommunityIcons name="logout" size={19} color={C.muted} />
        </TouchableOpacity>
      </View>
      <View style={s.shortcutRow}>
        <TouchableOpacity onPress={() => navigation.navigate('Expenses')} style={s.shortcutBtn}>
          <View style={[s.shortcutIcon, { backgroundColor: C.orange + '1F' }]}><MaterialCommunityIcons name="receipt-text-outline" size={19} color={C.orange} /></View>
          <View style={{ flex: 1 }}><Text style={s.shortcutText}>Mis gastos</Text><Text style={s.shortcutSub}>Rendiciones</Text></View>
          <MaterialCommunityIcons name="chevron-right" size={20} color={C.dim} />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => navigation.navigate('History')} style={s.shortcutBtn}>
          <View style={[s.shortcutIcon, { backgroundColor: C.blue + '1F' }]}><MaterialCommunityIcons name="history" size={20} color={C.blue} /></View>
          <View style={{ flex: 1 }}><Text style={s.shortcutText}>Historial</Text><Text style={s.shortcutSub}>Rutas anteriores</Text></View>
          <MaterialCommunityIcons name="chevron-right" size={20} color={C.dim} />
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

        <TouchableOpacity onPress={() => navigation.navigate('Returns')} style={{margin:16,padding:16,backgroundColor:C.card,borderRadius:12,borderWidth:1,borderColor:C.green}}>
          <Text style={{color:C.green,fontSize:17,fontWeight:'700'}}>↩ Cambios y devoluciones</Text>
          <Text style={{color:C.text,marginTop:5}}>Ver retiros y reemplazos asignados</Text>
        </TouchableOpacity>

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
          const { stops, statuses, done, fail, postponed, pend, pct, priorityCount } = summarize(route);
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

              {priorityCount > 0 && (
                <View style={s.priorityBanner}>
                  <Text style={s.priorityBannerTitle}>⚠️ {priorityCount} reintento{priorityCount === 1 ? '' : 's'} prioritario{priorityCount === 1 ? '' : 's'}</Text>
                  <Text style={s.priorityBannerText}>Pedidos no entregados en rutas anteriores. Aparecen primero en el recorrido.</Text>
                </View>
              )}

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
                    {done} entregados · {fail} sin entrega{postponed ? ` · ${postponed} reprogramados` : ''} · {pend} pendientes
                  </Text>
                </View>
              )}

              {/* Próximas paradas */}
              {stops.length > 0 && (
                <View style={s.stopsPreview}>
                  {stops.slice(0, 4).map((stop, idx) => {
                    const st = statuses[`${stop.source}_${stop.id}`] || 'pending';
                    const c  = st === 'entregado' ? C.green : st === 'cancelled' ? C.red : st === 'not_delivered' ? C.blue : C.orange;
                    return (
                      <View key={`${stop.source}_${stop.id}`} style={s.stopRow}>
                        <View style={[s.stopNum, { backgroundColor: c }]}>
                          <Text style={s.stopNumText}>{stop.stopNumber || idx + 1}</Text>
                        </View>
                        <Text style={[s.stopName, st !== 'pending' && s.textDim]} numberOfLines={1}>
                          {isPriorityRetry(stop) ? '⚠ ' : ''}{stop.customerName}
                        </Text>
                        <Text style={[s.stopStatus, { color: c }]}>
                          {st === 'entregado' ? '✓' : st === 'cancelled' ? '✕' : st === 'not_delivered' ? '!' : '•'}
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
                  <MaterialCommunityIcons name={route.status === 'in_progress' ? 'navigation-variant-outline' : 'package-variant-closed-check'} size={19} color={C.inkOnAccent} />
                  <Text style={s.startBtnText}>{route.status === 'in_progress' ? 'Continuar reparto' : 'Consolidar carga'}</Text>
                  <MaterialCommunityIcons name="arrow-right" size={18} color={C.inkOnAccent} />
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
  header:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 16, paddingBottom: 18, paddingHorizontal: 18, backgroundColor: C.bgSoft },
  headerBrand:  { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  headerMark:   { width: 44, height: 44, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0A2B31', borderWidth: 1, borderColor: '#1B6B69' },
  headerKicker: { color: C.green, fontSize: 9, fontWeight: '900', letterSpacing: 1.25 },
  headerTitle:  { color: C.text, fontSize: 23, fontWeight: '900', letterSpacing: -0.5, marginTop: 2 },
  headerSub:    { color: C.muted, fontSize: 11, marginTop: 2 },
  logoutBtn:    { width: 42, height: 42, backgroundColor: C.card, borderRadius: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.border },
  shortcutRow:  { flexDirection: 'row', gap: 10, paddingHorizontal: 14, paddingVertical: 12, backgroundColor: C.bgSoft, borderBottomWidth: 1, borderBottomColor: C.borderSoft },
  shortcutBtn:  { flex: 1, minHeight: 64, flexDirection: 'row', gap: 8, backgroundColor: C.card, borderRadius: R.md, padding: 10, alignItems: 'center', borderWidth: 1, borderColor: C.borderSoft, ...shadowSoft },
  shortcutIcon: { width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  shortcutText: { color: C.text, fontSize: 13, fontWeight: '800' },
  shortcutSub:  { color: C.muted, fontSize: 9, marginTop: 1 },

  scroll:       { flex: 1 },
  scrollContent:{ padding: 14, gap: 14, paddingBottom: 40 },

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

  routeCard:    { backgroundColor: C.card, borderRadius: R.lg, padding: 17, borderWidth: 1, borderColor: C.borderSoft, gap: 13, ...shadowSoft },
  routeHeader:  { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 },
  routeName:    { color: C.text, fontSize: 18, fontWeight: '800', flex: 1 },
  statusBadge:  { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1 },
  statusText:   { fontSize: 12, fontWeight: '700' },

  statsRow:     { flexDirection: 'row', gap: 9 },
  statItem:     { flex: 1, backgroundColor: C.bgSoft, borderRadius: R.sm, padding: 10, alignItems: 'center', borderWidth: 1, borderColor: C.borderSoft },
  statNum:      { color: C.text, fontSize: 16, fontWeight: '800' },
  statLabel:    { color: C.muted, fontSize: 11, marginTop: 2 },

  progressSection: { gap: 6 },
  progressBar:  { height: 6, backgroundColor: C.border, borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: C.green, borderRadius: 3 },
  progressText: { color: C.muted, fontSize: 11, textAlign: 'right' },

  priorityBanner:{ backgroundColor: '#3a2a10', borderWidth: 1, borderColor: '#f59e0b88', borderRadius: 10, padding: 10 },
  priorityBannerTitle:{ color: '#fbbf24', fontSize: 13, fontWeight: '900' },
  priorityBannerText:{ color: '#fde68a', fontSize: 11, lineHeight: 16, marginTop: 3 },

  stopsPreview: { gap: 8 },
  stopRow:      { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stopNum:      { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  stopNumText:  { color: '#fff', fontWeight: '800', fontSize: 11 },
  stopName:     { color: C.text, fontWeight: '600', fontSize: 14, flex: 1 },
  textDim:      { color: C.muted, textDecorationLine: 'line-through' },
  stopStatus:   { fontSize: 16, fontWeight: '800' },
  moreStops:    { color: C.muted, fontSize: 12, paddingLeft: 34 },

  startBtn:     { backgroundColor: C.green, borderRadius: R.md, paddingHorizontal: 14, minHeight: 50, flexDirection: 'row', justifyContent: 'center', gap: 9, alignItems: 'center', marginTop: 2 },
  startBtnText: { color: C.inkOnAccent, fontWeight: '900', fontSize: 15, flex: 1, textAlign: 'center' },
});
