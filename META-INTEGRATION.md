# Integración Meta — Facebook, Instagram y Ads

El CRM incluye un módulo **Facebook e Instagram** con cuatro capacidades:

- autorización OAuth por organización;
- bandeja de mensajes de Facebook Messenger e Instagram;
- publicación de texto, imágenes, videos y Reels;
- resumen de rendimiento de Meta Ads de los últimos 30 días.

## Configuración en Meta for Developers

1. Crear o reutilizar una app de tipo Business y agregar Facebook Login for Business, Messenger, Instagram Graph API y Marketing API.
2. En OAuth, registrar esta URL exacta:
   `https://whatsapp-crm-api-production-f804.up.railway.app/meta-oauth/callback`
3. En Webhooks, registrar:
   `https://whatsapp-crm-api-production-f804.up.railway.app/meta-webhook`
4. Usar el mismo valor de `META_WEBHOOK_VERIFY_TOKEN` como token de verificación.
5. Suscribir la página a `messages`, `messaging_postbacks` y `feed`. Para Instagram, activar mensajes para la cuenta profesional vinculada.
6. Solicitar acceso avanzado a los permisos usados por la app: `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `pages_messaging`, `pages_manage_posts`, `instagram_basic`, `instagram_manage_messages`, `instagram_content_publish`, `ads_read`, `ads_management` y `business_management`.

## Variables del backend

```env
META_APP_ID=
META_APP_SECRET=
META_GRAPH_VERSION=v25.0
META_WEBHOOK_VERIFY_TOKEN=
META_TOKEN_ENCRYPTION_KEY=
CRM_PUBLIC_URL=https://whatsapp-crm-api-production-f804.up.railway.app
FRONTEND_URL=https://whatsapp-crm-production-c76b.up.railway.app
```

`META_TOKEN_ENCRYPTION_KEY` debe tener al menos 32 caracteres. Si se omite, el sistema deriva la clave desde `JWT_SECRET`. Los tokens de usuario y de página se guardan cifrados con AES-256-GCM.

## Activación para Diez Ríos

1. Desplegar backend y frontend con las variables anteriores.
2. Ingresar al CRM como owner o admin.
3. Abrir **Más funciones → Facebook e Instagram → Conexión**.
4. Pulsar **Conectar Meta** y autorizar la cuenta administradora de Diez Ríos.
5. Elegir la página de Facebook y la cuenta publicitaria correctas y guardar.
6. Enviar un mensaje de prueba a Facebook y a Instagram; verificar que aparezca en **Mensajes** y responder desde el CRM.
7. Hacer una publicación de prueba y revisar las métricas en **Anuncios**.

Instagram debe ser una cuenta profesional (Business o Creator) vinculada a la página de Facebook. Meta no permite iniciar conversaciones frías: la persona debe haber escrito primero a la cuenta profesional.

## Embudo de conversaciones y enlaces rastreables

La vista **Campañas a WhatsApp → Embudo y clientes en limbo** une la atribución del anuncio con los mensajes, los enlaces enviados y los pedidos. Muestra el tiempo hasta la primera respuesta, el avance alcanzado y separa motivos observados de inferencias del sistema.

Desde el redactor de un chat se puede crear un enlace rastreable. El backend genera un token aleatorio sin teléfono ni otros datos personales, lo asocia a la conversación solo cuando el mensaje se envía y registra los clics reales. Las solicitudes conocidas de previsualización de Meta, WhatsApp y otros robots no aumentan el contador.

Los enlaces usan `CRM_PUBLIC_URL` y redirigen desde `/r/:token`; esta variable debe apuntar al backend público con HTTPS.

## Recuperación de pedidos durante una incidencia

Cuando un canal queda inhabilitado y se pierde la referencia Click-to-WhatsApp, un owner o admin puede recuperar los pedidos manuales desde **Campañas a WhatsApp → Compras realizadas**. Debe seleccionar el canal y un período de hasta siete días; opcionalmente puede limitar el proceso a primeras compras. La recuperación solo considera pedidos no cancelados pertenecientes a ese canal y organización, es idempotente y deja la atribución marcada como `recuperada`, distinta de una atribución `exacta` entregada por Meta.
