# Despachos — app del repartidor

App móvil (Expo / React Native) del módulo de **Despachos** del CRM. El
administrador arma las rutas desde la web (Repartos → Nuevo reparto) y el
repartidor las ejecuta desde el teléfono: ve las paradas en el mapa, navega,
llama o escribe al cliente, y marca cada entrega con su medio de pago.

Funciona con cualquier tienda del CRM — con Shopify conectado o sin él.

---

## Cómo funciona el módulo

```
   WEB (Repartos)                          APP (repartidor)
   ─────────────────────────               ───────────────────────────
   1. Elegir pedidos pendientes
   2. Optimizar ruta (Google Maps)
   3. Asignar repartidor ─────────────▶   4. Ve sus rutas asignadas
                                          5. Abre la ruta: mapa + paradas
                                          6. Marca entregado / no encontrado
                                             + medio de pago (efectivo/transferencia)
   7. Historial: progreso en vivo ◀────────┘
   8. Pedidos → 💸 Por cobrar (si fue transferencia sin comprobante)
```

- Cada ruta tiene un **repartidor asignado** (usuario con rol `repartidor`).
  El chofer ve solo sus rutas, más las que quedaron sin asignar.
- El rol `repartidor` **solo accede a `/api/delivery/*`**. No puede leer
  chats, clientes ni pedidos del CRM aunque tenga el token.
- Al marcar "Entregado", la app pregunta cómo pagó el cliente. Si fue
  transferencia, el pedido aparece en **Pedidos → Por cobrar** hasta que
  llegue el comprobante.

---

## 1. Crear el usuario del repartidor

En el CRM web: **Ajustes → Usuarios → Nuevo usuario**, rol **Repartidor**.
Con ese correo y contraseña entra a la app.

---

## 2. Correr la app en desarrollo (Expo Go)

```bash
cd mobile
npm install
npx expo start
```

Escanea el QR con **Expo Go** (Android/iOS). La app apunta por defecto al
backend de producción (`src/config.js`). Para apuntar a otro servidor:

```bash
EXPO_PUBLIC_API_URL=https://mi-backend.com npx expo start
```

o desde la pantalla de login → "Cambiar servidor".

> En Expo Go el mapa de Android funciona sin configurar nada (Expo trae su
> propia key). La key propia solo hace falta para el build instalable.

---

## 3. Build instalable (APK / TestFlight)

Se usa [EAS Build](https://docs.expo.dev/build/introduction/):

```bash
npm install -g eas-cli
eas login
cd mobile
eas build --platform android --profile preview   # genera un .apk para instalar directo
```

### Google Maps en Android (obligatorio para el build)

Sin key, el mapa sale gris en el APK. Pasos:

1. [Google Cloud Console](https://console.cloud.google.com/) → crear proyecto
   (o usar el que ya tiene `GOOGLE_MAPS_API_KEY` del backend).
2. Habilitar **Maps SDK for Android**.
3. Crear credencial → API key → restringir a "Android apps" con el package
   `com.raigentic.despachos`.
4. Guardarla como secreto de EAS para no ponerla en el repo:
   ```bash
   eas secret:create --scope project --name GOOGLE_MAPS_API_KEY_ANDROID --value "AIza..."
   ```

`app.config.js` la lee de `process.env.GOOGLE_MAPS_API_KEY_ANDROID` al hacer
el build. En iOS se usa Apple Maps, no necesita key.

### Cambiar la URL del backend del build

Editar `eas.json` → `build.preview.env.EXPO_PUBLIC_API_URL`.

---

## 4. Estructura

```
mobile/
  App.js                  ← navegación + sesión (login / expiración de token)
  app.config.js           ← config de Expo (nombre, ícono, keys por env)
  eas.json                ← perfiles de build
  src/
    config.js             ← URL del backend, versión
    services/api.js       ← cliente HTTP (/api/delivery/*, /api/auth/*)
    screens/
      LoginScreen.js      ← correo + clave (servidor prellenado)
      OrdersScreen.js     ← lista de rutas asignadas
      RouteScreen.js      ← mapa + paradas de una ruta
      StopScreen.js       ← detalle de parada: navegar, llamar, marcar entrega + pago
  assets/                 ← ícono, adaptive icon, splash (generados)
```

---

## Endpoints que usa

| Método | Ruta                                | Para qué                                  |
|--------|-------------------------------------|-------------------------------------------|
| POST   | `/api/auth/login`                   | Iniciar sesión                            |
| GET    | `/api/auth/me`                      | Validar token guardado                    |
| GET    | `/api/delivery/routes/active`       | Rutas activas del repartidor              |
| GET    | `/api/delivery/routes/:id`          | Detalle de una ruta (refresco)            |
| PATCH  | `/api/delivery/routes/:id/stops`    | Marcar parada `{ stopKey, status, paymentMethod }` |

El `stopKey` va en el **body**, no en la URL: los pedidos de Shopify tienen
IDs con barras (`gid://shopify/Order/123`) que Express no acepta como
parámetro de ruta.

---

## Problemas conocidos / decisiones

- **Sesión:** el token dura 7 días. Cuando vence, cualquier llamada devuelve
  401 y la app vuelve sola al login.
- **Sin coordenadas:** si la ruta se creó sin optimizar (sin
  `GOOGLE_MAPS_API_KEY` en el backend), no hay lat/lng y la app oculta el
  mapa — muestra solo la lista. "Abrir en Maps" sigue funcionando por
  dirección.
- **Sin señal:** las marcas de entrega no se encolan offline. Si falla, la
  app avisa y hay que reintentar con señal.
