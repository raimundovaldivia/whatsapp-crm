import AsyncStorage from '@react-native-async-storage/async-storage';
import { createExpense, getSavedSession } from '../services/api';

let mutations = Promise.resolve();
const flushing = new Set();
const listeners = new Set();
export function onQueueChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function notify(n) { listeners.forEach(fn => { try { fn(n); } catch {} }); }
function serialize(fn) {
  const next = mutations.then(fn, fn);
  mutations = next.catch(() => {});
  return next;
}
async function identity() {
  const session = await getSavedSession();
  if (!session.token || !session.user?.id) throw new Error('Inicia sesión para guardar gastos');
  return { session, key: `pending_expenses_v2:${encodeURIComponent(session.baseUrl)}:${session.user.id}` };
}
async function read(key) {
  const raw = await AsyncStorage.getItem(key);
  const items = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(items)) throw new Error('No se puede leer la cola de gastos');
  return items;
}
async function mutate(key, fn) {
  return serialize(async () => {
    const items = fn(await read(key));
    await AsyncStorage.setItem(key, JSON.stringify(items));
    notify(items.length);
    return items;
  });
}
export async function pendingCount() {
  const { key } = await identity();
  return (await serialize(() => read(key))).length;
}
export async function enqueueExpense(expense, expectedSession = null) {
  const { key, session } = await identity();
  if (expectedSession && (session.token !== expectedSession.token || session.baseUrl !== expectedSession.baseUrl || session.user.id !== expectedSession.user?.id)) throw new Error('La sesión cambió');
  const id = expense.clientRequestId || `expense_${Date.now()}_${Math.random().toString(36).slice(2,14)}`;
  const items = await mutate(key, q => q.some(x => x.clientRequestId === id) ? q : [...q, {
    ...expense, clientRequestId: id, _queuedAt: new Date().toISOString(),
  }]);
  return items.length;
}

export async function legacyExpenses() { return serialize(() => read('pending_expenses_v1')); }
// Called only after the user confirms ownership of unscoped entries from v1.
export async function recoverLegacyExpenses() {
  const { key } = await identity();
  return serialize(async () => {
    const old = await read('pending_expenses_v1');
    const current = await read(key);
    for (const expense of old) {
      const id = expense.clientRequestId || `legacy_${expense._id || Date.now()}`;
      if (!current.some(x => x.clientRequestId === id)) current.push({ ...expense, clientRequestId: id });
    }
    await AsyncStorage.setItem(key, JSON.stringify(current));
    await AsyncStorage.setItem('pending_expenses_v1', '[]');
    notify(current.length);
    return current.length;
  });
}
export async function flushExpenses() {
  const { key, session } = await identity();
  if (flushing.has(key)) return { uploaded: 0, remaining: (await read(key)).length };
  flushing.add(key);
  let uploaded = 0;
  const rejected = [];
  try {
    for (const item of await serialize(() => read(key))) {
      if (item._rejected) continue;
      const { _queuedAt, ...payload } = item;
      try {
        await createExpense(payload, session);
        await mutate(key, q => q.filter(x => x.clientRequestId !== item.clientRequestId));
        uploaded++;
      } catch (err) {
        if (err.response?.status === 400) {
          const reason = err.response.data?.error || 'Revisa el gasto';
          rejected.push(reason);
          await mutate(key, q => q.map(x => x.clientRequestId === item.clientRequestId ? { ...x, _rejected: reason } : x));
          continue;
        }
        break;
      }
    }
    return { uploaded, remaining: (await read(key)).length, rejected };
  } finally { flushing.delete(key); }
}
