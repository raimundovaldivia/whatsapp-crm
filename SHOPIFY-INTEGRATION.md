# Integración Shopify: inventario comprobado el 24-09-2026

## Activo

El CRM usa `backend/src/services/shopify-api.js` directamente desde catálogo, clientes, pedidos, productos, ajustes, reengagement, setup, pipeline y asistente. Los tokens se obtienen en `routes/shopify-oauth.js` y se guardan por organización en `data_sources`.

El asistente, wizard y ajustes usan OAuth. `GET /api/setup/shopify-status` sigue siendo consumido por ajustes: no está obsoleto aunque viva en setup.

Railway, espacio consultado: `spectacular-grace` contiene `whatsapp-crm-api`, `whatsapp-crm` y PostgreSQL, los tres online. Los otros dos proyectos visibles no contienen una app raigentic. Esta comprobación no cubre otros espacios de trabajo o instalaciones externas.

## Retirado del CRM

- `backend/src/services/raigentic.js`: adaptador antiguo a `/api/productos`, `/api/pedidos`, `/api/ordenes`, `/api/clientes` y `/api/sync`; no tiene imports ni consumidores en el código del CRM.
- `backend/src/services/shopify.js` y `shopify-webhooks.js`: módulos vacíos, marcados deprecados y sin consumidores.
- Helper frontend `setupAPI.connectShopify`: sin consumidores; las pantallas usan OAuth. Se conserva el endpoint de compatibilidad `POST /api/setup/shopify` porque no se han inspeccionado clientes externos.
- Blueprint de Render y enlaces/mensajes operativos de ese proveedor.

`RAIGENTIC_URL` y `BOT_API_SECRET` ya no se leen en el código del CRM después de esta limpieza. Pueden retirarse de las variables del servicio CRM si no las utiliza algún script externo. `BOT_API_SECRET` sigue siendo requerido por la API de la app independiente si esa app se reactiva.

## Candidatos de la app independiente raigentic

- API puente `/api/productos`, `/api/pedidos`, `/api/ordenes`, `/api/clientes`, `/api/sync` y diagnóstico `/api/debug-scopes`: ningún consumidor en el CRM actual; pueden existir consumidores externos no comprobados.
- Caché Prisma de productos y webhooks `products/create`, `products/update`, `products/delete`: mantienen ese catálogo separado, no el catálogo directo del CRM. No eliminar tablas ni suscripciones remotas sin comprobar su uso real.
- `app._index.jsx` y `app.additional.jsx`: pantallas de la plantilla Shopify; la primera permite crear productos Snowboard y metadatos de demostración. No participan en el CRM.
- `_archivo-shopify-app-manual/`: prototipo archivado, fuera del flujo y del despliegue del CRM.

La configuración de despliegue antigua se conserva como `shopify.app.toml.example`, con un dominio `.invalid` que obliga a completar una URL real antes de reactivar la app independiente. No se publicó esa plantilla en Shopify ni se modificaron suscripciones remotas.

## No retirar

La identidad de la app en Shopify, su client ID y secret, sus permisos, la instalación y los tokens por organización siguen siendo necesarios para OAuth. Que el servidor raigentic ya no sea intermediario no significa que la app registrada en Shopify haya dejado de usarse. También se conservan los endpoints de webhooks y lifecycle hasta comprobar sus suscripciones efectivas.
