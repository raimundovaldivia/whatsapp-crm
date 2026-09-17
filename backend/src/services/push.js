/**
 * push.js — Notificaciones push a las apps de administrador (Expo).
 *
 * Guarda los Expo push tokens de cada admin (tabla push_tokens) y envía avisos
 * a la API pública de Expo (https://exp.host/--/api/v2/push/send). No requiere
 * dependencias nuevas: es un POST HTTPS normal con axios.
 *
 * Es best-effort: si algo falla, nunca rompe el flujo que disparó la alerta.
 */
const axios = require('axios');
const { getPool } = require('../db/database');

const EXPO_URL = 'https://exp.host/--/api/v2/push/send';

/** Envía un push a todos los admins de la organización. */
async function pushAdmins(orgId, { title = 'Diez Ríos', body = '', data = {} } = {}) {
  if (!body) return { sent: 0 };
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT token FROM push_tokens WHERE organization_id = $1`,
      [orgId]
    );
    const tokens = rows.map(r => r.token).filter(t => typeof t === 'string' && t.startsWith('ExponentPushToken'));
    if (!tokens.length) return { sent: 0 };

    const messages = tokens.map(to => ({
      to, title, body, sound: 'default', channelId: 'default', priority: 'high', data,
    }));

    // Expo acepta hasta 100 mensajes por request
    const chunks = [];
    for (let i = 0; i < messages.length; i += 100) chunks.push(messages.slice(i, i + 100));

    const invalid = [];
    for (const chunk of chunks) {
      try {
        const { data: resp } = await axios.post(EXPO_URL, chunk, {
          headers: { 'Content-Type': 'application/json' }, timeout: 10000,
        });
        const tickets = resp?.data || [];
        tickets.forEach((t, i) => {
          if (t?.status === 'error' && t?.details?.error === 'DeviceNotRegistered') invalid.push(chunk[i].to);
        });
      } catch (e) {
        console.warn('[Push] Error enviando a Expo:', e.message);
      }
    }

    // Limpiar tokens muertos
    if (invalid.length) {
      await pool.query(`DELETE FROM push_tokens WHERE token = ANY($1)`, [invalid]).catch(() => {});
    }
    console.log(`[Push] 📲 Enviado a ${tokens.length - invalid.length}/${tokens.length} dispositivos (${title})`);
    return { sent: tokens.length - invalid.length };
  } catch (err) {
    console.warn('[Push] pushAdmins falló:', err.message);
    return { sent: 0, error: err.message };
  }
}

module.exports = { pushAdmins };
