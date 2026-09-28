import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { registerPushToken, unregisterPushToken } from './services/api';

let currentToken = null;

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

async function expoToken() {
  const projectId = Constants?.expoConfig?.extra?.eas?.projectId || Constants?.easConfig?.projectId;
  const response = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
  return response.data;
}

export async function registerForPush() {
  try {
    if (!Device.isDevice) return null;
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Rutas y despachos',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#22c55e',
      });
    }
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') ({ status } = await Notifications.requestPermissionsAsync());
    if (status !== 'granted') return null;
    currentToken = await expoToken();
    if (currentToken) await registerPushToken(currentToken);
    return currentToken;
  } catch { return null; }
}

export async function unregisterForPush() {
  try {
    const token = currentToken || await expoToken();
    if (token) await unregisterPushToken(token);
  } catch {}
  currentToken = null;
}

export function listenForRouteNotifications(onRoute) {
  const open = response => {
    const data = response?.notification?.request?.content?.data || {};
    if (data.kind === 'delivery_route' && data.routeId) onRoute({ routeId: Number(data.routeId), routeName: data.routeName || 'Ruta' });
    Notifications.clearLastNotificationResponseAsync().catch(() => {});
  };
  const subscription = Notifications.addNotificationResponseReceivedListener(open);
  Notifications.getLastNotificationResponseAsync().then(response => { if (response) open(response); }).catch(() => {});
  return () => subscription.remove();
}
