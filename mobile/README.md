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
   2. Revisar alertas de cobertura y optimizar ruta (Google Maps)
   3. Asignar repartidor ─────────────▶   4. Ve sus rutas asignadas
                                          5. Consolida la carga; los clientes
                                             reciben el aviso de salida
                                          6. Abre la ruta: mapa + paradas
                                             y corrige direcciones observadas
                                          7. Marca entregado / no encontrado
                                             + medio de pago (efectivo/transferencia)
   8. Historial: progreso en vivo ◀────────┘
   9. Pedidos → 💸 Por cobrar (si fue transferencia sin comprobante)
```

- Cada ruta tiene un **repartidor asignado** (usuario con rol `repartidor`).
  El chofer ve solo sus rutas, más las que quedaron sin asignar.
- El rol `repartidor` **solo accede a `/api/delivery/*`**. Puede leer y
  responder únicamente el chat del cliente que pertenece a una parada de su
  ruta activa. Una incidencia cerrada conserva ese acceso durante 7 días;
  nunca expone otros chats, clientes ni pedidos del CRM.
- Al asignar la ruta, la app muestra una notificación push al repartidor. Al
  completar el checklist de carga, cada cliente recibe un aviso idempotente de
  que su pedido quedó con el repartidor y, cuando el canal lo permite, un enlace
  temporal para seguir su ubicación. Si un cliente responde, el chofer
  recibe otro push que abre directamente el chat de esa parada.
- Durante una ruta activa la app pide permiso de ubicación y publica una
  actualización cada 15 segundos o 30 metros mientras sigue ejecutándose. El
  enlace no muestra datos personales y vence al cerrar la parada o la ruta.
- Al marcar "Entregado", la app pregunta cómo pagó el cliente. Si fue
  transferencia, el pedido aparece en **Pedidos → Por cobrar** hasta que
  llegue el comprobante.
- **Entrega parcial** permite indicar la cantidad entregada de cada producto.
  La parada guarda el detalle entregado y pendiente, cobra únicamente lo
  entregado y crea un pedido separado con el saldo para la fecha elegida.
- Si un pedido cambia antes de iniciar la ruta, las cantidades se actualizan
  en la copia de la ruta y el checklist de carga se reinicia. Así se debe
  consolidar nuevamente la carga real antes de comenzar el reparto.
- En cada parada, **Avisar con Diva: voy en camino** envía el aviso desde el
  WhatsApp del negocio y lo registra en el chat. El botón solo se habilita si
  el cliente escribió durante las últimas 24 horas; fuera de esa ventana la
  app indica que corresponde usar un template aprobado.
- Cancelar, reprogramar o cerrar una entrega sin éxito deja el chat en estado
  de resolución y envía un seguimiento automático en el mismo historial. Si
  la ventana está cerrada usa Evolution o el template Utility configurado como
  **Resolver entrega**.
- La web permite configurar un radio común desde la bodega y otros puntos de
  cobertura. Los pedidos fuera del rango o sin coordenadas quedan sin marcar
  inicialmente y llegan señalados al repartidor si el equipo decide incluirlos.
  El chofer puede corregir la dirección solo en una ruta activa asignada a él;
  el backend actualiza el pedido, la parada y deja una auditoría en la ruta.

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
| PATCH  | `/api/delivery/routes/:id/start`    | Confirma carga e inicia avisos a clientes  |
| GET    | `/api/delivery/routes/:id/stops/chat` | Historial del cliente de esa parada       |
| POST   | `/api/delivery/routes/:id/stops/chat` | Responder desde el chat de la parada      |
| GET    | `/api/delivery/routes/:id/en-route-status` | Comprueba la ventana de 24 h de una parada |
| POST   | `/api/delivery/routes/:id/notify-en-route` | Diva avisa que el pedido va en camino      |
| PATCH  | `/api/delivery/routes/:id/location` | Actualiza la ubicación de los enlaces temporales |
| PATCH  | `/api/delivery/routes/:id/stops`    | Marcar parada; parcial acepta `deliveredQuantities` y `deliverAfter` |
| PATCH  | `/api/delivery/routes/:id/stops/address` | Corregir dirección de una parada asignada |

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
## Seguimiento del cliente

La app comparte una ubicación reciente cada 15 segundos mientras está en primer plano y tiene rutas `in_progress` asignadas al usuario. El seguimiento vive en la sesión de la app, por lo que cambiar entre rutas, paradas y chat no lo interrumpe. La primera lectura no requiere movimiento. El aviso inferior distingue permiso denegado, GPS apagado, falta de posición, conexión fallida, ausencia de enlaces y envío confirmado por el servidor.

La posición no se guarda ni se acumula para enviar después: al volver de otra app se obtiene una lectura nueva. Se cancela al salir de la sesión y no se envía a rutas de otros repartidores ni a rutas cerradas. El API existente conserva la validación por organización, rol y asignación.

El APK 1.4.0 solo tiene permisos de ubicación en primer plano. Al abrir Maps, bloquear el teléfono o minimizar Despachos, el seguimiento se pausa; al regresar se reanuda. Mantenerlo en segundo plano requiere un APK con los permisos y servicio nativo correspondientes, no solo una actualización OTA.

Prueba local: `node --test backend/test/mobile-driver-location.test.cjs` desde la raíz del repositorio. Usa GPS, reloj y transporte simulados; no demuestra recepción real desde un teléfono. Para publicar, exportar Android y comprobar los canales `preview` y `production` de EAS: desplegar la web/API no publica automáticamente la app.
