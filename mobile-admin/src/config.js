/**
 * config.js — Configuración de la app Central (admin).
 * El backend es el mismo CRM. Se puede sobreescribir con EXPO_PUBLIC_API_URL.
 */
export const DEFAULT_API_URL =
  process.env.EXPO_PUBLIC_API_URL || 'https://whatsapp-crm-api-production-f804.up.railway.app';

export const APP_NAME    = 'Central';
export const APP_VERSION = '1.0.0';

export const API_TIMEOUT_MS   = 30000;
export const LOGIN_TIMEOUT_MS = 45000;
