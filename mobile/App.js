import 'react-native-gesture-handler';
import React, { useState, useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import LoginScreen   from './src/screens/LoginScreen';
import OrdersScreen  from './src/screens/OrdersScreen';
import RouteScreen   from './src/screens/RouteScreen';
import StopScreen    from './src/screens/StopScreen';
import { logout }    from './src/services/api';

const Stack = createNativeStackNavigator();

const BG = '#0f172a';
const GREEN = '#22c55e';

export default function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [loading,       setLoading]       = useState(true);

  // Comprobar si hay sesión guardada
  useEffect(() => {
    AsyncStorage.getItem('crm_token').then(token => {
      setAuthenticated(!!token);
      setLoading(false);
    });
  }, []);

  async function handleLogout() {
    await logout();
    setAuthenticated(false);
  }

  if (loading) {
    return (
      <View style={s.splash}>
        <ActivityIndicator size="large" color={GREEN} />
        <StatusBar style="light" />
      </View>
    );
  }

  if (!authenticated) {
    return (
      <>
        <LoginScreen onLogin={() => setAuthenticated(true)} />
        <StatusBar style="light" />
      </>
    );
  }

  return (
    <NavigationContainer>
      <StatusBar style="light" />
      <Stack.Navigator
        screenOptions={{
          headerStyle:      { backgroundColor: '#1e293b' },
          headerTintColor:  '#f1f5f9',
          headerTitleStyle: { fontWeight: '700' },
          contentStyle:     { backgroundColor: BG },
          animation:        'slide_from_right',
        }}>

        <Stack.Screen
          name="Orders"
          options={{ headerShown: false }}>
          {props => <OrdersScreen {...props} onLogout={handleLogout} />}
        </Stack.Screen>

        <Stack.Screen
          name="Route"
          component={RouteScreen}
          options={{
            title: 'Ruta optimizada',
            headerBackTitle: 'Pedidos',
          }}
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
  );
}

const s = StyleSheet.create({
  splash: { flex: 1, backgroundColor: BG, alignItems: 'center', justifyContent: 'center' },
});
