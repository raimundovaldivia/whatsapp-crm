/**
 * expenseQueue — Gastos que no alcanzaron a subirse (sin señal, timeout).
 *
 * Un repartidor rinde el gasto en la calle, muchas veces sin buena señal. Si
 * la subida falla, el gasto NO se pierde: queda guardado en el teléfono y se
 * reintenta solo cada vez que la app vuelve a primer plano o entra a una
 * pantalla. El usuario ve cuántos hay pendientes.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createExpense } from '../services/api';

const KEY = 'pending_expenses_v1';
let flushing = false;
const listeners = new Set();

export function onQueueChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
async function notify() { const n = (await readQueue()).length; listeners.forEach(fn => { try { fn(n); } catch {} }); }

async function readQueue() {
  try { const raw = await AsyncStorage.getItem(KEY); const arr = raw ? JSON.parse(raw) : []; return Array.isArray(arr) ? arr : []; }
  catch { return []; }
}
async function writeQueue(arr) {
  try { await AsyncStorage.setItem(KEY, JSON.stringify(arr)); } catch {}
  notify();
}

export async function pendingCount() { return (await readQueue()).length; }

/** Guarda un gasto para subirlo después. */
export async function enqueueExpense(expense) {
  const q = await readQueue();
  q.push({ ...expense, _id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, _queuedAt: new Date().toISOString(), _tries: 0 });
  await writeQueue(q);
  return q.length;
}

/**
 * Intenta subir todo lo pendiente. Devuelve { uploaded, remaining }.
 * Una falla de red deja el resto para la próxima; un rechazo del servidor
 * (400: monto inválido, foto muy pesada) descarta ese gasto para no reintentar
 * eternamente, y se informa.
 */
export async function flushExpenses() {
  if (flushing) return { uploaded: 0, remaining: await pendingCount() };
  flushing = true;
  let uploaded = 0;
  const rejected = [];
  try {
    let q = await readQueue();
    for (const item of [...q]) {
      const { _id, _queuedAt, _tries, ...payload } = item;
      try {
        await createExpense({ ...payload, note: payload.note ? `${payload.note} (rendido ${fmtWhen(_queuedAt)})` : `Rendido ${fmtWhen(_queuedAt)}` });
        q = q.filter(x => x._id !== _id);
        uploaded++;
        await writeQueue(q);
      } catch (e) {
        const st = e.response?.status;
        if (st === 400) { rejected.push(e.response?.data?.error || 'rechazado'); q = q.filter(x => x._id !== _id); await writeQueue(q); continue; }
        if (st === 401) break;                  // sesión vencida: la app vuelve al login
        item._tries = (_tries || 0) + 1;        // red / 5xx: dejarlo y parar (sin señal, los demás también fallarán)
        await writeQueue(q);
        break;
      }
    }
    return { uploaded, remaining: q.length, rejected };
  } finally {
    flushing = false;
  }
}

function fmtWhen(iso) {
  try { return new Date(iso).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}
