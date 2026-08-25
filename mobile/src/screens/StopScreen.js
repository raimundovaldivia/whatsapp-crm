import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  Linking, Alert, ActivityIndicator, Platform, ScrollView,
} from 'react-native';
import { updateOrderStatus } from '../services/api';

const C = {
  bg:     '#0f172a',
  card:   '#1e293b',
  border: '#334155',
  green:  '#22c55e',
  orange: '#fb923c',
  red:    '#f87171',
  blue:   '#38bdf8',
  text:   '#f1f5f9',
  muted:  '#94a3b8',
};

export default function StopScreen({ route: navRoute, navigation }) {
  const { stop, stopNumber, totalStops, onComplete } = navRoute.params;
  const [loading, setLoading] = useState(false);
  const [done,    setDone]    = useState(false);
  const [status,  setStatus]  = useState(null);

  function openMaps() {
    const addr = encodeURIComponent(stop.fullAddress);
    const url  = Platform.OS === 'ios'
      ? `maps://maps.apple.com/?daddr=${addr}&dirflg=d`
      : `google.navigation:q=${addr}&mode=d`;
    Linking.openURL(url).catch(() => {
      // Fallback: Google Maps web
      Linking.openURL(`https://maps.google.com/maps?daddr=${addr}`);
    });
  }

  function callCustomer() {
    if (!stop.phone) {
      Alert.alert('Sin teléfono', 'Este pedido no tiene número de teléfono registrado.');
      return;
    }
    const phone = stop.phone.replace(/\D/g, '');
    Linking.openURL(`tel:${phone}`);
  }

  async function markAs(newStatus) {
    const labels = { entregado: 'entregado', cancelled: 'no encontrado' };
    Alert.alert(
      `Marcar como ${labels[newStatus] || newStatus}`,
      `¿Confirmas que el pedido de ${stop.customerName} fue ${labels[newStatus] || newStatus}?`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Confirmar',
          style: newStatus === 'cancelled' ? 'destructive' : 'default',
          onPress: async () => {
            setLoading(true);
            try {
              await updateOrderStatus(stop.id, stop.source, newStatus);
              setStatus(newStatus);
              setDone(true);
              if (onComplete) onComplete(newStatus === 'entregado' ? 'done' : 'failed');
              // Volver a la pantalla de ruta después de un momento
              setTimeout(() => navigation.goBack(), 1200);
            } catch (err) {
              Alert.alert('Error', err.response?.data?.error || err.message);
            } finally {
              setLoading(false);
            }
          },
        },
      ]
    );
  }

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content}>
      {/* Header de parada */}
      <View style={s.badge}>
        <Text style={s.badgeText}>Parada {stopNumber} de {totalStops}</Text>
      </View>

      {/* Nombre del cliente */}
      <Text style={s.customerName}>{stop.customerName}</Text>

      {/* Dirección */}
      <View style={s.infoCard}>
        <Text style={s.infoLabel}>📍 Dirección</Text>
        <Text style={s.infoValue}>{stop.address || '—'}</Text>
        {stop.city ? <Text style={s.infoCity}>{stop.city}</Text> : null}
      </View>

      {/* Teléfono */}
      {stop.phone ? (
        <View style={s.infoCard}>
          <Text style={s.infoLabel}>📞 Teléfono</Text>
          <Text style={s.infoValue}>{stop.phone}</Text>
        </View>
      ) : null}

      {/* Productos */}
      {stop.items?.length > 0 && (
        <View style={s.infoCard}>
          <Text style={s.infoLabel}>📦 Productos</Text>
          {stop.items.map((item, i) => (
            <Text key={i} style={s.infoValue}>
              {item.title || item.name}
              {item.quantity > 1 ? ` × ${item.quantity}` : ''}
            </Text>
          ))}
        </View>
      )}

      {/* Total */}
      {stop.totalPrice > 0 && (
        <View style={s.infoCard}>
          <Text style={s.infoLabel}>💰 Total</Text>
          <Text style={[s.infoValue, { color: C.green, fontWeight: '700' }]}>
            ${Math.round(stop.totalPrice).toLocaleString('es-CL')}
          </Text>
        </View>
      )}

      {/* Pedido */}
      <View style={s.infoCard}>
        <Text style={s.infoLabel}>🧾 Pedido</Text>
        <Text style={s.infoValue}>{stop.orderName}</Text>
      </View>

      {/* ─── Botones de acción ─── */}
      {!done ? (
        <>
          {/* Navegación */}
          <TouchableOpacity style={s.navBtn} onPress={openMaps} activeOpacity={0.85}>
            <Text style={s.navBtnText}>🗺  Navegar con Google Maps</Text>
          </TouchableOpacity>

          {/* Llamar */}
          {stop.phone && (
            <TouchableOpacity style={s.callBtn} onPress={callCustomer} activeOpacity={0.85}>
              <Text style={s.callBtnText}>📞  Llamar al cliente</Text>
            </TouchableOpacity>
          )}

          <View style={s.statusRow}>
            {/* Entregado */}
            <TouchableOpacity
              style={[s.statusBtn, s.deliveredBtn, loading && s.btnDisabled]}
              onPress={() => markAs('entregado')}
              disabled={loading}
              activeOpacity={0.85}>
              {loading ? <ActivityIndicator color="#fff" /> : (
                <>
                  <Text style={s.statusIcon}>✓</Text>
                  <Text style={s.statusBtnText}>Entregado</Text>
                </>
              )}
            </TouchableOpacity>

            {/* No encontrado */}
            <TouchableOpacity
              style={[s.statusBtn, s.failedBtn, loading && s.btnDisabled]}
              onPress={() => markAs('cancelled')}
              disabled={loading}
              activeOpacity={0.85}>
              <Text style={s.statusIcon}>✕</Text>
              <Text style={s.statusBtnText}>No encontrado</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : (
        <View style={s.doneBox}>
          <Text style={s.doneIcon}>{status === 'entregado' ? '✅' : '❌'}</Text>
          <Text style={s.doneText}>
            {status === 'entregado' ? '¡Entregado!' : 'Marcado como no encontrado'}
          </Text>
          <Text style={s.doneSub}>Volviendo a la ruta...</Text>
        </View>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container:    { flex: 1, backgroundColor: C.bg },
  content:      { padding: 20, paddingBottom: 48, gap: 12 },

  badge:        { backgroundColor: C.blue + '22', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 6, alignSelf: 'flex-start', borderWidth: 1, borderColor: C.blue + '55' },
  badgeText:    { color: C.blue, fontWeight: '700', fontSize: 13 },

  customerName: { color: C.text, fontSize: 30, fontWeight: '900', letterSpacing: -0.5, marginTop: 4, marginBottom: 8 },

  infoCard:     { backgroundColor: C.card, borderRadius: 12, padding: 16, borderWidth: 1, borderColor: C.border },
  infoLabel:    { color: C.muted, fontSize: 12, fontWeight: '600', marginBottom: 6 },
  infoValue:    { color: C.text, fontSize: 17, fontWeight: '600', lineHeight: 24 },
  infoCity:     { color: C.muted, fontSize: 14, marginTop: 2 },

  navBtn:       { backgroundColor: C.blue, borderRadius: 14, padding: 18, alignItems: 'center', marginTop: 8 },
  navBtnText:   { color: '#fff', fontWeight: '800', fontSize: 16 },

  callBtn:      { backgroundColor: C.card, borderRadius: 14, padding: 16, alignItems: 'center', borderWidth: 1, borderColor: C.border },
  callBtnText:  { color: C.text, fontWeight: '700', fontSize: 15 },

  statusRow:    { flexDirection: 'row', gap: 12, marginTop: 4 },
  statusBtn:    { flex: 1, borderRadius: 14, padding: 18, alignItems: 'center', gap: 6 },
  btnDisabled:  { opacity: 0.5 },
  deliveredBtn: { backgroundColor: C.green },
  failedBtn:    { backgroundColor: C.card, borderWidth: 2, borderColor: C.red },
  statusIcon:   { fontSize: 26 },
  statusBtnText:{ color: '#fff', fontWeight: '800', fontSize: 15 },

  doneBox:      { alignItems: 'center', padding: 40, gap: 10 },
  doneIcon:     { fontSize: 64 },
  doneText:     { color: C.text, fontSize: 20, fontWeight: '800' },
  doneSub:      { color: C.muted, fontSize: 14 },
});
