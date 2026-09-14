/**
 * UpdateStatus — Pie con la versión instalada y estado de las
 * actualizaciones OTA (expo-updates), más un botón para buscar una ahora.
 *
 * Sirve para saber, desde el teléfono, si la app está recibiendo los
 * `eas update`: muestra el canal, el ID del update que corre y cuándo se
 * publicó. Si el APK se compiló sin expo-updates, lo dice claramente en vez
 * de dejar al usuario adivinando por qué "no se actualiza".
 */
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import * as Updates from 'expo-updates';
import { APP_VERSION } from '../config';

const C = { text: '#94a3b8', dim: '#475569', green: '#22c55e', card: '#1e293b', border: '#334155' };

function describe() {
  if (!Updates.isEnabled) return { line: 'OTA: no disponible en este APK (hay que compilar uno nuevo)', ok: false };
  const short = Updates.updateId ? String(Updates.updateId).slice(0, 8) : null;
  const when  = Updates.createdAt ? new Date(Updates.createdAt).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : null;
  if (Updates.isEmbeddedLaunch || !short) {
    return { line: `OTA activo · canal ${Updates.channel || '—'} · corriendo la versión del APK (sin update aplicado)`, ok: true };
  }
  return { line: `OTA activo · canal ${Updates.channel || '—'} · update ${short}${when ? ` (${when})` : ''}`, ok: true };
}

export default function UpdateStatus({ style }) {
  const [busy, setBusy] = useState(false);
  const info = describe();

  async function check() {
    if (!Updates.isEnabled) {
      Alert.alert('Sin actualizaciones OTA', 'Este APK se compiló sin expo-updates. Hay que instalar un APK nuevo; después de eso las actualizaciones llegan solas.');
      return;
    }
    setBusy(true);
    try {
      const r = await Updates.checkForUpdateAsync();
      if (!r.isAvailable) {
        Alert.alert('Al día', 'Ya tienes la última versión publicada.');
        return;
      }
      await Updates.fetchUpdateAsync();
      Alert.alert('Actualización lista', 'Se descargó una versión nueva. La app se va a reiniciar.', [
        { text: 'Reiniciar', onPress: () => Updates.reloadAsync() },
      ]);
    } catch (e) {
      Alert.alert('No se pudo buscar', e?.message || 'Revisa la conexión a internet e intenta de nuevo.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[s.wrap, style]}>
      <Text style={s.version}>v{APP_VERSION}</Text>
      <Text style={[s.line, !info.ok && s.warn]} numberOfLines={2}>{info.line}</Text>
      <TouchableOpacity onPress={check} disabled={busy} style={s.btn} activeOpacity={0.7}>
        {busy ? <ActivityIndicator size="small" color={C.green} /> : <Text style={s.btnText}>Buscar actualización</Text>}
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  wrap:    { alignItems: 'center', marginTop: 20, gap: 4, paddingHorizontal: 8 },
  version: { color: C.dim, fontSize: 12 },
  line:    { color: C.dim, fontSize: 11, textAlign: 'center' },
  warn:    { color: '#fb923c' },
  btn:     { marginTop: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  btnText: { color: C.text, fontSize: 12, fontWeight: '600' },
});
