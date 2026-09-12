/**
 * config.js — Configuración de la app de despachos
 *
 * DEFAULT_API_URL: backend del CRM. El repartidor no debería tener que
 * escribirla — queda prellenada en el login y solo se cambia desde
 * "Cambiar servidor" (para probar contra otro ambiente).
 *
 * Se puede sobreescribir sin tocar código con la variable de entorno
 * EXPO_PUBLIC_API_URL al hacer el build (ver README).
 */

export const DEFAULT_API_URL =
  process.env.EXPO_PUBLIC_API_URL || 'https://whatsapp-crm-api-production-f804.up.railway.app';

export const APP_NAME    = 'Despachos';
export const APP_VERSION = '1.1.0';

// Timeout de las llamadas normales al backend.
export const API_TIMEOUT_MS = 30000;

// El login espera un poco más y reintenta una vez: cubre redes móviles lentas
// o un arranque en frío del backend, sin cortar antes de tiempo.
export const LOGIN_TIMEOUT_MS = 45000;
