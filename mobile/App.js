/**
 * App de despachos — punto de entrada.
 *
 * Flujo: Login → Rutas (lista de rutas asignadas) → Ruta (mapa + paradas) → Parada.
 *
 * La sesión se valida contra el backend al arrancar: si el token expiró (dura
 * 7 días) o el usuario ya no existe, se vuelve al login en vez de mostrar
 * errores en cada pantalla.
 */
import 'react-native-gesture-handler';
import React, { useState, useEffect, useCallback } from 'react';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Updates from 'expo-updates';

import LoginScreen   from './src/screens/LoginScreen';
import OrdersScreen  from './src/screens/OrdersScreen';
import RouteScreen   from './src/screens/RouteScreen';
import StopScreen    from './src/screens/StopScreen';
import { logout, getSavedSession, validateSession, onSessionExpired } from './src/services/api';

const Stack = createNativeStackNavigator();

const BG    = '#0f172a';
const GREEN = '#22c55e';

const navTheme = {
  ...DefaultTheme,
  dark: true,
  colors: { ...DefaultTheme.colors, background: BG, card: '#1e293b', text: '#f1f5f9', border: '#334155', primary: GREEN },
};

export default function App() {
  const [user,    setUser]    = useState(null);
  const [loading, setLoading] = useState(true);

  // Restaurar sesión guardada y validarla contra el backend
  useEffect(() => {
    (async () => {
      try {
        const saved = await getSavedSession();
        if (!saved.token) { setUser(null); return; }
        // Mostrar la app con el usuario guardado de inmediato; validar en paralelo.
        setUser(saved.user || { name: '' });
        try {
          const fresh = await validateSession();
          if (fresh) setUser(fresh);
        } catch (err) {
          // Sin red: mantener la sesión local. Un 401 ya la limpió vía interceptor.
          if (err.response?.status === 401) setUser(null);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Cuando cualquier llamada devuelve 401 → volver al login
  useEffect(() => onSessionExpired(() => setUser(null)), []);

  // Actualización OTA al abrir: si hay una versión nueva publicada con
  // `eas update`, se descarga y la app se reinicia sola (tarda 1-3 s con
  // buena señal). Sin esto había que cerrar y abrir dos veces, y nadie sabía
  // si la actualización había llegado. Si falla (sin red, APK sin
  // expo-updates), se sigue con lo que hay — nunca bloquea el arranque.
  useEffect(() => {
    if (!Updates.isEnabled || __DEV__) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await Updates.checkForUpdateAsync();
        if (cancelled || !r.isAvailable) return;
        await Updates.fetchUpdateAsync();
        if (!cancelled) await Updates.reloadAsync();
      } catch (e) {
        console.log('[OTA] sin actualización aplicable:', e?.message);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleLogout = useCallback(async () => {
    await logout();
    setUser(null);
  }, []);

  if (loading) {
    return (
      <View style={s.splash}>
        <ActivityIndicator size="large" color={GREEN} />
        <StatusBar style="light" />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {!user ? (
        <LoginScreen onLogin={(data) => setUser(data.user || { name: '' })} />
      ) : (
        <NavigationContainer theme={navTheme}>
          <Stack.Navigator
            screenOptions={{
              headerStyle:      { backgroundColor: '#1e293b' },
              headerTintColor:  '#f1f5f9',
              headerTitleStyle: { fontWeight: '700' },
              contentStyle:     { backgroundColor: BG },
              animation:        'slide_from_right',
            }}>

            <Stack.Screen name="Orders" options={{ headerShown: false }}>
              {props => <OrdersScreen {...props} user={user} onLogout={handleLogout} />}
            </Stack.Screen>

            <Stack.Screen
              name="Route"
              component={RouteScreen}
              options={({ route }) => ({
                title: route.params?.routeName || 'Ruta',
                headerBackTitle: 'Rutas',
              })}
            />

            <Stack.Screen
              name="Stop"
              component={StopScreen}
              options={({ route }) => ({
                title: route.params?.stop?.customerName || 'Parada',
                headerBackTitle: 'Ruta',
              })}
            />

          </Stack.Navigator>
        </NavigationContainer>
      )}
    </SafeAreaProvider>
  );
}

const s = StyleSheet.create({
  splash: { flex: 1, backgroundColor: BG, alignItems: 'center', justifyContent: 'center' },
});
