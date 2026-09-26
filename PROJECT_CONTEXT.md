# Contexto compacto del proyecto

## Propósito

Resel es un CRM multiempresa para operar conversaciones de WhatsApp y ecommerce. Integra atención humana, bot de ventas, pedidos, pagos, reparto, catálogo, marketing y analítica. La venta es modular por organización; compradores y contactos no son licencias del equipo.

## Stack y superficies

- Backend: Node.js CommonJS, Express, Socket.IO y PostgreSQL.
- Web: React 18 con Vite.
- Reparto: Expo/React Native en `mobile/`.
- Administración móvil: Expo/React Native en `mobile-admin/`.
- IA: Anthropic; OpenAI se usa opcionalmente para transcripción.
- Canales: Kapso, Meta y Twilio para WhatsApp.
- Ecommerce: Shopify Admin GraphQL directo y catálogo propio.
- Infraestructura descrita: Railway para API, web y PostgreSQL; R2 opcional para archivos.

## Arquitectura en una vista

`webhook verificado → inbox PostgreSQL → conversación/mensaje → pipeline o atención humana → validación de negocio → proveedor → estado/Socket.IO`

La API también inicia los jobs periódicos después de ejecutar `setupDatabase()`. Este acoplamiento es actual y está documentado como deuda; no asumas un worker separado.

La identidad autenticada aporta `userId`, `organization_id` y rol. El acceso combina rol, contrato modular y alcance por organización. Las cuentas suspendidas conservan historial, liberan cupo e invalidan sesiones.

## Módulos comerciales

Base: conversaciones, clientes, equipo e integraciones.

Capacidades: `sales_ai`, `orders`, `marketing`, `payments`, `delivery`, `storefront` y `analytics`. El catálogo canónico y sus dependencias viven en `backend/src/services/solution-catalog.js`. La contratación y el cobro de suscripción siguen siendo asistidos.

## Dónde buscar

| Necesidad | Entrada principal |
|---|---|
| Composición del servidor | `backend/src/index.js` |
| Auth y roles | `backend/src/middleware/auth.js` |
| Contratos y cuotas | `backend/src/services/commercial.js`, `routes/commercial.js` |
| Usuarios activos | `backend/src/services/members.js`, `routes/users.js` |
| Mensajes entrantes | `routes/*webhook.js`, `services/webhook-inbox.js` |
| Bot de compradores | `services/pipeline.js`, `services/agents/` |
| Precios/confirmación | `services/order-pricing.js`, `services/order-confirmation.js` |
| Atención humana WA | `services/staff-secretary.js`, `admin-relay.js`, `admin-assignment.js` |
| Shopify | `services/shopify-api.js`, `routes/shopify-oauth.js`, `routes/shopify-webhook.js` |
| Pagos | `routes/payment-proofs.js`, `services/payment-proof-balance.js`, `services/reconciliation.js` |
| Reparto | `routes/delivery.js`, `mobile/` |
| UI web/navegación | `frontend/src/App.jsx`, `frontend/src/components/` |
| Esquema y acceso DB | `backend/src/db/setup.js`, `database.js`, `db/*.sql` |

## Flujos críticos

- Mensaje de comprador: firma del proveedor, persistencia/deduplicación, identificación de tienda, mensaje, atención asignada o pipeline, respuesta y eventos en vivo.
- Pedido del bot: extracción de intención/datos, precio y stock desde catálogo, resumen con huella, confirmación explícita del cliente, reclamo anti duplicado, creación local o borrador Shopify.
- Atención humana: teléfono del equipo resuelto por organización, sesión privada, propuesta/confirmación y asignación persistente.
- Contrato: módulos y cuotas por organización; las preferencias pueden ocultar, nunca conceder, capacidades.
- Pagos y reparto: estados locales y Shopify conviven; cualquier cambio requiere aislamiento por organización y evidencia del estado resultante.

## Reglas críticas

- `organization_id` delimita todos los datos.
- Teléfono canónico: `normalizePhone()`; evita nuevas variantes de normalización.
- `contacts` es la referencia del cliente; historial de compras existe en `orders` y `shopify_orders`.
- Stock `-1` significa inventario no controlado en partes del sistema.
- Una confirmación de pedido corresponde al mismo resumen valorizado; pago y confirmación de pedido son hechos distintos.
- La pausa global del bot debe evaluarse antes de consumir IA.
- Los secretos viven en entorno o DB administrada; nunca en documentos o pruebas.

## Estado que no debe confundirse

Este árbol incluye cambios locales no confirmados para atención humana, comprobantes, reparto, usuarios activos y seguridad del bot. Las pruebas locales actuales los cubren, pero su presencia aquí no demuestra que estén desplegados. Consulta [KNOWN_ISSUES.md](KNOWN_ISSUES.md) antes de planificar correcciones.

## Documentación especializada

- [ARCHITECTURE.md](ARCHITECTURE.md): límites técnicos y dependencias.
- [DATABASE.md](DATABASE.md): grupos de tablas, migraciones e invariantes.
- [DEPLOYMENT.md](DEPLOYMENT.md): configuración y publicación segura.
- [HARNESS.md](HARNESS.md): verificación proporcional existente.
- [KNOWN_ISSUES.md](KNOWN_ISSUES.md): deuda vigente y cierres locales conocidos.
- [COMMERCIAL.md](COMMERCIAL.md), [ADMIN-HANDOFF.md](ADMIN-HANDOFF.md) y [SHOPIFY-INTEGRATION.md](SHOPIFY-INTEGRATION.md): detalles funcionales.
- Auditorías históricas: `../audit-2026-09-24/`; sirven como evidencia de origen, no como estado vigente.
