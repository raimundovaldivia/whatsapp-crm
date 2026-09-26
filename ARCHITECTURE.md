# Arquitectura técnica

## Límites del sistema

El repositorio contiene un backend modular y tres clientes. No es una arquitectura de microservicios.

- `backend/`: API REST, webhooks, Socket.IO, integraciones, bot y jobs.
- `frontend/`: panel web de referencia para administración.
- `mobile/`: operación de reparto, incluida cola local de gastos.
- `mobile-admin/`: cliente administrativo móvil.

PostgreSQL es el estado compartido. Shopify, proveedores WhatsApp, Anthropic, Expo Push, Google Maps y R2 son límites externos. No los llames en pruebas cuando un doble local entrega evidencia suficiente.

## Arranque actual

`backend/src/index.js`:

1. carga configuración y rutas;
2. configura CORS, límites, captura del cuerpo crudo y Socket.IO autenticado;
3. monta webhooks públicos, tienda pública y API;
4. ejecuta `setupDatabase()`;
5. abre el servidor;
6. inicia seguimientos, pedidos agendados, avisos de ventana y vigilancia de escalaciones.

Implicación: cada réplica web inicia temporizadores. Separar API y worker está recomendado, pero no implementado; cualquier cambio de escalado debe considerar duplicación e idempotencia.

## Entradas HTTP

- Públicas: `/health`, `/ready`, catálogo comercial, `/store/:slug/*`, OAuth y webhooks verificados.
- Autenticadas: `/api/*`; `requireAuth` revalida usuario, rol, organización, versión de sesión y estado activo.
- Comerciales: `commercial-access.js` asigna rutas a módulos; servicios sensibles también pueden exigir una capacidad directamente.
- Roles restringidos: repartidor y coordinador tienen listas de rutas permitidas en `auth.js`.

La interfaz oculta capacidades, pero la API es la frontera de autorización. Nunca dependas solo del menú.

## Mensajería y conversación

Los webhooks de Meta, Twilio, Kapso y Shopify verifican autenticidad y pasan por `webhook-inbox.js`. El inbox y los streams PostgreSQL conservan deduplicación, orden por flujo y recuperación tras reinicios.

Kapso es el camino principal documentado para la operación actual. Un teléfono registrado del equipo se dirige a `staff-secretary.js`; un cliente asignado se dirige a `admin-relay.js`; el resto sigue comprobantes, media o `pipeline.js`. Socket.IO emite a salas por organización.

No introduzcas otro consumidor o envío directo sin conservar firma, deduplicación, organización, estado de entrega e idempotencia.

## Bot y operaciones

`pipeline.js` orquesta contexto, catálogo, intención, escalación, ventas y pedidos. Los modelos interpretan texto; el código calcula y valida acciones.

- `agents/orchestrator.js`: intención y derivación.
- `agents/sales.js`: respuesta comercial.
- `agents/orders.js`: extracción de datos y diálogo de pedido.
- `order-pricing.js`: catálogo, cantidades, disponibilidad, precios y totales.
- `order-confirmation.js`: huella del resumen aprobado.
- `response-guardrail.js`: restricciones de respuesta.

Las escrituras críticas deben quedar detrás de servicios reutilizables por panel, chat y comandos. El asistente administrativo antiguo en `agents/assistant.js` todavía no cumple completamente ese límite; consulta deuda conocida.

## Identidad, licencias y contratos

`users` contiene identidad, organización, rol y estado activo. La versión de autenticación revoca tokens al cambiar rol/estado. Actualmente una identidad pertenece a una sola organización.

`commercial_contracts` define estado, módulos, límites y revisión optimista. `commercial_usage` mide turnos del bot. `services/members.js` serializa altas/reactivaciones por organización para respetar cupos. No hay invitaciones ni cobro automático.

El administrador global se configura explícitamente con `PLATFORM_ADMIN_USER_IDS`; un admin de tienda no obtiene ese permiso.

## Datos y transacciones

`database.js` agrupa consultas y reglas heredadas; `setup.js` contiene el esquema principal y ejecuta migraciones SQL adicionales. Operaciones multi tabla sensibles deben usar transacción y filtrar por organización. Consulta [DATABASE.md](DATABASE.md).

## Integraciones

- Shopify: OAuth por organización, GraphQL directo, cache local y webhooks.
- WhatsApp: configuración por organización para Kapso/Meta/Twilio.
- IA: claves de entorno; catálogo y contexto se obtienen por organización.
- R2: almacenamiento opcional de imágenes/documentos.
- Expo Push: tokens ligados a usuarios activos.

La app independiente `raigentic` y Render no forman parte del camino activo del CRM. No borres identidades, OAuth o webhooks de Shopify basándote solo en esa retirada; consulta [SHOPIFY-INTEGRATION.md](SHOPIFY-INTEGRATION.md).

## Decisiones para cambios mínimos

- Añade una ruta solo si no existe una operación equivalente.
- Prefiere extender el servicio que ya usan varios canales.
- Mantén compatibilidad con datos y estados legacy.
- Evita dividir procesos, cambiar proveedor, añadir cola o reemplazar clientes móviles dentro de una tarea funcional aislada.
- Si una mejora arquitectónica no es necesaria para la solicitud, anótala en [KNOWN_ISSUES.md](KNOWN_ISSUES.md).
