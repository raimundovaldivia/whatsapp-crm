/**
 * HistoryScreen — Historial de rutas del repartidor.
 *
 * Lista las rutas que ya terminó o se cancelaron. Al tocar una, abre la misma
 * pantalla de Ruta (RouteScreen) donde puede revisar las paradas y, si se
 * equivocó en alguna, volver a marcarla (corrige el estado real del pedido).
 */
import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ActivityIndicator, ScrollView, RefreshControl,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getRouteHistory } from '../services/api';

const CLP = n => `$${Math.round(Number(n) || 0).toLocaleString('es-CL')}`;

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

const STATUS_LABEL = { completed: 'Completada', cancelled: 'Cancelada' };
const STATUS_COLOR = { completed: C.green, cancelled: C.red };
const STOP_LABEL = { entregado: 'Entregado', cancelled: 'Cancelado', postponed: 'Reprogramado', not_delivered: 'Sin entrega', pending: 'Pendiente' };
const PAY_LABEL = { efectivo: 'Efectivo', transferencia: 'Transferencia', otro: 'Otro' };

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
  const fail = stops.filter(s => ['cancelled', 'not_delivered'].includes(statuses[`${s.source}_${s.id}`])).length;
  const postponed = stops.filter(s => statuses[`${s.source}_${s.id}`] === 'postponed').length;
  return { total: stops.length, done, fail, postponed };
}

function fmtDate(route) {
  const raw = route.completed_at || route.sent_at || route.created_at;
  if (!raw) return '';
  try {
    return new Date(raw).toLocaleDateString('es-CL', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Santiago',
    });
  } catch { return ''; }
}

export default function HistoryScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [routes, setRoutes]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]     = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  const load = useCallback(async (isRefresh) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const data = await getRouteHistory();
      setRoutes(Array.isArray(data) ? data : []);
    } catch (e) {
      if (e.response?.status !== 401) setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  function openRoute(route) {
    navigation.navigate('Route', { routeId: route.id, routeName: route.name });
  }

  return (
    <View style={[s.container, { paddingTop: insets.top ? 0 : 8 }]}>
      {loading ? (
        <View style={s.center}>
          <ActivityIndicator size="large" color={C.green} />
          <Text style={s.centerText}>Cargando historial…</Text>
        </View>
      ) : error ? (
        <View style={s.center}>
          <Text style={s.errorIcon}>⚠️</Text>
          <Text style={s.errorText}>{error}</Text>
          <TouchableOpacity style={s.retryBtn} onPress={() => load()}>
            <Text style={s.retryText}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      ) : routes.length === 0 ? (
        <View style={s.center}>
          <Text style={s.emptyIcon}>🗂️</Text>
          <Text style={s.emptyTitle}>Aún no hay rutas terminadas</Text>
          <Text style={s.emptyText}>Cuando completes o se cancele una ruta, aparecerá acá para revisarla.</Text>
          <TouchableOpacity style={s.refreshBtn} onPress={() => load(true)}>
            <Text style={s.refreshText}>Actualizar</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 14, paddingBottom: insets.bottom + 24 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.green} />}>
          <Text style={s.hint}>Toca una ruta para revisarla. Si te equivocaste en una parada, ábrela y vuelve a marcarla.</Text>
          {routes.map(route => {
            const { total, done, fail, postponed } = summarize(route);
            const color = STATUS_COLOR[route.status] || C.muted;
            return (
              <View key={route.id} style={s.card}>
                <TouchableOpacity onPress={() => openRoute(route)} activeOpacity={0.85}>
                  <View style={s.cardHead}>
                    <Text style={s.routeName} numberOfLines={2}>{route.name}</Text>
                    <View style={[s.badge, { borderColor: `${color}88`, backgroundColor: `${color}22` }]}>
                      <Text style={[s.badgeText, { color }]}>{STATUS_LABEL[route.status] || route.status}</Text>
                    </View>
                  </View>
                  <Text style={s.date}>{fmtDate(route)}</Text>
                  <View style={s.stats}>
                    <View style={s.stat}><Text style={s.statNum}>{total}</Text><Text style={s.statLabel}>Pedidos</Text></View>
                    <View style={s.stat}><Text style={[s.statNum, { color: C.green }]}>{done}</Text><Text style={s.statLabel}>Entregados</Text></View>
                    <View style={s.stat}><Text style={[s.statNum, { color: C.red }]}>{fail}</Text><Text style={s.statLabel}>Sin entrega</Text></View>
                    {postponed > 0 && <View style={s.stat}><Text style={[s.statNum, { color: C.orange }]}>{postponed}</Text><Text style={s.statLabel}>Reprogramados</Text></View>}
                  </View>
                </TouchableOpacity>
                <View style={s.cardActions}>
                  <TouchableOpacity onPress={() => setExpandedId(expandedId === route.id ? null : route.id)} style={s.ordersBtn}>
                    <Text style={s.ordersBtnText}>{expandedId === route.id ? 'Ocultar pedidos' : 'Ver historial de pedidos'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => openRoute(route)} style={s.reviewBtn}><Text style={s.reviewText}>Revisar ruta →</Text></TouchableOpacity>
                </View>
                {expandedId === route.id && (
                  <View style={s.ordersList}>
                    {stopsOf(route).map((stop, index) => {
                      const key = `${stop.source}_${stop.id}`;
                      const state = route.stop_statuses?.[key] || 'pending';
                      const payment = route.stop_payments?.[key];
                      return (
                        <View key={key} style={s.orderRow}>
                          <View style={s.orderNum}><Text style={s.orderNumText}>{stop.stopNumber || index + 1}</Text></View>
                          <View style={{ flex: 1 }}>
                            <Text style={s.orderName}>{stop.customerName || stop.orderName || `Pedido ${index + 1}`}</Text>
                            <Text style={s.orderMeta}>{stop.orderName || ''}{payment ? ` · ${PAY_LABEL[payment] || payment}` : ''}</Text>
                          </View>
                          <View style={s.orderRight}>
                            <Text style={[s.orderStatus, { color: state === 'entregado' ? C.green : state === 'postponed' ? C.orange : C.red }]}>{STOP_LABEL[state] || state}</Text>
                            <Text style={s.orderAmount}>{CLP(stop.totalPrice || stop.total_price)}</Text>
                          </View>
                        </View>
                      );
                    })}
                  </View>
                )}
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  center:    { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  centerText:{ color: C.muted, marginTop: 12, fontSize: 14 },
  errorIcon: { fontSize: 40 },
  errorText: { color: C.red, textAlign: 'center', marginVertical: 12, fontSize: 14 },
  retryBtn:  { backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 10, paddingHorizontal: 20, paddingVertical: 10 },
  retryText: { color: C.text, fontWeight: '700' },
  emptyIcon: { fontSize: 48 },
  emptyTitle:{ color: C.text, fontSize: 17, fontWeight: '700', marginTop: 10 },
  emptyText: { color: C.muted, textAlign: 'center', marginTop: 6, fontSize: 13, lineHeight: 19 },
  refreshBtn:{ marginTop: 16, backgroundColor: C.green, borderRadius: 10, paddingHorizontal: 22, paddingVertical: 11 },
  refreshText:{ color: '#04210f', fontWeight: '800' },
  hint:      { color: C.muted, fontSize: 12, marginBottom: 12, lineHeight: 17 },
  card:      { backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 14, padding: 14, marginBottom: 12 },
  cardHead:  { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  routeName: { flex: 1, color: C.text, fontSize: 15, fontWeight: '700' },
  badge:     { borderWidth: 1, borderRadius: 7, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { fontSize: 11, fontWeight: '700' },
  date:      { color: C.muted, fontSize: 12, marginTop: 4 },
  stats:     { flexDirection: 'row', gap: 18, marginTop: 12 },
  stat:      { alignItems: 'center' },
  statNum:   { color: C.text, fontSize: 18, fontWeight: '800' },
  statLabel: { color: C.muted, fontSize: 11, marginTop: 2 },
  cardActions:{ flexDirection: 'row', gap: 8, marginTop: 12 },
  ordersBtn: { flex: 1, backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, borderRadius: 9, padding: 9, alignItems: 'center' },
  ordersBtnText:{ color: C.text, fontSize: 11, fontWeight: '700' },
  reviewBtn: { paddingHorizontal: 11, paddingVertical: 9, justifyContent: 'center' },
  reviewText:{ color: C.blue, fontSize: 11, fontWeight: '700' },
  ordersList:{ marginTop: 10, borderTopWidth: 1, borderTopColor: C.border },
  orderRow:  { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.border },
  orderNum:  { width: 27, height: 27, borderRadius: 14, backgroundColor: C.border, alignItems: 'center', justifyContent: 'center' },
  orderNumText:{ color: C.text, fontSize: 11, fontWeight: '800' },
  orderName: { color: C.text, fontSize: 12, fontWeight: '700' },
  orderMeta: { color: C.muted, fontSize: 10, marginTop: 2 },
  orderRight:{ alignItems: 'flex-end' },
  orderStatus:{ fontSize: 10, fontWeight: '700' },
  orderAmount:{ color: C.text, fontSize: 11, fontWeight: '800', marginTop: 2 },
});
