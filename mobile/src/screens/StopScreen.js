import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  Linking, Alert, ActivityIndicator, Platform, ScrollView,
} from 'react-native';
import { updateStopStatus, getSellCatalog } from '../services/api';

const CLP = n => `$${Math.round(Number(n) || 0).toLocaleString('es-CL')}`;

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
  // onComplete es opcional y legacy: RouteScreen se refresca sola al volver.
  const { stop, routeId, stopKey, stopNumber, stopLabel, totalStops, onComplete } = navRoute.params;
  const [loading, setLoading] = useState(false);
  const [done,    setDone]    = useState(false);
  const [status,  setStatus]  = useState(null);
  // Al entregar hay que registrar cómo pagó el cliente: se pregunta acá mismo,
  // con botones grandes, en vez de un Alert encadenado.
  const [askingPayment, setAskingPayment] = useState(false);
  const [paidWith,      setPaidWith]      = useState(null);
  // Nota que el repartidor puede dejar en la parada (ej: "dejé con conserje").
  const [note, setNote] = useState(navRoute.params?.stop?.note || '');

  // Venta extra en ruta ("bandejas extras") — solo si la tienda lo activó.
  const [sellEnabled, setSellEnabled] = useState(false);
  const [catalog,     setCatalog]     = useState([]);
  const [showPicker,  setShowPicker]  = useState(false);
  const [extras,      setExtras]      = useState({}); // id → { title, price, quantity }

  useEffect(() => {
    getSellCatalog()
      .then(d => { setSellEnabled(!!d?.enabled); setCatalog(Array.isArray(d?.products) ? d.products : []); })
      .catch(() => { setSellEnabled(false); });
  }, []);

  const extrasList  = Object.values(extras).filter(e => e.quantity > 0);
  const extrasTotal = extrasList.reduce((s, e) => s + e.price * e.quantity, 0);
  const extrasArray = extrasList.map(e => ({ name: e.title, quantity: e.quantity, price: e.price }));

  function bumpExtra(p, delta) {
    setExtras(prev => {
      const cur = prev[p.id] || { title: p.title, price: p.price, quantity: 0 };
      const quantity = Math.max(0, cur.quantity + delta);
      return { ...prev, [p.id]: { ...cur, title: p.title, price: p.price, quantity } };
    });
  }

  function openMaps() {
    const addr = encodeURIComponent(stop.fullAddress);
    const url  = Platform.OS === 'ios'
      ? `maps://maps.apple.com/?daddr=${addr}&dirflg=d`
      : `google.navigation:q=${addr}&mode=d`;
    Linking.openURL(url).catch(() =>
      Linking.openURL(`https://maps.google.com/maps?daddr=${addr}`)
    );
  }

  const phoneDigits = (stop.phone || '').replace(/\D/g, '');

  function callCustomer() {
    if (!phoneDigits) {
      Alert.alert('Sin teléfono', 'Este pedido no tiene número de teléfono registrado.');
      return;
    }
    Linking.openURL(`tel:${phoneDigits}`);
  }

  function whatsappCustomer() {
    if (!phoneDigits) return;
    const text = encodeURIComponent(`Hola ${stop.customerName?.split(' ')[0] || ''}, soy el repartidor. Voy en camino con tu pedido ${stop.orderName || ''}.`);
    Linking.openURL(`https://wa.me/${phoneDigits}?text=${text}`).catch(() =>
      Alert.alert('WhatsApp', 'No se pudo abrir WhatsApp en este teléfono.')
    );
  }

  /** Envía el estado al backend y cierra la parada. */
  async function submit(newStatus, paymentMethod) {
    setLoading(true);
    try {
      await updateStopStatus(routeId, stopKey, newStatus, paymentMethod, note, extrasArray);
      setStatus(newStatus);
      setPaidWith(paymentMethod || null);
      setDone(true);
      setAskingPayment(false);
      if (typeof onComplete === 'function') onComplete(newStatus);
      setTimeout(() => navigation.goBack(), 1400);
    } catch (err) {
      if (err.response?.status === 401) return; // la app vuelve al login sola
      const msg = err.response?.data?.error
        || (err.code === 'ECONNABORTED' ? 'Sin conexión. Intenta de nuevo cuando tengas señal.' : err.message);
      Alert.alert('No se pudo guardar', msg);
    } finally {
      setLoading(false);
    }
  }

  /** "No encontrado" — sigue pidiendo confirmación porque cancela el pedido. */
  function markNotFound() {
    Alert.alert(
      'Marcar como no encontrado',
      `¿Confirmas que no pudiste entregar el pedido de ${stop.customerName}?`,
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Confirmar', style: 'destructive', onPress: () => submit('cancelled') },
      ]
    );
  }

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content}>
      {/* Parada número */}
      <View style={s.badge}>
        <Text style={s.badgeText}>Parada {stopLabel || stopNumber} de {totalStops}</Text>
      </View>

      {/* Nombre */}
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

      {/* N° Pedido */}
      <View style={s.infoCard}>
        <Text style={s.infoLabel}>🧾 Pedido</Text>
        <Text style={s.infoValue}>{stop.orderName}</Text>
      </View>

      {/* ─── Acciones ─── */}
      {done ? (
        <View style={s.doneBox}>
          <Text style={s.doneIcon}>{status === 'entregado' ? '✅' : '❌'}</Text>
          <Text style={s.doneText}>
            {status === 'entregado' ? '¡Entregado!' : 'No encontrado'}
          </Text>
          {paidWith === 'efectivo'     && <Text style={s.donePay}>💵 Pagado en efectivo</Text>}
          {paidWith === 'transferencia' && <Text style={s.donePay}>🏦 Por transferencia — queda pendiente el comprobante</Text>}
          <Text style={s.doneSub}>Volviendo a la ruta...</Text>
        </View>
      ) : askingPayment ? (
        /* ── Paso 2: ¿cómo pagó? ── */
        <View style={s.payBox}>
          <Text style={s.payTitle}>¿Cómo pagó {stop.customerName?.split(' ')[0] || 'el cliente'}?</Text>
          {(Number(stop.totalPrice) > 0 || extrasTotal > 0) && (
            <Text style={s.paySub}>
              Total a cobrar: {CLP((Number(stop.totalPrice) || 0) + extrasTotal)}
              {extrasTotal > 0 ? ` (incluye +${CLP(extrasTotal)} extra)` : ''}
            </Text>
          )}

          <TouchableOpacity
            style={[s.payBtn, s.payCash, loading && s.btnDisabled]}
            onPress={() => submit('entregado', 'efectivo')}
            disabled={loading}
            activeOpacity={0.85}>
            {loading ? <ActivityIndicator color="#fff" /> : (
              <>
                <Text style={s.payIcon}>💵</Text>
                <Text style={s.payBtnText}>Efectivo</Text>
              </>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[s.payBtn, s.payTransfer, loading && s.btnDisabled]}
            onPress={() => submit('entregado', 'transferencia')}
            disabled={loading}
            activeOpacity={0.85}>
            {loading ? <ActivityIndicator color="#fff" /> : (
              <>
                <Text style={s.payIcon}>🏦</Text>
                <Text style={s.payBtnText}>Transferencia</Text>
              </>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[s.payBtn, s.payOther, loading && s.btnDisabled]}
            onPress={() => submit('entregado', 'otro')}
            disabled={loading}
            activeOpacity={0.85}>
            <Text style={[s.payBtnText, { color: C.muted }]}>Otro / no corresponde</Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => setAskingPayment(false)}
            disabled={loading}
            activeOpacity={0.7}>
            <Text style={s.payCancel}>← Volver</Text>
          </TouchableOpacity>
        </View>
      ) : (
        /* ── Paso 1: acciones de la parada ── */
        <>
          <TouchableOpacity style={s.navBtn} onPress={openMaps} activeOpacity={0.85}>
            <Text style={s.navBtnText}>🗺  Navegar con Google Maps</Text>
          </TouchableOpacity>

          {!!phoneDigits && (
            <View style={s.contactRow}>
              <TouchableOpacity style={[s.callBtn, { flex: 1 }]} onPress={callCustomer} activeOpacity={0.85}>
                <Text style={s.callBtnText}>📞  Llamar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.callBtn, { flex: 1 }]} onPress={whatsappCustomer} activeOpacity={0.85}>
                <Text style={s.callBtnText}>💬  WhatsApp</Text>
              </TouchableOpacity>
            </View>
          )}

          {sellEnabled && catalog.length > 0 && (
            <View style={s.sellBox}>
              <TouchableOpacity style={s.sellHead} onPress={() => setShowPicker(v => !v)} activeOpacity={0.7}>
                <Text style={s.sellTitle}>🥚 Vender extra{extrasTotal > 0 ? ` · +${CLP(extrasTotal)}` : ''}</Text>
                <Text style={s.sellToggle}>{showPicker ? 'Cerrar' : 'Agregar'}</Text>
              </TouchableOpacity>
              {showPicker && catalog.map(p => {
                const q = extras[p.id]?.quantity || 0;
                return (
                  <View key={p.id} style={s.sellRow}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={s.sellName} numberOfLines={1}>{p.title}</Text>
                      <Text style={s.sellPrice}>{CLP(p.price)}</Text>
                    </View>
                    <TouchableOpacity style={s.stepBtn} onPress={() => bumpExtra(p, -1)}><Text style={s.stepTxt}>−</Text></TouchableOpacity>
                    <Text style={s.stepQty}>{q}</Text>
                    <TouchableOpacity style={s.stepBtn} onPress={() => bumpExtra(p, +1)}><Text style={s.stepTxt}>+</Text></TouchableOpacity>
                  </View>
                );
              })}
              {extrasList.length > 0 && (
                <Text style={s.sellSummary}>{extrasList.map(e => `${e.quantity}× ${e.title}`).join(', ')} = {CLP(extrasTotal)}</Text>
              )}
            </View>
          )}

          <View style={s.noteBox}>
            <Text style={s.noteLabel}>📝 Nota (opcional)</Text>
            <TextInput
              style={s.noteInput}
              value={note}
              onChangeText={setNote}
              placeholder="Ej: dejé con el conserje / cliente pidió llamar antes"
              placeholderTextColor={C.muted}
              multiline
              maxLength={500}
            />
          </View>

          <View style={s.statusRow}>
            <TouchableOpacity
              style={[s.statusBtn, s.deliveredBtn, loading && s.btnDisabled]}
              onPress={() => setAskingPayment(true)}
              disabled={loading}
              activeOpacity={0.85}>
              <Text style={s.statusIcon}>✓</Text>
              <Text style={s.statusBtnText}>Entregado</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[s.statusBtn, s.failedBtn, loading && s.btnDisabled]}
              onPress={markNotFound}
              disabled={loading}
              activeOpacity={0.85}>
              <Text style={s.statusIcon}>✕</Text>
              <Text style={[s.statusBtnText, { color: C.red }]}>No encontrado</Text>
            </TouchableOpacity>
          </View>
        </>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container:    { flex: 1, backgroundColor: C.bg },
  content:      { padding: 20, paddingBottom: 48, gap: 12 },

  noteBox:      { marginTop: 4 },
  noteLabel:    { color: C.muted, fontSize: 13, fontWeight: '600', marginBottom: 6 },
  noteInput:    { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 12, padding: 12, color: C.text, fontSize: 15, minHeight: 60, textAlignVertical: 'top' },

  paySub:       { color: C.green, fontSize: 15, fontWeight: '700', textAlign: 'center', marginTop: -6, marginBottom: 6 },

  sellBox:      { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 12, overflow: 'hidden' },
  sellHead:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 12 },
  sellTitle:    { color: C.text, fontSize: 15, fontWeight: '700' },
  sellToggle:   { color: C.green, fontSize: 14, fontWeight: '600' },
  sellRow:      { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: C.border },
  sellName:     { color: C.text, fontSize: 14, fontWeight: '600' },
  sellPrice:    { color: C.muted, fontSize: 13 },
  stepBtn:      { width: 34, height: 34, borderRadius: 8, backgroundColor: C.border, alignItems: 'center', justifyContent: 'center' },
  stepTxt:      { color: C.text, fontSize: 20, fontWeight: '800' },
  stepQty:      { color: C.text, fontSize: 16, fontWeight: '800', minWidth: 24, textAlign: 'center' },
  sellSummary:  { color: C.green, fontSize: 13, fontWeight: '600', padding: 12, borderTopWidth: 1, borderTopColor: C.border },

  badge:        { backgroundColor: C.blue + '22', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 6, alignSelf: 'flex-start', borderWidth: 1, borderColor: C.blue + '55' },
  badgeText:    { color: C.blue, fontWeight: '700', fontSize: 13 },

  customerName: { color: C.text, fontSize: 30, fontWeight: '900', letterSpacing: -0.5, marginTop: 4, marginBottom: 8 },

  infoCard:     { backgroundColor: C.card, borderRadius: 12, padding: 16, borderWidth: 1, borderColor: C.border },
  infoLabel:    { color: C.muted, fontSize: 12, fontWeight: '600', marginBottom: 6 },
  infoValue:    { color: C.text, fontSize: 17, fontWeight: '600', lineHeight: 24 },
  infoCity:     { color: C.muted, fontSize: 14, marginTop: 2 },

  navBtn:       { backgroundColor: C.blue, borderRadius: 14, padding: 18, alignItems: 'center', marginTop: 8 },
  navBtnText:   { color: '#fff', fontWeight: '800', fontSize: 16 },

  contactRow:   { flexDirection: 'row', gap: 10 },
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
  donePay:      { color: C.muted, fontSize: 14, textAlign: 'center', paddingHorizontal: 20 },
  doneSub:      { color: C.muted, fontSize: 14 },

  payBox:       { gap: 12, marginTop: 8 },
  payTitle:     { color: C.text, fontSize: 19, fontWeight: '800', textAlign: 'center', marginBottom: 4 },
  payBtn:       { borderRadius: 14, padding: 20, alignItems: 'center', gap: 4 },
  payCash:      { backgroundColor: C.green },
  payTransfer:  { backgroundColor: C.blue },
  payOther:     { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, padding: 14 },
  payIcon:      { fontSize: 30 },
  payBtnText:   { color: '#fff', fontWeight: '800', fontSize: 17 },
  payCancel:    { color: C.muted, fontSize: 15, textAlign: 'center', padding: 12 },
});
