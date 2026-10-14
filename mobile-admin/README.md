# Diez Ríos — Central (app admin)

App móvil **solo para administradores** (owner / admin / supervisor). Maneja la
central desde el celular: Chat, Pedidos, Repartos y Avisos con push.

Es un proyecto Expo aparte de la app de repartidor (`mobile/`), con su propio
bundle id y su propio proyecto EAS. Comparte el mismo backend del CRM.

## Preparación local

```bash
cd mobile-admin
npm install
npx eas login            # cuenta Expo con acceso a @raivaldivia
```

El proyecto ya está vinculado a EAS como
`@raivaldivia/diezrios-central-admin`. `app.config.js` conserva el
`projectId` y la URL de actualizaciones OTA; no vuelvas a ejecutar `eas init`
salvo que se migre deliberadamente a otra cuenta Expo.

## Build del APK (Android)

```bash
npm run build:android      # eas build --platform android --profile preview
```

Instala el APK en tu celular. Inicia sesión con tu cuenta **admin** del CRM
(la misma del panel web). Si la cuenta es de repartidor, la app la rechaza.

## Notificaciones push

Al iniciar sesión, la app pide permiso y registra el token en el backend
(`POST /api/push/register`). Desde ahí te llegan avisos cuando:
- el bot escala una conversación,
- entra un comprobante de pago,
- hay algo por cobrar / un pedido nuevo.

El backend los envía por la API de Expo (sin dependencias nuevas). El push
funciona en un dispositivo real, no en emulador.

## Qué hace cada pestaña

- **Chat** — conversaciones de WhatsApp; abrir una, tomar el control (pasa a
  modo humano y pausa el bot), responder, o devolverla al bot.
- **Pedidos** — lista de pedidos; tocar uno para marcar pagado / entregado /
  cancelar.
- **Repartos** — resumen de los despachos de la semana: entregados, efectivo,
  transferencia, gastos y neto (misma lógica que 📦 Despachos del web).
- **Avisos** — cola de alertas del admin; mantener presionado para descartar.
  Abajo está el cierre de sesión.

## Backend (ya incluido en este push)

- `src/routes/push.js` — registrar/desregistrar tokens.
- `src/services/push.js` — envío a Expo.
- `push_tokens` en `src/db/setup.js` (se crea sola al desplegar).
- `admin-notify.js` ahora también manda push en cada alerta.

## Notas

- Es la **v1**: cubre el flujo diario. Faltan por sumar (si los quieres):
  armar/enviar rutas desde el celular, ver comprobantes con foto, conciliación,
  y filtros avanzados. Se agregan por OTA sin reinstalar.
- Cambios solo de JS se pueden publicar con `eas update --channel preview`
  una vez configurado el OTA.
