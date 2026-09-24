# Correcciones de la auditoría del 23 de septiembre

Los cambios están preparados en esta copia de trabajo. No ejecutan un despliegue ni una actualización OTA.

## Segunda corrección, 24 de septiembre

Los ocho hallazgos de la segunda auditoría se corrigieron. Las entregas validan pertenencia, asignación y estado de ruta, y guardan ruta/pago/extras en una transacción. Fusionar conversaciones exige owner/admin/supervisor y transfiere pedidos, comprobantes, mensajes, agendamientos, feedback y colas administrativas antes de eliminar la fuente.

El inbox ahora usa `webhook_streams`: cuatro trabajos simultáneos por proceso y exclusión por conversación respaldada por PostgreSQL, compartida entre instancias. Kapso agrupa mensajes persistidos durante 3 segundos de silencio (12 para saludos); el lote guarda los mensajes antes de ejecutar la última respuesta programada. Cada lote tiene hasta 50 eventos. Meta se divide en eventos individuales después de validar la firma del cuerpo completo y resolver la organización de cada cambio. Los fallos ambiguos continúan en `needs_review`.

Antes de migrar, detener los workers anteriores y respaldar la base. La migración crea `webhook_streams`, añade `webhook_inbox.stream_id` y reemplaza el índice que limitaba a un evento por organización. No ejecutar simultáneamente el worker antiguo y el nuevo. Si existen eventos Meta pendientes del formato anterior, revisar/dividir esos lotes antes de procesarlos; los eventos nuevos ya se descomponen automáticamente.

La lectura de módulos se permite a todos los roles autenticados; las escrituras siguen restringidas. El editor móvil usa `/api/delivery/routes/:id/order-items`, verifica la opción `edit_delivered_items` y la pertenencia/asignación del pedido. Publicar backend antes del móvil.

Se añadieron exclusiones Docker para secretos y dependencias locales. CI también compila los contenedores. Localmente el motor Docker no estaba iniciado: las imágenes no se pudieron construir. Pasaron 22 pruebas backend, el build web y la exportación Android del móvil modificado. Las pruebas usan datos sintéticos, incluyendo PostgreSQL embebido; aún se requieren validaciones con datos y proveedores reales.

## Antes de publicar

1. Usar Node 24 y `npm ci` en backend/frontend. Los Dockerfiles están alineados con esta versión. No reutilizar `node_modules` anteriores.
2. Configurar un `JWT_SECRET` aleatorio de al menos 32 caracteres. El backend ya no arranca con un secreto ausente o conocido. Si se cambia el secreto, los usuarios deberán iniciar sesión nuevamente.
3. Configurar `FRONTEND_URL` con los orígenes exactos permitidos, separados por comas, incluidos CRM y tienda. Se eliminó la autorización general de dominios compartidos.
4. Habilitar firmas en el proveedor activo. Kapso necesita `webhook_secret` por organización o `KAPSO_WEBHOOK_SECRET`; Meta necesita `META_APP_SECRET`; Twilio usa el token de su organización y `CRM_PUBLIC_URL` debe coincidir con el origen de la URL registrada. Shopify exige secreto HMAC válido y dominio de tienda correspondiente a la organización. Las entregas sin firma válida son rechazadas.
5. Hacer backup de PostgreSQL. El arranque aplica migraciones aditivas para `users.auth_version`, `delivery_expenses.client_request_id` y `webhook_inbox`. Las migraciones se probaron desde cero y ejecutándolas una segunda vez en PostgreSQL embebido; aún se requiere validarlas sobre una copia de datos reales.
6. Si hay reverse proxy, configurar `TRUST_PROXY_HOPS` según la topología real para que el límite de solicitudes use la IP correcta. No activar confianza universal en proxies.
7. En Compose, definir `VITE_BACKEND_URL` con la URL pública del backend durante la compilación. Nginx usa puerto 8080 internamente, publicado en el 80 del host.
8. Publicar backend antes de distribuir las apps móviles corregidas. El servidor sigue aceptando clientes anteriores sin `clientRequestId`, pero esos clientes no obtienen idempotencia. La app administrativa cambió módulos nativos incompatibles con Expo 57: requiere un nuevo binario, no solo OTA.

## Qué cambia

- Socket.IO valida JWT y usuario actual, une a una sala derivada en el servidor y restringe eventos a esa organización. Revalida sesiones abiertas cada 15 segundos. Repartidores/coordinadores no reciben chats.
- Los tokens se invalidan al eliminar al usuario o cambiar su rol/versión. El owner queda protegido frente a bajas o degradaciones por otros administradores.
- Los comprobantes se actualizan por organización; pedido y comprobante se guardan en la misma transacción. Las mutaciones manuales de conversaciones comprueban propiedad.
- El proxy multimedia exige un mensaje perteneciente a la organización, separa la caché por organización, verifica destinos públicos y redirecciones, limita tamaño y solo envía credenciales a hosts Kapso exactos.
- Los webhooks autenticados se guardan antes del HTTP 200 y se procesan por un worker. Se deduplican por organización, proveedor, evento y cuerpo. Los trabajos pendientes sobreviven a reinicios.
- Los trabajos con error o interrupción quedan en `needs_review`: no se reintenta a ciegas una operación que podría haber enviado un mensaje o creado un pedido. Un administrador puede consultar `GET /api/webhook-inbox`; el payload se conserva en la tabla para diagnóstico autorizado. Revisar los efectos reales antes de recuperar manualmente un evento. No se garantiza entrega exactamente una vez de efectos externos.
- Configuración, herramientas del asistente, campañas y cambios de pedidos aplican permisos en servidor. El coordinador conserva edición de dirección/ítems/fecha y gestión de bodega.
- Se validan cantidades de tienda y se limitan solicitudes de acceso y creación pública de pedidos.
- Se reparó `/orders/order-items`, el HMAC OAuth malformado y la comprobación de expiración del estado OAuth.
- La cola de gastos serializa modificaciones, conserva el ID de reintento, separa cuentas y servidores, retiene rechazos y notifica errores de almacenamiento. Los gastos v1 se recuperan solo tras confirmar su propiedad en la app.
- Se corrigió el orden de migraciones que impedía iniciar con una base vacía.
- Paneles y tienda se cargan por separado; Excel se empaqueta localmente desde una versión fijada, sin importar JavaScript remoto al abrir la función.
- CI prueba seguridad, PostgreSQL, compilación web y exportaciones Android. `/ready` comprueba acceso a la base; `/health` sigue disponible como señal de proceso vivo.

## Validación y límites

`cd backend && npm test` ejecuta pruebas aisladas; usa PostgreSQL embebido y no necesita `DATABASE_URL` ni credenciales reales. Incluye aislamiento, rollback, idempotencia, firmas, sesiones revocadas, proxy, rutas, cola móvil y persistencia de webhooks. `npm run build` valida frontend. `expo export --platform android` valida los bundles JavaScript; no sustituye una prueba en dispositivo ni una compilación nativa firmada.

Las actualizaciones de dependencias se comprobaron con npm audit. Las excepciones transitivas (`qs`, `uuid` de Xcode) están explícitas en los manifiestos y deben revisarse cuando los proveedores publiquen actualizaciones. El almacenamiento seguro de tokens móviles, retención automática de webhooks, restauración de backups, pruebas de carga y pruebas con proveedores reales siguen siendo tareas operativas/defensas adicionales; no se certificaron aquí.

Referencias de implementación: [firmas Twilio](https://www.twilio.com/docs/usage/webhooks/webhooks-security), [adaptador oficial Kapso](https://github.com/gokapso/chat-sdk-adapter), [distribución oficial SheetJS](https://docs.sheetjs.com/docs/getting-started/installation/frameworks/).
