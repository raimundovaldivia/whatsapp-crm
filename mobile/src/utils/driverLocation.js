// One foreground tracker for the whole signed-in app, independent of navigation.
// Coordinates remain in memory only; every attempt obtains a fresh GPS reading.
export function createDriverLocationTracker({ location, getRoutes, send, user, onState,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let stopped = false;
  let active = true;
  let busy = false;
  let generation = 0;
  let asked = false;
  let lastSentAt = null;
  let controller = null;
  let hasRoute = false;
  const publish = (state, extra = {}) => {
    if (!stopped) onState({ state, lastSentAt, ...extra });
  };
  const owned = route => route.status === 'in_progress'
    && (Number(route.driver_user_id) === Number(user.id)
      || (route.driver_user_id == null && ['repartidor', 'coordinador'].includes(user.role)));

  async function tick(requestPermission = false) {
    if (stopped || !active || busy) return;
    busy = true;
    const run = generation;
    const abort = new AbortController();
    controller = abort;
    const current = () => !stopped && active && generation === run && !abort.signal.aborted;
    let timer;
    try {
      const result = await getRoutes(abort.signal);
      if (!current()) return;
      const routes = (result.routes || []).filter(owned);
      hasRoute = routes.length > 0;
      if (!hasRoute) { lastSentAt = null; publish('idle'); return; }
      if (!await location.hasServicesEnabledAsync()) { if (current()) publish('gps_off'); return; }
      if (!current()) return;
      let permission = await location.getForegroundPermissionsAsync();
      if (!current()) return;
      if (!permission.granted && (requestPermission || (!asked && permission.status === 'undetermined'))) {
        asked = true;
        permission = await location.requestForegroundPermissionsAsync();
      }
      if (!current()) return;
      if (!permission.granted) { publish('permission', { canAskAgain: permission.canAskAgain }); return; }
      publish('locating');
      const position = await Promise.race([
        location.getCurrentPositionAsync({ accuracy: location.Accuracy.Balanced }).catch(() => {
          throw Object.assign(new Error('GPS unavailable'), { code: 'GPS_TIMEOUT' });
        }),
        new Promise((_, reject) => { timer = setTimer(() => reject(Object.assign(new Error('GPS timeout'), { code: 'GPS_TIMEOUT' })), 20000); }),
      ]);
      clearTimer(timer);
      if (!current()) return;
      const coords = position?.coords;
      // Never give a cached/invalid fix a new server timestamp.
      if (!coords || !Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude)
        || Math.abs(coords.latitude) > 90 || Math.abs(coords.longitude) > 180
        || !Number.isFinite(position.timestamp) || now() - position.timestamp > 60000
        || position.timestamp > now() + 10000
        || (coords.accuracy != null && (!Number.isFinite(coords.accuracy) || coords.accuracy < 0 || coords.accuracy > 10000))) {
        publish('gps_error'); return;
      }
      let links = 0;
      for (const route of routes) {
        if (!current()) return;
        try {
          const result = await send(route.id, coords, abort.signal);
          if (!current()) return;
          links += Number(result?.activeLinks) || 0;
        } catch (error) {
          // A finished/reassigned route must not be retried using its old identity.
          if (error.response?.status === 404) continue;
          throw error;
        }
      }
      if (!current()) return;
      if (links > 0) { lastSentAt = now(); publish('sharing'); }
      else publish('waiting_links');
    } catch (error) {
      if (!current()) return;
      if (error.code === 'SESSION_CHANGED' || [401, 403].includes(error.response?.status)) {
        publish('session_error'); stopped = true;
      } else publish(error.code === 'GPS_TIMEOUT' ? 'gps_error' : 'connection_error');
    } finally {
      clearTimer(timer);
      busy = false;
      if (controller === abort) controller = null;
    }
  }
  return {
    tick,
    setActive(value) {
      active = value;
      generation += 1;
      controller?.abort();
      if (!value && hasRoute) publish('paused');
    },
    stop() { stopped = true; generation += 1; controller?.abort(); },
  };
}
