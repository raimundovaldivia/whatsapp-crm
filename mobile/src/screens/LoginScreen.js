import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ActivityIndicator, Alert, ScrollView,
} from 'react-native';
import { login } from '../services/api';

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
  const [url,      setUrl]      = useState('');
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [loading,  setLoading]  = useState(false);

  async function handleLogin() {
    if (!url.trim() || !email.trim() || !password.trim()) {
      Alert.alert('Campos requeridos', 'Completa todos los campos.');
      return;
    }

    // Normalizar URL
    let baseUrl = url.trim();
    if (!baseUrl.startsWith('http')) baseUrl = 'https://' + baseUrl;

    setLoading(true);
    try {
      const data = await login(baseUrl, email.trim(), password);
      if (data.token) {
        onLogin(data);
      } else {
        Alert.alert('Error', data.error || 'No se pudo iniciar sesión.');
      }
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Error de conexión';
      Alert.alert('Error de conexión', msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.container} keyboardShouldPersistTaps="handled">

        {/* Logo / Title */}
        <View style={s.logoBox}>
          <Text style={s.logoIcon}>🚚</Text>
          <Text style={s.title}>Delivery CRM</Text>
          <Text style={s.subtitle}>App del repartidor</Text>
        </View>

        {/* Form */}
        <View style={s.card}>
          <Text style={s.label}>URL del servidor</Text>
          <TextInput
            style={s.input}
            value={url}
            onChangeText={setUrl}
            placeholder="mi-tienda.railway.app"
            placeholderTextColor={C.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />

          <Text style={s.label}>Email</Text>
          <TextInput
            style={s.input}
            value={email}
            onChangeText={setEmail}
            placeholder="correo@ejemplo.com"
            placeholderTextColor={C.muted}
            autoCapitalize="none"
            keyboardType="email-address"
            autoCorrect={false}
          />

          <Text style={s.label}>Contraseña</Text>
          <TextInput
            style={s.input}
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            placeholderTextColor={C.muted}
            secureTextEntry
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
        </View>

      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  flex:       { flex: 1, backgroundColor: C.bg },
  container:  { flexGrow: 1, justifyContent: 'center', padding: 24 },
  logoBox:    { alignItems: 'center', marginBottom: 40 },
  logoIcon:   { fontSize: 56, marginBottom: 12 },
  title:      { fontSize: 28, fontWeight: '800', color: C.text, letterSpacing: -0.5 },
  subtitle:   { fontSize: 14, color: C.muted, marginTop: 4 },
  card:       { backgroundColor: C.card, borderRadius: 16, padding: 24, gap: 4 },
  label:      { fontSize: 13, color: C.muted, fontWeight: '600', marginTop: 14, marginBottom: 6 },
  input:      {
    backgroundColor: '#0f172a', borderWidth: 1, borderColor: C.border,
    borderRadius: 10, padding: 14, color: C.text, fontSize: 15,
  },
  btn:        {
    backgroundColor: C.green, borderRadius: 12, padding: 16,
    alignItems: 'center', marginTop: 24,
  },
  btnDisabled:{ opacity: 0.6 },
  btnText:    { color: '#fff', fontWeight: '700', fontSize: 16 },
});
