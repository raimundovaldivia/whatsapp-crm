/**
 * app.config.js — Configuración de Expo (reemplaza a app.json)
 *
 * Las claves y URLs salen de variables de entorno para que el repo no las
 * contenga y cada tienda pueda hacer su propio build:
 *
 *   EXPO_PUBLIC_API_URL       backend del CRM (default en src/config.js)
 *   GOOGLE_MAPS_API_KEY_ANDROID  key de Google Maps SDK for Android
 *   GOOGLE_MAPS_API_KEY_IOS      (opcional) en iOS se usa Apple Maps, no hace falta
 *
 * Ver README.md para cómo obtener la key y hacer el build.
 */

const ANDROID_MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY_ANDROID || '';
const IOS_MAPS_KEY     = process.env.GOOGLE_MAPS_API_KEY_IOS || '';

module.exports = {
  expo: {
    name: 'Despachos',
    slug: 'whatsapp-crm-despachos',
    version: '1.1.0',
    orientation: 'portrait',
    icon: './assets/icon.png',
    userInterfaceStyle: 'dark',
    scheme: 'despachos',
    splash: {
      image: './assets/splash.png',
      resizeMode: 'cover',
      backgroundColor: '#0f172a',
    },
    assetBundlePatterns: ['**/*'],
    ios: {
      supportsTablet: false,
      bundleIdentifier: 'com.raigentic.despachos',
      infoPlist: {
        NSLocationWhenInUseUsageDescription: 'Usamos tu ubicación para mostrarte en el mapa de la ruta.',
      },
      ...(IOS_MAPS_KEY ? { config: { googleMapsApiKey: IOS_MAPS_KEY } } : {}),
    },
    android: {
      package: 'com.raigentic.despachos',
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        backgroundColor: '#0f172a',
      },
      permissions: ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION'],
      ...(ANDROID_MAPS_KEY ? { config: { googleMaps: { apiKey: ANDROID_MAPS_KEY } } } : {}),
    },
    web: {
      favicon: './assets/favicon.png',
    },
    plugins: [
      [
        'expo-location',
        { locationWhenInUsePermission: 'Usamos tu ubicación para mostrarte en el mapa de la ruta.' },
      ],
    ],
    extra: {
      apiUrl: process.env.EXPO_PUBLIC_API_URL || null,
    },
  },
};
