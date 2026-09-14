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

// EXPO_PUBLIC_ hace que la key también quede disponible en el código JS (para
// no montar el mapa —y evitar el crash nativo— si no hay key). Se mantiene el
// nombre viejo como respaldo.
const ANDROID_MAPS_KEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID || process.env.GOOGLE_MAPS_API_KEY_ANDROID || '';
const IOS_MAPS_KEY     = process.env.GOOGLE_MAPS_API_KEY_IOS || '';

module.exports = {
  expo: {
    name: 'Despachos',
    slug: 'whatsapp-crm-despachos',
    version: '1.1.0',
    // OTA (EAS Update): la app instalada descarga cambios de JS por internet.
    // Solo cambios NATIVOS (librerías nuevas, permisos, SDK) requieren nuevo APK.
    runtimeVersion: '1.0.0',
    updates: {
      url: 'https://u.expo.dev/2a8cb9c5-30f8-44bc-812b-35c51e758b49',
      fallbackToCacheTimeout: 0,
    },
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
      eas: { projectId: '2a8cb9c5-30f8-44bc-812b-35c51e758b49' },
    },
  },
};
