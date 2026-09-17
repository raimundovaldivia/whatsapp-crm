import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { colors } from '../theme';
import { APP_NAME } from '../config';
import { login } from '../services/api';

export default function LoginScreen({ onLoggedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit() {
    if (!email.trim() || !password) { setError('Ingresa email y contraseña'); return; }
    setBusy(true); setError(null);
    try {
      await login(email.trim(), password);
      onLoggedIn();
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'No se pudo iniciar sesión');
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 24 }}>
        <Text style={{ color: colors.green, fontSize: 30, fontWeight: '800', textAlign: 'center' }}>Diez Ríos</Text>
        <Text style={{ color: colors.textSecondary, fontSize: 15, textAlign: 'center', marginBottom: 28 }}>{APP_NAME} · panel del administrador</Text>

        <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 6 }}>Email</Text>
        <TextInput
          value={email} onChangeText={setEmail}
          autoCapitalize="none" keyboardType="email-address" autoCorrect={false}
          placeholder="tu@correo.cl" placeholderTextColor={colors.textMuted}
          style={inp}
        />
        <Text style={{ color: colors.textSecondary, fontSize: 13, marginTop: 16, marginBottom: 6 }}>Contraseña</Text>
        <TextInput
          value={password} onChangeText={setPassword}
          secureTextEntry placeholder="••••••••" placeholderTextColor={colors.textMuted}
          style={inp} onSubmitEditing={submit}
        />

        {error && <Text style={{ color: colors.red, fontSize: 13, marginTop: 14 }}>{error}</Text>}

        <TouchableOpacity onPress={submit} disabled={busy}
          style={{ backgroundColor: colors.green, borderRadius: 12, padding: 15, marginTop: 24, alignItems: 'center', opacity: busy ? 0.6 : 1 }}>
          {busy ? <ActivityIndicator color="#04210f" /> : <Text style={{ color: '#04210f', fontWeight: '800', fontSize: 15 }}>Entrar</Text>}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const inp = {
  backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border,
  borderRadius: 10, padding: 13, color: colors.textPrimary, fontSize: 15,
};
