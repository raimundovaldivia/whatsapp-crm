/**
 * app.config.js — Configuración de Expo para la app ADMIN (Central).
 *
 * App aparte de la de repartidor: otro slug, otro bundle id, otro proyecto EAS.
 * Antes del primer build hay que correr `eas init` para generar el projectId
 * (queda en extra.eas.projectId y en updates.url). Ver README.md.
 *
 *   EXPO_PUBLIC_API_URL   backend del CRM (default en src/config.js)
 */
module.exports = {
  expo: {
    name: 'Diez Ríos Central',
    slug: 'diezrios-central-admin',
    version: '1.0.0',
    runtimeVersion: '1.0.0',
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
      // eas: { projectId: '<CORRE eas init>' },   // lo completa `eas init`
    },
    // updates: { url: 'https://u.expo.dev/<projectId>' },  // lo completa `eas init`
  },
};
