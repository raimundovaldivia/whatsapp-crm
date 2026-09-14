/**
 * stopLabel — Cómo se rotulan las paradas en la ruta.
 *
 * Google Maps rotula las paradas con letras (A, B, C…). Muchos repartidores
 * se guían por eso, así que la app deja elegir entre números (1, 2, 3…) y
 * letras. La elección se guarda en el teléfono y aplica a todas las rutas.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'stop_label_mode';          // 'numbers' | 'letters'
export const LABEL_MODES = ['numbers', 'letters'];

/** 1 → A, 26 → Z, 27 → AA, 28 → AB … (igual que las columnas de Excel). */
export function toLetters(n) {
  let num = Math.max(1, parseInt(n, 10) || 1);
  let out = '';
  while (num > 0) {
    const rem = (num - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    num = Math.floor((num - 1) / 26);
  }
  return out;
}

/** Rótulo de la parada según el modo elegido. */
export function stopLabel(stopNumber, mode = 'numbers') {
  return mode === 'letters' ? toLetters(stopNumber) : String(stopNumber);
}

export async function loadStopLabelMode() {
  try {
    const v = await AsyncStorage.getItem(KEY);
    return LABEL_MODES.includes(v) ? v : 'numbers';
  } catch {
    return 'numbers';
  }
}

export async function saveStopLabelMode(mode) {
  try { await AsyncStorage.setItem(KEY, LABEL_MODES.includes(mode) ? mode : 'numbers'); } catch {}
}
