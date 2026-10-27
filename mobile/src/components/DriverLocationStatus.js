import React, { useEffect, useRef, useState } from 'react';
import { AppState, Linking, Text, TouchableOpacity, View } from 'react-native';
import * as Location from 'expo-location';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getSavedSession, getActiveRoutes, updateDriverLocation } from '../services/api';
import { createDriverLocationTracker } from '../utils/driverLocation';
import { C } from '../theme';

const messages = {
  locating: 'Obteniendo ubicación para tus clientes…',
  sharing: 'Ubicación enviada al seguimiento del cliente',
  permission: 'Permite la ubicación para mostrar el reparto a tus clientes.',
  gps_off: 'Activa el GPS del teléfono para compartir la ubicación.',
  gps_error: 'Aún no hay una ubicación reciente. Reintentaremos automáticamente.',
  connection_error: 'No pudimos enviar la ubicación. Revisa internet; volveremos a intentarlo.',
  waiting_links: 'No hay enlaces activos para compartir la ubicación de esta ruta.',
  session_error: 'Vuelve a iniciar sesión para compartir la ubicación.',
  paused: 'Ubicación pausada mientras la app está en segundo plano.',
};

export default function DriverLocationStatus({ user }) {
  const insets = useSafeAreaInsets();
  const tracker = useRef(null);
  const [info, setInfo] = useState({ state: 'idle', lastSentAt: null });
  useEffect(() => {
    let alive = true;
    let current;
    setInfo({ state: 'idle', lastSentAt: null });
    getSavedSession().then(session => {
      if (!alive || !session.token || !session.user?.id || session.user.id !== user.id) return;
      current = createDriverLocationTracker({
        location: Location, user: session.user, onState: setInfo,
        getRoutes: signal => getActiveRoutes(session, signal),
        send: (id, coords, signal) => updateDriverLocation(id, coords, session, signal),
      });
      tracker.current = current;
      current.setActive(AppState.currentState === 'active');
      current.tick();
    }).catch(() => { if (alive) setInfo({ state: 'session_error' }); });
    const timer = setInterval(() => current?.tick(), 15000);
    const subscription = AppState.addEventListener('change', state => {
      current?.setActive(state === 'active');
      if (state === 'active') current?.tick();
    });
    return () => { alive = false; clearInterval(timer); subscription.remove(); current?.stop(); tracker.current = null; };
  }, [user.id, user.organization_id]);

  if (info.state === 'idle') return null;
  const good = info.state === 'sharing';
  return <View accessibilityRole="summary" style={{ backgroundColor: C.card, borderTopWidth: 1, borderColor: C.border, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 10 + insets.bottom }}>
    <Text accessibilityLiveRegion="polite" style={{ color: good ? C.green : C.orange, fontWeight: '700', fontSize: 13 }}>{messages[info.state]}</Text>
    {info.lastSentAt && <Text style={{ color: C.muted, fontSize: 12, marginTop: 3 }}>Último envío: {new Date(info.lastSentAt).toLocaleTimeString('es-CL')}</Text>}
    <Text style={{ color: C.muted, fontSize: 12, marginTop: 3 }}>Mantén Despachos abierta durante el reparto. Se detiene al cerrar la ruta.</Text>
    {!good && info.state !== 'locating' && <TouchableOpacity accessibilityRole="button"
      onPress={() => info.state === 'permission' && info.canAskAgain === false ? Linking.openSettings() : tracker.current?.tick(true)}
      style={{ paddingVertical: 9 }}><Text style={{ color: C.blue, fontWeight: '700' }}>{info.state === 'permission' && info.canAskAgain === false ? 'Abrir permisos' : 'Reintentar ubicación'}</Text></TouchableOpacity>}
  </View>;
}
