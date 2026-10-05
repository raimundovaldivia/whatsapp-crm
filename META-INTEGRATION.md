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
