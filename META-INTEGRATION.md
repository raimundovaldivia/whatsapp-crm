# Integración Meta — Facebook, Instagram y Ads

El CRM incluye un módulo **Facebook e Instagram** con cuatro capacidades:

- autorización OAuth por organización;
- bandeja de mensajes de Facebook Messenger e Instagram, con respuesta manual o automática de Diva y creación de pedidos en el CRM;
- bandeja de comentarios de Facebook e Instagram, con respuesta manual o automática de Diva;
- publicación de texto, imágenes, videos y Reels;
- resumen de rendimiento de Meta Ads de los últimos 30 días.

## Configuración en Meta for Developers

1. Crear o reutilizar una app de tipo Business y agregar Facebook Login for Business, Messenger, Instagram Graph API y Marketing API.
2. En OAuth, registrar esta URL exacta:
   `https://whatsapp-crm-api-production-f804.up.railway.app/meta-oauth/callback`
3. En Webhooks, registrar:
   `https://whatsapp-crm-api-production-f804.up.railway.app/meta-webhook`
4. Usar el mismo valor de `META_WEBHOOK_VERIFY_TOKEN` como token de verificación.
5. Suscribir la página a `messages`, `messaging_postbacks` y `feed`. Para Instagram, suscribir la cuenta profesional a `messages`, `messaging_postbacks` y `comments`.
6. Solicitar acceso avanzado a los permisos usados por la app: `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `pages_messaging`, `pages_manage_posts`, `pages_manage_engagement`, `instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments`, `instagram_content_publish`, `ads_read`, `ads_management` y `business_management`.

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
6. En **Conexión → Atención automática con Diva**, activar por separado mensajes privados y comentarios. Las opciones comienzan desactivadas para evitar respuestas públicas accidentales al conectar una cuenta existente.
7. Enviar un mensaje de prueba a Facebook y a Instagram; verificar que aparezca en **Mensajes** y que Diva responda usando el catálogo vigente.
8. Probar un pedido completo por mensaje privado: producto y cantidad → nombre → dirección → ciudad → teléfono → resumen → confirmación. El pedido debe aparecer en **Pedidos** y como referencia dentro del chat social. El sistema nunca inventa el teléfono: exige uno válido antes de confirmar.
9. Crear un comentario de prueba en ambas redes; verificarlo en **Comentarios**. Diva responde públicamente de forma breve y deriva los datos privados o la compra a mensaje directo o a la tienda.
10. Hacer una publicación de prueba y revisar las métricas en **Anuncios**.

Instagram debe ser una cuenta profesional (Business o Creator) vinculada a la página de Facebook. Meta no permite iniciar conversaciones frías: la persona debe haber escrito primero a la cuenta profesional.

La automatización social requiere además el módulo **Ventas con IA** activo. Si Marketing o Ventas con IA no está contratado, el backend no ejecuta respuestas automáticas. Los eventos repetidos se deduplican por el identificador entregado por Meta y las respuestas propias de la página o cuenta se ignoran para evitar bucles.

Los mensajes privados usan el mismo pipeline de catálogo, precios, datos de despacho, confirmación, prevención de duplicados y creación de pedidos que WhatsApp. Cada identidad de Instagram o Facebook se guarda separada por organización y canal, sin convertir el identificador de Meta en un teléfono. Los comentarios permanecen públicos y nunca recopilan nombre, dirección, teléfono ni otros datos del pedido.

## Embudo de conversaciones y enlaces rastreables

La vista **Campañas a WhatsApp → Embudo y clientes en limbo** une la atribución del anuncio con los mensajes, los enlaces enviados y los pedidos. Muestra el tiempo hasta la primera respuesta, el avance alcanzado y separa motivos observados de inferencias del sistema.

Desde el redactor de un chat se puede crear un enlace rastreable. El backend genera un token aleatorio sin teléfono ni otros datos personales, lo asocia a la conversación solo cuando el mensaje se envía y registra los clics reales. Las solicitudes conocidas de previsualización de Meta, WhatsApp y otros robots no aumentan el contador.

Los enlaces usan `CRM_PUBLIC_URL` y redirigen desde `/r/:token`; esta variable debe apuntar al backend público con HTTPS.

## Recuperación de pedidos durante una incidencia

Cuando un canal queda inhabilitado y se pierde la referencia Click-to-WhatsApp, un owner o admin puede recuperar los pedidos manuales desde **Campañas a WhatsApp → Compras realizadas**. Debe seleccionar el canal y un período de hasta siete días; opcionalmente puede limitar el proceso a primeras compras. La recuperación solo considera pedidos no cancelados pertenecientes a ese canal y organización, es idempotente y deja la atribución marcada como `recuperada`, distinta de una atribución `exacta` entregada por Meta.
