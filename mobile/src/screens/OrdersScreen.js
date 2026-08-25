import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, Alert, RefreshControl, Switch,
} from 'react-native';
import * as Location from 'expo-location';
import { getDeliveryOrders, optimizeRoute } from '../services/api';

const C = {
  bg:     '#0f172a',
  card:   '#1e293b',
  border: '#334155',
  green:  '#22c55e',
  orange: '#fb923c',
  text:   '#f1f5f9',
  muted:  '#94a3b8',
};

export default function OrdersScreen({ navigation, onLogout }) {
  const [orders,    setOrders]    = useState([]);
  const [selected,  setSelected]  = useState(new Set());
  const [loading,   setLoading]   = useState(true);
  const [optimizing,setOptimizing]= useState(false);
  const [refreshing,setRefreshing]= useState(false);
  const [useGPS,    setUseGPS]    = useState(true);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const data = await getDeliveryOrders();
      setOrders(data.orders || []);
      // Auto-seleccionar todos
      setSelected(new Set((data.orders || []).map(o => `${o.source}_${o.id}`)));
    } catch (err) {
      Alert.alert('Error', err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, []);

  function toggleSelect(key) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === orders.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(orders.map(o => `${o.source}_${o.id}`)));
    }
  }

  async function handleOptimize() {
    const selectedOrders = orders.filter(o => selected.has(`${o.source}_${o.id}`));
    if (selectedOrders.length === 0) {
      Alert.alert('Selecciona pedidos', 'Elige al menos un pedido para optimizar la ruta.');
      return;
    }

    setOptimizing(true);
    try {
      let origin = null;
      if (useGPS) {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
          origin = { lat: loc.coords.latitude, lng: loc.coords.longitude };
        }
      }

      const result = await optimizeRoute(selectedOrders, origin);
      navigation.navigate('Route', { route: result, onStatusUpdate: () => load(true) });
    } catch (err) {
      Alert.alert('Error al optimizar', err.response?.data?.error || err.message);
    } finally {
      setOptimizing(false);
    }
  }

  const renderOrder = ({ item }) => {
    const key     = `${item.source}_${item.id}`;
    const checked = selected.has(key);
    const hasAddr = item.fullAddress.trim().length > 3;

    return (
      <TouchableOpacity
        style={[s.card, checked && s.cardSelected, !hasAddr && s.cardDisabled]}
        onPress={() => hasAddr && toggleSelect(key)}
        activeOpacity={0.7}>
        {/* Checkbox */}
        <View style={[s.checkbox, checked && s.checkboxOn]}>
          {checked && <Text style={s.checkmark}>✓</Text>}
        </View>

        <View style={s.cardBody}>
          {/* Nombre + pedido */}
          <View style={s.cardRow}>
            <Text style={s.customerName} numberOfLines={1}>{item.customerName}</Text>
            <Text style={s.orderName}>{item.orderName}</Text>
          </View>

          {/* Dirección */}
          {hasAddr
            ? <Text style={s.address} numberOfLines={2}>📍 {item.fullAddress}</Text>
            : <Text style={s.noAddress}>⚠️ Sin dirección — no se puede incluir</Text>}

          {/* Productos */}
          {item.items?.length > 0 && (
            <Text style={s.items} numberOfLines={1}>
              📦 {item.items.map(i => `${i.title || i.name}${i.quantity > 1 ? ` x${i.quantity}` : ''}`).join(', ')}
            </Text>
          )}

          {/* Total */}
          {item.totalPrice > 0 && (
            <Text style={s.price}>${Math.round(item.totalPrice).toLocaleString('es-CL')}</Text>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  if (loading) {
    return (
      <View style={s.center}>
        <ActivityIndicator size="large" color={C.green} />
        <Text style={s.loadingText}>Cargando pedidos...</Text>
      </View>
    );
  }

  return (
    <View style={s.container}>
      {/* Header */}
      <View style={s.header}>
        <View>
          <Text style={s.headerTitle}>Pedidos del día</Text>
          <Text style={s.headerSub}>{selected.size} de {orders.length} seleccionados</Text>
        </View>
        <TouchableOpacity onPress={onLogout} style={s.logoutBtn}>
          <Text style={s.logoutText}>Salir</Text>
        </TouchableOpacity>
      </View>

      {/* GPS toggle */}
      <View style={s.gpsRow}>
        <Text style={s.gpsLabel}>📍 Partir desde mi ubicación</Text>
        <Switch
          value={useGPS}
          onValueChange={setUseGPS}
          trackColor={{ false: C.border, true: C.green + '88' }}
          thumbColor={useGPS ? C.green : C.muted}
        />
      </View>

      {orders.length === 0 ? (
        <View style={s.empty}>
          <Text style={s.emptyIcon}>🎉</Text>
          <Text style={s.emptyText}>No hay pedidos pendientes</Text>
          <Text style={s.emptyMuted}>Todos los pedidos están entregados</Text>
        </View>
      ) : (
        <FlatList
          data={orders}
          keyExtractor={o => `${o.source}_${o.id}`}
          renderItem={renderOrder}
          contentContainerStyle={s.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(true); }}
              tintColor={C.green}
            />
          }
          ListHeaderComponent={
            <TouchableOpacity onPress={toggleAll} style={s.selectAll}>
              <Text style={s.selectAllText}>
                {selected.size === orders.length ? 'Deseleccionar todo' : 'Seleccionar todo'}
              </Text>
            </TouchableOpacity>
          }
        />
      )}

      {/* Botón Optimizar */}
      {orders.length > 0 && (
        <View style={s.footer}>
          <TouchableOpacity
            style={[s.optimizeBtn, (optimizing || selected.size === 0) && s.btnDisabled]}
            onPress={handleOptimize}
            disabled={optimizing || selected.size === 0}
            activeOpacity={0.85}>
            {optimizing
              ? <><ActivityIndicator color="#fff" /><Text style={s.optimizeBtnText}>  Calculando...</Text></>
              : <Text style={s.optimizeBtnText}>🗺 Optimizar ruta ({selected.size})</Text>}
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container:    { flex: 1, backgroundColor: C.bg },
  center:       { flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText:  { color: C.muted, fontSize: 14 },

  header:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, paddingTop: 56, backgroundColor: C.card, borderBottomWidth: 1, borderBottomColor: C.border },
  headerTitle:  { color: C.text, fontSize: 20, fontWeight: '800' },
  headerSub:    { color: C.muted, fontSize: 13, marginTop: 2 },
  logoutBtn:    { padding: 8 },
  logoutText:   { color: C.muted, fontSize: 13 },

  gpsRow:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border },
  gpsLabel:     { color: C.muted, fontSize: 13 },

  list:         { paddingHorizontal: 16, paddingBottom: 100, paddingTop: 8 },
  selectAll:    { paddingVertical: 10 },
  selectAllText:{ color: C.green, fontSize: 13, fontWeight: '600' },

  card:         { flexDirection: 'row', backgroundColor: C.card, borderRadius: 12, padding: 14, marginVertical: 5, borderWidth: 1, borderColor: C.border, gap: 12 },
  cardSelected: { borderColor: C.green },
  cardDisabled: { opacity: 0.45 },
  cardBody:     { flex: 1, gap: 3 },
  cardRow:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },

  checkbox:     { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: C.border, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  checkboxOn:   { backgroundColor: C.green, borderColor: C.green },
  checkmark:    { color: '#fff', fontSize: 14, fontWeight: '800' },

  customerName: { color: C.text, fontWeight: '700', fontSize: 15, flex: 1 },
  orderName:    { color: C.muted, fontSize: 12 },
  address:      { color: C.muted, fontSize: 13, lineHeight: 18 },
  noAddress:    { color: C.orange, fontSize: 12 },
  items:        { color: C.muted, fontSize: 12 },
  price:        { color: C.green, fontSize: 13, fontWeight: '600' },

  empty:        { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  emptyIcon:    { fontSize: 48 },
  emptyText:    { color: C.text, fontSize: 18, fontWeight: '700' },
  emptyMuted:   { color: C.muted, fontSize: 14 },

  footer:       { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 20, paddingBottom: 36, backgroundColor: C.bg, borderTopWidth: 1, borderTopColor: C.border },
  optimizeBtn:  { backgroundColor: C.green, borderRadius: 14, padding: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  btnDisabled:  { opacity: 0.5 },
  optimizeBtnText: { color: '#fff', fontWeight: '800', fontSize: 17 },
});
