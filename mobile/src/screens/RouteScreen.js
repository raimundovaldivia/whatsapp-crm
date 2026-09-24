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
import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Modal, TextInput,
  Image, Alert, ScrollView, Linking, Platform, ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import { getRoute, createExpense, getSavedSession } from '../services/api';
import { stopLabel, loadStopLabelMode, saveStopLabelMode } from '../utils/stopLabel';
import { enqueueExpense, flushExpenses, pendingCount, onQueueChange, legacyExpenses, recoverLegacyExpenses } from '../utils/expenseQueue';

const CLP = n => `$${Math.round(Number(n) || 0).toLocaleString('es-CL')}`;
const EXPENSE_CATS = ['Combustible', 'Peaje', 'Comida', 'Mantención', 'Otro'];

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
  postponed: '#a78bfa',   // reprogramado: el cliente pidió otro día
};

const PAY_LABEL = { efectivo: '💵 Efectivo', transferencia: '🏦 Transferencia', otro: 'Otro' };

function stopsOf(route) {
  const opt = Array.isArray(route?.optimized_route) ? route.optimized_route : [];
  if (opt.length > 0) return opt;
  const raw = Array.isArray(route?.orders) ? route.orders : [];
  return raw.map((o, i) => ({ ...o, stopNumber: i + 1 }));
}

const stopKeyOf = stop => `${stop.source}_${stop.id}`;

// Orden de despacho: suma cantidad por producto de las paradas de la ruta.
// Devuelve [[nombre, cantidad], ...] de mayor a menor.
function buildManifest(stops) {
  const totals = {};
  for (const st of (stops || [])) {
    for (const it of (st.items || [])) {
      const name = (it.name || it.title || it.product_name || 'Sin nombre').toString().trim() || 'Sin nombre';
      const qty  = Number(it.quantity) || 0;
      if (!qty) continue;
      totals[name] = (totals[name] || 0) + qty;
    }
  }
  return Object.entries(totals).sort((a, b) => b[1] - a[1]);
}

export default function RouteScreen({ route: navRoute, navigation }) {
  const { routeId } = navRoute.params;

  const [route,   setRoute]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [showManifest, setShowManifest] = useState(false);
  // Rótulo de paradas: números (1, 2, 3…) o letras (A, B, C… como Google Maps).
  const [labelMode, setLabelMode] = useState('numbers');
  useFocusEffect(useCallback(() => { loadStopLabelMode().then(setLabelMode); }, []));
  function toggleLabelMode() {
    const next = labelMode === 'letters' ? 'numbers' : 'letters';
    setLabelMode(next);
    saveStopLabelMode(next);
  }
  // Rendición de gastos (petróleo, peaje, etc.)
  const [expOpen,  setExpOpen]  = useState(false);
  const [expAmt,   setExpAmt]   = useState('');
  const [expCat,   setExpCat]   = useState('Combustible');
  const [expNote,  setExpNote]  = useState('');
  const [expPhoto, setExpPhoto] = useState(null); // { uri, base64 }
  const [expSaving, setExpSaving] = useState(false);
  const [expPending, setExpPending] = useState(0);   // gastos guardados en el teléfono sin subir
  useFocusEffect(useCallback(() => {
    let alive = true;
    pendingCount().then(n => alive && setExpPending(n));
    const off = onQueueChange(n => alive && setExpPending(n));
    legacyExpenses().then(items => {
      if (!alive || !items.length) return;
      Alert.alert('Gastos anteriores', `Encontramos ${items.length} gastos de la versión anterior. Confirma que son tuyos y que no estén registrados antes de recuperarlos.`, [
        { text: 'Revisar después', style: 'cancel' },
        { text: 'Son míos, recuperar', onPress: () => recoverLegacyExpenses().then(() => flushExpenses()).catch(() => Alert.alert('No se pudo recuperar', 'Los gastos anteriores se conservaron. Intenta nuevamente.')) },
      ]);
    }).catch(() => {});
    flushExpenses().then(r => {
      if (!alive) return;
      if (r.uploaded > 0) Alert.alert('Gastos subidos', `Se subieron ${r.uploaded} gasto(s) que estaban pendientes ✅`);
      if (r.rejected?.length) Alert.alert('Gasto rechazado', `El servidor rechazó un gasto pendiente: ${r.rejected[0]}. Vuelve a cargarlo.`);
    }).catch(() => {});
    return () => { alive = false; off(); };
  }, []));

  async function takeExpensePhoto() {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) { Alert.alert('Permiso', 'Necesito permiso de cámara para la foto.'); return; }
      const r = await ImagePicker.launchCameraAsync({ quality: 0.4, base64: true });
      if (!r.canceled && r.assets?.[0]) setExpPhoto({ uri: r.assets[0].uri, base64: r.assets[0].base64 });
    } catch (e) { Alert.alert('Cámara', 'No se pudo abrir la cámara.'); }
  }
  function resetExpense() { setExpAmt(''); setExpCat('Combustible'); setExpNote(''); setExpPhoto(null); }
  async function saveExpense() {
    const amt = parseInt(String(expAmt).replace(/\D/g, '')) || 0;
    if (amt <= 0) { Alert.alert('Monto', 'Ingresa el monto del gasto.'); return; }
    setExpSaving(true);
    const payload = { clientRequestId: `expense_${Date.now()}_${Math.random().toString(36).slice(2, 14)}`, amount: amt, category: expCat, note: expNote, routeId,
      photoBase64: expPhoto?.base64 || null, photoMime: 'image/jpeg' };
    try {
      const session = await getSavedSession();
      payload._session = session;
      await createExpense(payload, session);
      setExpOpen(false); resetExpense();
      Alert.alert('Listo', 'Gasto registrado ✅');
    } catch (e) {
      const st = e.response?.status;
      if (st === 401) return;
      if (st === 400) { Alert.alert('No se pudo guardar', e.response?.data?.error || 'Revisa el monto o la foto.'); return; }
      // Sin señal / timeout / error del servidor → no perder el gasto: queda en el teléfono
      let n;
      try { const { _session, ...expense } = payload; n = await enqueueExpense(expense, _session); }
      catch { Alert.alert('No se pudo guardar', 'El gasto sigue en el formulario. Libera espacio e intenta de nuevo.'); return; }
      setExpOpen(false); resetExpense();
      Alert.alert('Guardado en el teléfono 📵',
        `No hay conexión ahora. El gasto quedó guardado y se subirá solo cuando vuelva la señal (${n} pendiente${n === 1 ? '' : 's'}).`);
    } finally { setExpSaving(false); }
  }

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
  const manifest   = buildManifest(stops);
  const manifestUnits = manifest.reduce((acc, [, q]) => acc + q, 0);
  const statuses   = route?.stop_statuses && typeof route.stop_statuses === 'object' ? route.stop_statuses : {};
  const payments   = route?.stop_payments && typeof route.stop_payments === 'object' ? route.stop_payments : {};
  const stateOf    = stop => statuses[stopKeyOf(stop)] || 'pending';
  const colorOf    = stop => STOP_COLORS[stateOf(stop)] || STOP_COLORS.pending;

  const doneCount   = stops.filter(st => stateOf(st) === 'entregado').length;
  const failedCount = stops.filter(st => stateOf(st) === 'cancelled').length;
  const postponedCount = stops.filter(st => stateOf(st) === 'postponed').length;
  const allDone     = stops.length > 0 && doneCount + failedCount + postponedCount === stops.length;

  // Próxima parada pendiente: se resalta para que el chofer no tenga que buscar
  const nextPending = stops.find(st => stateOf(st) === 'pending');

  function openStopDetail(stop) {
    const notes = route?.stop_notes && typeof route.stop_notes === 'object' ? route.stop_notes : {};
    navigation.navigate('Stop', {
      stop: { ...stop, note: notes[stopKeyOf(stop)] || '' },
      routeId,
      stopKey:    stopKeyOf(stop),
      stopNumber: stop.stopNumber,
      stopLabel:  stopLabel(stop.stopNumber, labelMode),
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
      {/* Lista de paradas (sin mapa embebido: el chofer navega con "Abrir en Maps") */}
      <View style={s.listContainer}>
        <View style={s.listHeader}>
          <Text style={s.listTitle} numberOfLines={1}>
            Paradas ({stops.length}) · ✓{doneCount}/{stops.length}
          </Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity onPress={toggleLabelMode} style={s.labelBtn} accessibilityLabel="Cambiar numeración de paradas">
              <Text style={[s.labelBtnText, labelMode === 'numbers' && s.labelBtnOn]}>123</Text>
              <Text style={s.labelBtnSep}>|</Text>
              <Text style={[s.labelBtnText, labelMode === 'letters' && s.labelBtnOn]}>ABC</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setExpOpen(true)} style={s.gastoBtn}>
              <Text style={s.gastoBtnText}>💸 Gasto</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={openFullRouteInMaps} style={s.mapsBtn}>
              <Text style={s.mapsBtnText}>Maps</Text>
            </TouchableOpacity>
          </View>
        </View>

        {expPending > 0 && (
          <TouchableOpacity onPress={() => flushExpenses().then(r => r.uploaded ? Alert.alert('Listo', `Se subieron ${r.uploaded} gasto(s) ✅`) : Alert.alert('Sin conexión', 'Todavía no se pueden subir. Se reintenta solo.'))}
            style={s.pendingBar} activeOpacity={0.8}>
            <Text style={s.pendingBarText}>📵 {expPending} gasto{expPending === 1 ? '' : 's'} guardado{expPending === 1 ? '' : 's'} en el teléfono, sin subir · toca para reintentar</Text>
          </TouchableOpacity>
        )}

        <FlatList
          data={stops}
          keyExtractor={stopKeyOf}
          refreshing={loading}
          onRefresh={load}
          ListHeaderComponent={manifest.length > 0 ? (
            <View style={s.manifestCard}>
              <TouchableOpacity style={s.manifestHead} onPress={() => setShowManifest(v => !v)} activeOpacity={0.7}>
                <Text style={s.manifestTitle}>📦 Lo que llevas · {manifestUnits} u.</Text>
                <Text style={s.manifestToggle}>{showManifest ? 'Ocultar' : 'Ver'}</Text>
              </TouchableOpacity>
              {showManifest && manifest.map(([name, qty]) => (
                <View key={name} style={s.manifestRow}>
                  <Text style={s.manifestName} numberOfLines={1}>{name}</Text>
                  <Text style={s.manifestQty}>{qty}</Text>
                </View>
              ))}
            </View>
          ) : null}
          renderItem={({ item: stop }) => {
            const state  = stateOf(stop);
            const color  = colorOf(stop);
            const isDone = state !== 'pending';
            const isNext = nextPending && stopKeyOf(nextPending) === stopKeyOf(stop);
            const pay    = payments[stopKeyOf(stop)];
            return (
              <TouchableOpacity
                style={[s.stopCard, isDone && s.stopDone, isNext && s.stopNext]}
                onPress={() => openStopDetail(stop)}
                activeOpacity={0.75}>
                <View style={[s.stopNum, { backgroundColor: color }]}>
                  <Text style={[s.stopNumText, labelMode === 'letters' && String(stopLabel(stop.stopNumber, labelMode)).length > 1 && { fontSize: 12 }]}>{stopLabel(stop.stopNumber, labelMode)}</Text>
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
                    {state === 'entregado' ? 'Entregado' : state === 'cancelled' ? 'Fallido' : state === 'postponed' ? 'Reprogramado' : isNext ? 'Siguiente' : 'Pendiente'}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          }}
          ListFooterComponent={allDone ? (
            <View style={s.summary}>
              <Text style={s.summaryText}>
                🎉 Ruta completada: {doneCount} entregados · {failedCount} fallidos{postponedCount ? ` · ${postponedCount} reprogramados` : ''}
              </Text>
            </View>
          ) : null}
        />
      </View>

      {/* Modal: rendir gasto */}
      <Modal visible={expOpen} transparent animationType="slide" onRequestClose={() => setExpOpen(false)}>
        <View style={s.modalWrap}>
          <View style={s.modalCard}>
            <ScrollView>
              <Text style={s.modalTitle}>💸 Rendir gasto</Text>

              <Text style={s.fieldLabel}>Monto</Text>
              <TextInput style={s.input} value={expAmt} onChangeText={setExpAmt}
                placeholder="$" placeholderTextColor={C.muted} keyboardType="number-pad" />

              <Text style={s.fieldLabel}>Categoría</Text>
              <View style={s.catRow}>
                {EXPENSE_CATS.map(c => (
                  <TouchableOpacity key={c} onPress={() => setExpCat(c)}
                    style={[s.catChip, expCat === c && s.catChipOn]}>
                    <Text style={[s.catChipTxt, expCat === c && s.catChipTxtOn]}>{c}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={s.fieldLabel}>Nota (opcional)</Text>
              <TextInput style={[s.input, { minHeight: 50, textAlignVertical: 'top' }]} value={expNote}
                onChangeText={setExpNote} placeholder="Ej: petróleo estación Copec" placeholderTextColor={C.muted} multiline />

              <TouchableOpacity style={s.photoBtn} onPress={takeExpensePhoto}>
                <Text style={s.photoBtnTxt}>{expPhoto ? '📷 Cambiar foto' : '📷 Tomar foto (boleta)'}</Text>
              </TouchableOpacity>
              {expPhoto ? <Image source={{ uri: expPhoto.uri }} style={s.photoPreview} /> : null}

              <View style={s.modalActions}>
                <TouchableOpacity style={s.cancelBtn} onPress={() => { setExpOpen(false); }} disabled={expSaving}>
                  <Text style={s.cancelTxt}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity style={s.saveBtn} onPress={saveExpense} disabled={expSaving}>
                  <Text style={s.saveTxt}>{expSaving ? 'Guardando…' : 'Guardar gasto'}</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container:    { flex: 1, backgroundColor: C.bg },
  center:       { flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  errorText:    { color: C.red, fontSize: 14, textAlign: 'center' },
  retryBtn:     { backgroundColor: C.card, borderRadius: 10, paddingHorizontal: 20, paddingVertical: 10, borderWidth: 1, borderColor: C.border },
  retryText:    { color: C.text, fontWeight: '600' },

  manifestCard: { backgroundColor: C.card, borderRadius: 12, borderWidth: 1, borderColor: C.border, marginHorizontal: 12, marginTop: 10, marginBottom: 10, overflow: 'hidden' },
  manifestHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 11 },
  manifestTitle:{ color: C.text, fontWeight: '700', fontSize: 14 },
  manifestToggle:{ color: C.green, fontWeight: '600', fontSize: 13 },
  manifestRow:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 7, borderTopWidth: 1, borderTopColor: C.border },
  manifestName: { color: C.muted, fontSize: 14, flex: 1, marginRight: 10 },
  manifestQty:  { color: C.text, fontWeight: '800', fontSize: 15 },

  listContainer:{ flex: 1 },
  listHeader:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border },
  listTitle:    { color: C.text, fontWeight: '700', fontSize: 15 },
  mapsBtn:      { backgroundColor: C.blue + '22', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: C.blue + '44' },
  mapsBtnText:  { color: C.blue, fontSize: 12, fontWeight: '600' },
  pendingBar:     { backgroundColor: '#3a2a10', borderBottomWidth: 1, borderBottomColor: '#fb923c55', paddingHorizontal: 14, paddingVertical: 8 },
  pendingBarText: { color: '#fbbf24', fontSize: 12, fontWeight: '600' },
  labelBtn:     { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, borderWidth: 1, borderColor: C.border, gap: 4 },
  labelBtnText: { color: C.muted, fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  labelBtnOn:   { color: C.text },
  labelBtnSep:  { color: C.border, fontSize: 11 },
  gastoBtn:     { backgroundColor: C.orange + '22', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: C.orange + '55' },
  gastoBtnText: { color: C.orange, fontSize: 12, fontWeight: '700' },

  modalWrap:    { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  modalCard:    { backgroundColor: C.bg, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 20, maxHeight: '90%', borderTopWidth: 1, borderColor: C.border },
  modalTitle:   { color: C.text, fontSize: 18, fontWeight: '800', marginBottom: 14 },
  fieldLabel:   { color: C.muted, fontSize: 13, fontWeight: '600', marginBottom: 6, marginTop: 10 },
  input:        { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 12, padding: 12, color: C.text, fontSize: 16 },
  catRow:       { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  catChip:      { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8 },
  catChipOn:    { backgroundColor: C.orange + '22', borderColor: C.orange },
  catChipTxt:   { color: C.muted, fontSize: 13, fontWeight: '600' },
  catChipTxtOn: { color: C.orange },
  photoBtn:     { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 12, padding: 14, alignItems: 'center', marginTop: 14 },
  photoBtnTxt:  { color: C.blue, fontSize: 14, fontWeight: '600' },
  photoPreview: { width: '100%', height: 180, borderRadius: 12, marginTop: 10, resizeMode: 'cover' },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: 18 },
  cancelBtn:    { flex: 1, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: C.border, alignItems: 'center' },
  cancelTxt:    { color: C.muted, fontWeight: '600' },
  saveBtn:      { flex: 2, padding: 14, borderRadius: 12, backgroundColor: C.green, alignItems: 'center' },
  saveTxt:      { color: '#04210f', fontWeight: '800', fontSize: 15 },

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
