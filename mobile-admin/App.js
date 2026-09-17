/**
 * App.js — Central (admin). Login → tabs: Chat, Pedidos, Repartos, Avisos.
 */
import React, { useEffect, useState, useCallback } from 'react';
import { View, ActivityIndicator, StatusBar } from 'react-native';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { colors } from './src/theme';
import { getSession, clearSession, onSessionExpired } from './src/services/api';
import { registerForPush } from './src/push';

import LoginScreen from './src/screens/LoginScreen';
import ChatListScreen from './src/screens/ChatListScreen';
import ChatDetailScreen from './src/screens/ChatDetailScreen';
import PedidosScreen from './src/screens/PedidosScreen';
import RepartosScreen from './src/screens/RepartosScreen';
import AvisosScreen from './src/screens/AvisosScreen';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

const navTheme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, background: colors.bg, card: colors.bgPanel, text: colors.textPrimary, border: colors.border, primary: colors.green },
};

function ChatStack() {
  return (
    <Stack.Navigator screenOptions={{ headerStyle: { backgroundColor: colors.bgPanel }, headerTintColor: colors.textPrimary, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Screen name="ChatList" component={ChatListScreen} options={{ title: 'Conversaciones' }} />
      <Stack.Screen name="ChatDetail" component={ChatDetailScreen} options={{ title: 'Chat' }} />
    </Stack.Navigator>
  );
}

function Tabs({ onLogout }) {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerStyle: { backgroundColor: colors.bgPanel },
        headerTintColor: colors.textPrimary,
        tabBarStyle: { backgroundColor: colors.bgPanel, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.green,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarIcon: ({ color, size }) => {
          const icon = { Chat: 'chatbubbles', Pedidos: 'receipt', Repartos: 'car', Avisos: 'notifications' }[route.name] || 'ellipse';
          return <Ionicons name={icon} size={size} color={color} />;
        },
      })}
    >
      <Tab.Screen name="Chat" component={ChatStack} options={{ headerShown: false }} />
      <Tab.Screen name="Pedidos" component={PedidosScreen} />
      <Tab.Screen name="Repartos" component={RepartosScreen} />
      <Tab.Screen name="Avisos">
        {props => <AvisosScreen {...props} onLogout={onLogout} />}
      </Tab.Screen>
    </Tab.Navigator>
  );
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);

  const check = useCallback(async () => {
    const { token } = await getSession();
    setAuthed(!!token);
    setReady(true);
    if (token) registerForPush();
  }, []);

  useEffect(() => { check(); }, [check]);
  useEffect(() => onSessionExpired(() => setAuthed(false)), []);

  const onLoggedIn = async () => { setAuthed(true); registerForPush(); };
  const onLogout = async () => { await clearSession(); setAuthed(false); };

  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.green} size="large" />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor={colors.bgPanel} />
      <NavigationContainer theme={navTheme}>
        {authed ? <Tabs onLogout={onLogout} /> : <LoginScreen onLoggedIn={onLoggedIn} />}
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
