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
import { login, getSavedSession } from '../services/api';
import { DEFAULT_API_URL, APP_NAME, APP_VERSION } from '../config';

const C = {
  bg:      '#0f172a',
  card:    '#1e293b',
  border:  '#334155',
  green:   '#22c55e',
  text:    '#f1f5f9',
  muted:   '#94a3b8',
  error:   '#f87171',
};

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
          <Text style={s.logoIcon}>🚚</Text>
          <Text style={s.title}>{APP_NAME}</Text>
          <Text style={s.subtitle}>App del repartidor</Text>
        </View>

        {/* Formulario */}
        <View style={s.card}>
          <Text style={s.label}>Correo</Text>
          <TextInput
            style={s.input}
            value={email}
            onChangeText={setEmail}
            placeholder="repartidor@mitienda.cl"
            placeholderTextColor={C.muted}
            autoCapitalize="none"
            keyboardType="email-address"
            autoCorrect={false}
            autoComplete="email"
            textContentType="emailAddress"
            returnKeyType="next"
          />

          <Text style={s.label}>Contraseña</Text>
          <TextInput
            style={s.input}
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            placeholderTextColor={C.muted}
            secureTextEntry
            autoComplete="password"
            textContentType="password"
            returnKeyType="go"
            onSubmitEditing={handleLogin}
          />

          <TouchableOpacity
            style={[s.btn, loading && s.btnDisabled]}
            onPress={handleLogin}
            disabled={loading}
            activeOpacity={0.8}>
            {loading
              ? <ActivityIndicator color="#fff" />
              : <Text style={s.btnText}>Iniciar sesión</Text>}
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
                style={s.input}
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

        <Text style={s.version}>v{APP_VERSION}</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  flex:       { flex: 1, backgroundColor: C.bg },
  container:  { flexGrow: 1, justifyContent: 'center', padding: 24 },
  logoBox:    { alignItems: 'center', marginBottom: 32 },
  logoIcon:   { fontSize: 56, marginBottom: 12 },
  title:      { fontSize: 28, fontWeight: '800', color: C.text, letterSpacing: -0.5 },
  subtitle:   { fontSize: 14, color: C.muted, marginTop: 4 },
  card:       { backgroundColor: C.card, borderRadius: 16, padding: 24, gap: 4 },
  label:      { fontSize: 13, color: C.muted, fontWeight: '600', marginTop: 14, marginBottom: 6 },
  input:      {
    backgroundColor: '#0f172a', borderWidth: 1, borderColor: C.border,
    borderRadius: 10, padding: 14, color: C.text, fontSize: 16,
  },
  hint:       { fontSize: 12, color: C.muted, marginTop: 6 },
  btn:        {
    backgroundColor: C.green, borderRadius: 12, padding: 16,
    alignItems: 'center', marginTop: 24,
  },
  btnDisabled:{ opacity: 0.6 },
  btnText:    { color: '#fff', fontWeight: '700', fontSize: 16 },
  advancedToggle: { alignItems: 'center', paddingVertical: 12, marginTop: 6 },
  advancedText:   { color: C.muted, fontSize: 13 },
  version:    { color: C.border, fontSize: 12, textAlign: 'center', marginTop: 20 },
});
