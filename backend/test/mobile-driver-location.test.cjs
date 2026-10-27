const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../mobile/src/utils/driverLocation.js'), 'utf8');
const { createDriverLocationTracker } = (() => {
  const module = { exports: {} };
  vm.runInNewContext(source.replace('export function', 'function') + '\nmodule.exports={createDriverLocationTracker};',
    { module, AbortController, setTimeout, clearTimeout });
  return module.exports;
})();
const now = 1793000000000;
const fix = () => ({ timestamp: now, coords: { latitude: -30, longitude: -71, accuracy: 12 } });
function fixture(overrides = {}) {
  const states = [], sends = [];
  let routes = [{ id: 48, driver_user_id: 10, status: 'in_progress' }];
  const location = {
    Accuracy: { Balanced: 3 }, hasServicesEnabledAsync: async () => true,
    getForegroundPermissionsAsync: async () => ({ granted: true }),
    requestForegroundPermissionsAsync: async () => ({ granted: true }),
    getCurrentPositionAsync: async () => fix(), ...overrides.location,
  };
  const tracker = createDriverLocationTracker({ location, user: { id: 10, role: 'repartidor' },
    now: () => now, getRoutes: async () => ({ routes }),
    send: async (id, coords, signal) => { sends.push({ id, coords, signal }); return { activeLinks: 8 }; },
    onState: state => states.push(state), ...overrides, location,
  });
  return { tracker, sends, states, routes: value => { routes = value; }, last: () => states.at(-1) };
}

test('first fix is sent without movement, subsequent refreshes stay fresh, only own active routes', async () => {
  const f = fixture();
  f.routes([{ id: 48, driver_user_id: 10, status: 'in_progress' },
    { id: 49, driver_user_id: 11, status: 'in_progress' },
    { id: 50, driver_user_id: 10, status: 'completed' }, { id: 51, driver_user_id: 10, status: 'sent' }]);
  await f.tracker.tick(); await f.tracker.tick();
  assert.deepEqual(f.sends.map(s => s.id), [48, 48]);
  assert.equal(f.last().state, 'sharing'); assert.equal(f.last().lastSentAt, now);
  f.routes([]); await f.tracker.tick(); assert.equal(f.last().state, 'idle');
  assert.equal(f.last().lastSentAt, null); f.tracker.stop();
});

test('administrators do not publish their location on routes assigned to others or unassigned', async () => {
  const f = fixture({ user: { id: 1, role: 'owner' } });
  f.routes([{ id: 48, driver_user_id: null, status: 'in_progress' }, { id: 49, driver_user_id: 10, status: 'in_progress' }]);
  await f.tracker.tick(); assert.equal(f.sends.length, 0); assert.equal(f.last().state, 'idle');
});

test('denied permission and disabled GPS are visible without sending or repeated prompts', async () => {
  let asked = 0;
  const f = fixture({ location: { getForegroundPermissionsAsync: async () => ({ granted: false, status: 'undetermined' }),
    requestForegroundPermissionsAsync: async () => { asked++; return { granted: false, canAskAgain: false }; } } });
  await f.tracker.tick(); assert.equal(f.last().state, 'permission'); assert.equal(f.last().canAskAgain, false);
  await f.tracker.tick(); assert.equal(asked, 1); assert.equal(f.sends.length, 0);
  const off = fixture({ location: { hasServicesEnabledAsync: async () => false } });
  await off.tracker.tick(); assert.equal(off.last().state, 'gps_off'); assert.equal(off.sends.length, 0);
});

test('timeouts, stale fixes and invalid coordinates never become fresh public positions', async () => {
  for (const value of [null, { ...fix(), timestamp: now - 61000 }, { ...fix(), timestamp: now + 11000 },
    { ...fix(), coords: { latitude: NaN, longitude: -71 } }, { ...fix(), coords: { latitude: -30, longitude: -71, accuracy: -1 } }]) {
    const f = fixture({ location: { getCurrentPositionAsync: async () => value } });
    await f.tracker.tick(); assert.equal(f.sends.length, 0); assert.equal(f.last().state, 'gps_error');
  }
  let timeout;
  const timed = fixture({ setTimer: callback => { timeout = callback; return 1; }, clearTimer: () => {},
    location: { getCurrentPositionAsync: () => new Promise(() => {}) } });
  const pending = timed.tracker.tick();
  while (!timeout) await new Promise(resolve => setImmediate(resolve));
  timeout(); await pending;
  assert.equal(timed.last().state, 'gps_error'); assert.equal(timed.sends.length, 0);
});

test('network failure retries; a zero-link acknowledgement does not claim the map received GPS', async () => {
  let attempt = 0;
  const f = fixture({ send: async () => { attempt++; if (attempt === 1) throw Error('offline'); return { activeLinks: attempt === 2 ? 0 : 1 }; } });
  await f.tracker.tick(); assert.equal(f.last().state, 'connection_error');
  await f.tracker.tick(); assert.equal(f.last().state, 'waiting_links'); assert.equal(f.last().lastSentAt, null);
  await f.tracker.tick(); assert.equal(f.last().state, 'sharing');
});

test('background/logout during a GPS read cancels sending; returning requests a new fix', async () => {
  let release, reads = 0;
  const f = fixture({ location: { getCurrentPositionAsync: () => { reads++; return new Promise(resolve => { release = resolve; }); } } });
  let pending = f.tracker.tick();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await f.tracker.tick(); assert.equal(reads, 1); // no overlapping GPS acquisition
  f.tracker.setActive(false); release(fix()); await pending; assert.equal(f.sends.length, 0);
  f.tracker.setActive(true); release = null; pending = f.tracker.tick();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release(fix()); await pending; assert.equal(f.sends.length, 1);
  release = null; pending = f.tracker.tick();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  f.tracker.stop(); release(fix()); await pending; assert.equal(f.sends.length, 1);
});

test('changed session stops the tracker; finished/reassigned routes are not retried in place', async () => {
  let attempts = 0;
  const f = fixture({ getRoutes: async () => { attempts++; throw Object.assign(Error(), { code: 'SESSION_CHANGED' }); } });
  await f.tracker.tick(); await f.tracker.tick(); assert.equal(attempts, 1); assert.equal(f.last().state, 'session_error');
  const closed = fixture({ send: async () => { throw { response: { status: 404 } }; } });
  await closed.tracker.tick(); assert.equal(closed.last().state, 'waiting_links'); assert.equal(closed.last().lastSentAt, null);
});

test('location HTTP requests bind to the captured tenant session and reject a switched account', async () => {
  const code = fs.readFileSync(path.resolve(__dirname, '../../mobile/src/services/api.js'), 'utf8');
  let session = { token: 'synthetic-first', baseUrl: 'https://first.invalid', user: { id: 10, organization_id: 1 } };
  const storage = { multiGet: async () => [['token', session.token], ['base', session.baseUrl], ['user', JSON.stringify(session.user)]] };
  const clients = [], calls = [];
  const context = { AsyncStorage: storage, DEFAULT_API_URL: 'https://fallback.invalid', API_TIMEOUT_MS: 10000, LOGIN_TIMEOUT_MS: 10000,
    axios: { create: config => { clients.push(config); return {
      get: async (url, options) => { calls.push({ url, options }); return { data: { routes: [] } }; },
      patch: async (url, body, options) => { calls.push({ url, body, options }); return { data: { location: { activeLinks: 1 } } }; },
    }; } }, module: { exports: {} } };
  vm.runInNewContext(code.replace(/^import .*;\r?\n/gm, '').replace(/export /g, '')
    + '\nmodule.exports={getActiveRoutes,updateDriverLocation};', context);
  const api = context.module.exports;
  const expected = session;
  const abort = new AbortController();
  await api.getActiveRoutes(expected, abort.signal);
  await api.updateDriverLocation(48, fix().coords, expected, abort.signal);
  assert.equal(clients[0].baseURL, expected.baseUrl);
  assert.equal(clients[1].headers.Authorization, 'Bearer synthetic-first');
  assert.equal(calls[1].options.signal, abort.signal);
  assert.equal(calls[1].url, '/api/delivery/routes/48/location');
  session = { token: 'synthetic-second', baseUrl: 'https://second.invalid', user: { id: 20, organization_id: 2 } };
  await assert.rejects(api.updateDriverLocation(48, fix().coords, expected), { code: 'SESSION_CHANGED' });
  await assert.rejects(api.getActiveRoutes(expected), { code: 'SESSION_CHANGED' });
  assert.equal(calls.length, 2);
});
