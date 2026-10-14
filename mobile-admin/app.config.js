/**
 * app.config.js — Configuración de Expo para la app ADMIN (Central).
 *
 * App aparte de la de repartidor: otro slug, otro bundle id, otro proyecto EAS.
 * El proyecto EAS ya está vinculado; `extra.eas.projectId` y `updates.url`
 * deben conservarse para builds, notificaciones y actualizaciones OTA.
 *
 *   EXPO_PUBLIC_API_URL   backend del CRM (default en src/config.js)
 */
module.exports = {
  expo: {
    name: 'Diez Ríos Central',
    slug: 'diezrios-central-admin',
    version: '1.0.0',
    runtimeVersion: '1.0.0',
    owner: 'raivaldivia',
    updates: {
      url: 'https://u.expo.dev/f32a6047-9f13-48d1-acca-0a32bfc6f947',
      fallbackToCacheTimeout: 0,
    },
    orientation: 'portrait',
    icon: './assets/icon.png',
    userInterfaceStyle: 'dark',
    scheme: 'central',
    splash: {
      image: './assets/splash.png',
      resizeMode: 'cover',
      backgroundColor: '#0f172a',
    },
    assetBundlePatterns: ['**/*'],
    ios: {
      supportsTablet: false,
      bundleIdentifier: 'com.raigentic.central',
    },
    android: {
      package: 'com.raigentic.central',
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        backgroundColor: '#0f172a',
      },
    },
    web: { favicon: './assets/favicon.png' },
    plugins: [
      [
        'expo-notifications',
        { color: '#22c55e' },
      ],
    ],
    extra: {
      apiUrl: process.env.EXPO_PUBLIC_API_URL || null,
      eas: { projectId: 'f32a6047-9f13-48d1-acca-0a32bfc6f947' },
    },
  },
};
