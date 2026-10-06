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
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { NavigationContainer, DefaultTheme, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Updates from 'expo-updates';

import LoginScreen   from './src/screens/LoginScreen';
import OrdersScreen  from './src/screens/OrdersScreen';
import RouteScreen   from './src/screens/RouteScreen';
import RouteMapScreen from './src/screens/RouteMapScreen';
import HistoryScreen from './src/screens/HistoryScreen';
import ReturnsScreen from './src/screens/ReturnsScreen';
import ExpensesScreen from './src/screens/ExpensesScreen';
import StopScreen    from './src/screens/StopScreen';
import CustomerChatScreen from './src/screens/CustomerChatScreen';
import { logout, getSavedSession, validateSession, onSessionExpired } from './src/services/api';
import { registerForPush, unregisterForPush, listenForRouteNotifications } from './src/push';
import { C } from './src/theme';

const Stack = createNativeStackNavigator();
const navigationRef = createNavigationContainerRef();

const navTheme = {
  ...DefaultTheme,
  dark: true,
  colors: { ...DefaultTheme.colors, background: C.bg, card: C.card, text: C.text, border: C.borderSoft, primary: C.green },
};

export default function App() {
  const [user,    setUser]    = useState(null);
  const [loading, setLoading] = useState(true);
  const pendingRoute = useRef(null);

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

  useEffect(() => {
    if (!user) return;
    registerForPush();
    return listenForRouteNotifications(route => {
      if (navigationRef.isReady()) navigationRef.navigate('Route', route);
      else pendingRoute.current = route;
    });
  }, [user]);

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
    await unregisterForPush();
    await logout();
    setUser(null);
  }, []);

  if (loading) {
    return (
      <View style={s.splash}>
        <ActivityIndicator size="large" color={C.green} />
        <StatusBar style="light" />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={s.appRoot}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        {!user ? (
          <LoginScreen onLogin={(data) => setUser(data.user || { name: '' })} />
        ) : (
          <NavigationContainer ref={navigationRef} theme={navTheme} onReady={() => {
            if (pendingRoute.current) {
              navigationRef.navigate('Route', pendingRoute.current);
              pendingRoute.current = null;
            }
          }}>
          <Stack.Navigator
            screenOptions={{
              headerStyle:      { backgroundColor: C.card },
              headerShadowVisible: false,
              headerTintColor:  C.text,
              headerTitleStyle: { fontWeight: '800', fontSize: 17 },
              headerBackButtonDisplayMode: 'minimal',
              contentStyle:     { backgroundColor: C.bg },
              animation:        'slide_from_right',
            }}>

            <Stack.Screen name="Orders" options={{ headerShown: false }}>
              {props => <OrdersScreen {...props} user={user} onLogout={handleLogout} />}
            </Stack.Screen>

            <Stack.Screen
              name="History"
              component={HistoryScreen}
              options={{ title: 'Rutas anteriores', headerBackTitle: 'Rutas' }}
            />

            <Stack.Screen name="Returns" component={ReturnsScreen} options={{ title: 'Cambios y devoluciones', headerBackTitle: 'Rutas' }} />
            <Stack.Screen
              name="Expenses"
              component={ExpensesScreen}
              options={{ title: 'Mis gastos', headerBackTitle: 'Rutas' }}
            />

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

            <Stack.Screen
              name="CustomerChat"
              component={CustomerChatScreen}
              options={({ route }) => ({
                title: route.params?.stop?.customerName || 'Chat del cliente',
                headerBackTitle: 'Parada',
              })}
            />

            <Stack.Screen
              name="RouteMap"
              component={RouteMapScreen}
              options={{ title: 'Mapa de la ruta', headerBackTitle: 'Ruta' }}
            />

          </Stack.Navigator>
          </NavigationContainer>
        )}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const s = StyleSheet.create({
  appRoot: { flex: 1 },
  splash: { flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center' },
});
