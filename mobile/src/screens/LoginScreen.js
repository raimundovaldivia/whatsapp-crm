/**
 * LoginScreen — Acceso del repartidor.
 *
 * El servidor viene prellenado (config.js): el chofer solo pone email y clave.
 * "Cambiar servidor" queda escondido para no confundir; sirve para probar
 * contra otro ambiente.
 */
import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ActivityIndicator, Alert, ScrollView,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { login, getSavedSession } from '../services/api';
import { DEFAULT_API_URL, APP_NAME } from '../config';
import UpdateStatus from '../components/UpdateStatus';
import { C, R, shadow } from '../theme';

export default function LoginScreen({ onLogin }) {
  const [url,       setUrl]       = useState(DEFAULT_API_URL);
  const [showUrl,   setShowUrl]   = useState(false);
  const [email,     setEmail]     = useState('');
  const [password,  setPassword]  = useState('');
  const [loading,   setLoading]   = useState(false);

  // Si ya se usó otro servidor antes, recordarlo
  useEffect(() => {
    getSavedSession().then(s => { if (s.baseUrl) setUrl(s.baseUrl); }).catch(() => {});
  }, []);

  async function handleLogin() {
    if (!email.trim() || !password) {
      Alert.alert('Faltan datos', 'Escribe tu correo y tu contraseña.');
      return;
    }

    let baseUrl = url.trim() || DEFAULT_API_URL;
    if (!baseUrl.startsWith('http')) baseUrl = 'https://' + baseUrl;

    setLoading(true);
    try {
      const data = await login(baseUrl, email.trim().toLowerCase(), password);
      if (data.user && data.user.role && data.user.role !== 'repartidor') {
        // Las cuentas de administración también entran (para probar), pero se avisa.
        Alert.alert(
          'Cuenta de administración',
          'Esta cuenta no es de repartidor. Podrás ver las rutas, pero lo ideal es crear un usuario con rol "Repartidor" desde el CRM.',
          [{ text: 'Entendido', onPress: () => onLogin(data) }]
        );
        return;
      }
      onLogin(data);
    } catch (err) {
      const status = err.response?.status;
      const msg = status === 401 ? 'Correo o contraseña incorrectos.'
        : status === 403 ? (err.response?.data?.error || 'Esta cuenta no tiene acceso.')
        : err.code === 'ECONNABORTED' ? 'El servidor tardó demasiado en responder. Intenta de nuevo.'
        : err.response?.data?.error || err.message || 'No se pudo conectar con el servidor.';
      Alert.alert('No se pudo iniciar sesión', msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.container} keyboardShouldPersistTaps="handled">

        {/* Logo / Título */}
        <View style={s.logoBox}>
          <View style={s.brandMark}>
            <MaterialCommunityIcons name="truck-fast-outline" size={38} color={C.green} />
          </View>
          <Text style={s.title}>{APP_NAME}</Text>
          <Text style={s.subtitle}>Operación de última milla</Text>
        </View>

        {/* Formulario */}
        <View style={s.card}>
          <View style={s.cardHead}>
            <Text style={s.cardEyebrow}>ACCESO SEGURO</Text>
            <Text style={s.cardTitle}>Ingresa a tu jornada</Text>
          </View>
          <Text style={s.label}>Usuario o correo</Text>
          <View style={s.inputShell}>
            <MaterialCommunityIcons name="account-outline" size={20} color={C.muted} />
            <TextInput
              style={s.input}
              value={email}
              onChangeText={setEmail}
              placeholder="usuario o correo"
              placeholderTextColor={C.dim}
              autoCapitalize="none"
              keyboardType="default"
              autoCorrect={false}
              autoComplete="username"
              textContentType="username"
              returnKeyType="next"
            />
          </View>

          <Text style={s.label}>Contraseña</Text>
          <View style={s.inputShell}>
            <MaterialCommunityIcons name="lock-outline" size={20} color={C.muted} />
            <TextInput
              style={s.input}
              value={password}
              onChangeText={setPassword}
              placeholder="••••••••"
              placeholderTextColor={C.dim}
              secureTextEntry
              autoComplete="password"
              textContentType="password"
              returnKeyType="go"
              onSubmitEditing={handleLogin}
            />
          </View>

          <TouchableOpacity
            style={[s.btn, loading && s.btnDisabled]}
            onPress={handleLogin}
            disabled={loading}
            activeOpacity={0.8}>
            {loading
              ? <ActivityIndicator color="#fff" />
              : <View style={s.btnContent}><Text style={s.btnText}>Iniciar jornada</Text><MaterialCommunityIcons name="arrow-right" size={20} color={C.inkOnAccent} /></View>}
          </TouchableOpacity>

          {/* Servidor (avanzado) */}
          <TouchableOpacity onPress={() => setShowUrl(v => !v)} style={s.advancedToggle} activeOpacity={0.7}>
            <Text style={s.advancedText}>
              {showUrl ? '▾ Ocultar servidor' : '▸ Cambiar servidor'}
            </Text>
          </TouchableOpacity>
          {showUrl && (
            <>
              <Text style={s.label}>URL del servidor</Text>
              <TextInput
                style={s.serverInput}
                value={url}
                onChangeText={setUrl}
                placeholder={DEFAULT_API_URL}
                placeholderTextColor={C.muted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
              <Text style={s.hint}>Déjalo como está salvo que te indiquen otro.</Text>
            </>
          )}
        </View>

        <UpdateStatus />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  flex:       { flex: 1, backgroundColor: C.bg },
  container:  { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 22, paddingVertical: 36 },
  logoBox:    { alignItems: 'center', marginBottom: 30 },
  brandMark:  { width: 78, height: 78, borderRadius: 26, backgroundColor: '#0A2B31', borderWidth: 1, borderColor: '#1B6B69', alignItems: 'center', justifyContent: 'center', marginBottom: 16, ...shadow },
  title:      { fontSize: 31, fontWeight: '900', color: C.text, letterSpacing: -1 },
  subtitle:   { fontSize: 13, color: C.muted, marginTop: 5, letterSpacing: 0.4 },
  card:       { backgroundColor: C.card, borderRadius: R.xl, padding: 22, borderWidth: 1, borderColor: C.borderSoft, ...shadow },
  cardHead:   { marginBottom: 9 },
  cardEyebrow:{ color: C.green, fontSize: 10, fontWeight: '900', letterSpacing: 1.5 },
  cardTitle:  { color: C.text, fontSize: 21, fontWeight: '800', marginTop: 5, letterSpacing: -0.3 },
  label:      { fontSize: 12, color: C.textSoft, fontWeight: '700', marginTop: 16, marginBottom: 7 },
  inputShell: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 11, backgroundColor: C.bgSoft, borderWidth: 1, borderColor: C.border, borderRadius: R.md, paddingHorizontal: 15 },
  input:      { flex: 1, color: C.text, fontSize: 16, paddingVertical: 13 },
  serverInput:{ backgroundColor: C.bgSoft, borderWidth: 1, borderColor: C.border, borderRadius: R.md, padding: 14, color: C.text, fontSize: 14 },
  hint:       { fontSize: 12, color: C.muted, marginTop: 6 },
  btn:        {
    minHeight: 55, backgroundColor: C.green, borderRadius: R.md,
    alignItems: 'center', justifyContent: 'center', marginTop: 24,
  },
  btnDisabled:{ opacity: 0.6 },
  btnContent: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  btnText:    { color: C.inkOnAccent, fontWeight: '900', fontSize: 16 },
  advancedToggle: { alignItems: 'center', paddingVertical: 12, marginTop: 6 },
  advancedText:   { color: C.muted, fontSize: 13 },
  version:    { color: C.border, fontSize: 12, textAlign: 'center', marginTop: 20 },
});
