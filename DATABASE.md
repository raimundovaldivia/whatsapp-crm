# Base de datos y migraciones

## Fuente de verdad

PostgreSQL es la base actual. El esquema se crea de forma idempotente desde `backend/src/db/setup.js`, que después ejecuta:

1. `backend/src/db/commercial.sql`;
2. `backend/src/db/members.sql`;
3. `backend/src/db/admin-handoff.sql`.

No existe todavía un framework de migraciones con versiones descendentes. No cambies tablas basándote solo en este mapa: busca la definición y todos los usos del campo.

## Grupos de datos

| Área | Tablas principales |
|---|---|
| Tenencia e identidad | `organizations`, `users`, `data_sources`, `whatsapp_configs`, `settings` |
| Conversación | `conversations`, `messages`, `contacts`, `escalation_feedback` |
| Pedidos y catálogo | `orders`, `shopify_orders`, `scheduled_orders`, `products`, `products_cache`, `contact_price_overrides` |
| Pagos | `payment_proofs`, `bank_statements`, `bank_movements` |
| Reparto | `delivery_routes`, `delivery_expenses`, `geocode_cache` |
| Marketing | `reengagement_daily_cache`, `reengagement_predictions`, `org_reengagement_calibration` |
| Mensajería durable | `webhook_inbox`, `webhook_streams`, `admin_outbox`, `admin_pending_replies` |
| Atención del equipo | `admin_assignments`, `admin_notification_deliveries`, `admin_delivery_receipts`, `staff_secretary_sessions`, `staff_secretary_actions`, `human_attention_reminders`, `push_tokens` |
| Comercial | `commercial_contracts`, `commercial_usage`, `commercial_requests`, `commercial_audit`, `commercial_migrations` |

## Invariantes

- La mayoría de las consultas de negocio debe incluir `organization_id`.
- `users.email` es globalmente único y cada usuario pertenece hoy a una organización.
- `users.active=false` suspende sin borrar historial; `auth_version` invalida sesiones.
- `contacts.phone` debe recibir `normalizePhone()`; contactos, conversaciones y pedidos históricos pueden contener formatos legacy.
- El historial de compra se compone de `orders` y `shopify_orders`.
- `products.stock=-1` se usa como inventario no controlado.
- `commercial_contracts.revision` protege actualizaciones concurrentes.
- `commercial_usage` usa mes UTC y actualización atómica.
- `webhook_inbox` y `webhook_streams` sostienen deduplicación/procesamiento durable.
- La asignación humana permite un cliente activo por teléfono del equipo y un encargado por cliente.

## Política para cambios de esquema

Un cambio de esquema es de alto riesgo:

1. busca tabla, columnas, índices y consultas relacionadas;
2. confirma compatibilidad con registros existentes y valores nulos/legacy;
3. usa migración aditiva e idempotente cuando sea posible;
4. evita borrar/renombrar columnas en la misma publicación que cambia lectores;
5. añade o adapta una prueba PGlite que ejecute la migración dos veces;
6. prueba aislamiento por organización y rollback si la operación cruza tablas;
7. actualiza este documento solo en la sección afectada;
8. respalda PostgreSQL y prueba la migración antes de producción.

No ejecutes migraciones manuales en producción para “ver si funcionan”. El proceso actual ejecuta setup al arrancar, por lo que una migración defectuosa impide que la API escuche.

## Pruebas relacionadas

- `test/database.test.cjs`: migraciones generales, aislamiento de pagos y rollback.
- `test/commercial.test.cjs`: contratos, cuotas, usuarios activos y concurrencia.
- `test/admin-handoff.test.cjs`: tablas y persistencia de atención humana.
- `test/payment-abonos.test.cjs`: comprobantes parciales y duplicados.
- `test/regressions.test.cjs`: reparto, inbox durable y regresiones multi tabla.

Comandos y alcance: [HARNESS.md](HARNESS.md).
