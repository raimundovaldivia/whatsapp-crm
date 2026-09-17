import React, { useState, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, RefreshControl, ActivityIndicator, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { colors, CLP } from '../theme';
import { getOrders, setOrderStatus } from '../services/api';

const STATUS = {
  draft:            { l: 'Borrador',       c: '#9ca3af' },
  nuevo:            { l: 'Nuevo',          c: '#fbbf24' },
  sent:             { l: 'Pendiente pago', c: '#fbbf24' },
  payment_received: { l: 'Pago recibido',  c: '#22c55e' },
  por_despachar:    { l: 'Por despachar',  c: '#fbbf24' },
  en_camino:        { l: 'En camino',      c: '#38bdf8' },
  entregado:        { l: 'Entregado',      c: '#22c55e' },
  paid:             { l: 'Pagado',         c: '#22c55e' },
  cancelled:        { l: 'Cancelado',      c: '#f87171' },
};

export default function PedidosScreen() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await getOrders();
      const arr = Array.isArray(data) ? data : [];
      arr.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
      setItems(arr);
      setError(null);
    } catch (e) { setError(e.response?.data?.error || e.message); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  function itemsText(o) {
    let its = o.items;
    try { its = typeof its === 'string' ? JSON.parse(its) : its; } catch {}
    if (!Array.isArray(its)) return '';
    return its.map(i => `${i.quantity || 1}x ${i.name || i.title || ''}`.trim()).join(', ');
  }

  async function changeStatus(o) {
    const options = [];
    if (!['paid', 'entregado'].includes(o.status)) options.push({ text: 'Marcar pagado', onPress: () => apply(o, 'paid') });
    if (o.status !== 'entregado') options.push({ text: 'Marcar entregado', onPress: () => apply(o, 'entregado') });
    if (o.status !== 'cancelled') options.push({ text: 'Cancelar pedido', style: 'destructive', onPress: () => apply(o, 'cancelled') });
    options.push({ text: 'Cerrar', style: 'cancel' });
    Alert.alert(`Pedido #${o.id}`, `${o.customer_name || ''} · ${CLP(o.total_price)}`, options);
  }
  async function apply(o, status) {
    try { await setOrderStatus(o.id, status); load(); }
    catch (e) { Alert.alert('Error', e.response?.data?.error || e.message); }
  }

  const renderItem = ({ item }) => {
    const st = STATUS[item.status] || { l: item.status, c: colors.textMuted };
    return (
      <TouchableOpacity onPress={() => changeStatus(item)}
        style={{ padding: 14, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ color: colors.textPrimary, fontWeight: '700', flex: 1 }} numberOfLines={1}>
            {item.customer_name || 'Sin nombre'} <Text style={{ color: colors.textMuted, fontWeight: '400' }}>#{item.id}</Text>
          </Text>
          <Text style={{ color: colors.green, fontWeight: '800' }}>{CLP(item.total_price)}</Text>
        </View>
        <Text numberOfLines={1} style={{ color: colors.textSecondary, fontSize: 12, marginTop: 3 }}>{itemsText(item)}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <Text style={{ fontSize: 10, fontWeight: '800', color: st.c, backgroundColor: `${st.c}22`, borderColor: `${st.c}55`, borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>{st.l}</Text>
          {item.payment_method === 'transferencia' && <Text style={{ color: colors.blue, fontSize: 11 }}>🏦 transferencia</Text>}
        </View>
      </TouchableOpacity>
    );
  };

  if (loading) return <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={colors.green} /></View>;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {error && <Text style={{ color: colors.red, padding: 12 }}>{error}</Text>}
      <FlatList
        data={items}
        keyExtractor={i => String(i.id)}
        renderItem={renderItem}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.green} />}
        ListEmptyComponent={<Text style={{ color: colors.textMuted, textAlign: 'center', marginTop: 40 }}>Sin pedidos</Text>}
      />
    </View>
  );
}
