# WhatsApp CRM — Guía para Claude

## Qué es este proyecto

CRM multi-tenant de WhatsApp con agentes de IA para automatizar ventas. Las tiendas Shopify conectan su catálogo, los clientes escriben por WhatsApp, y 3 agentes de IA (orquestador, ventas, órdenes) gestionan la conversación y crean pedidos en Shopify.

---

## Arquitectura

```
frontend/          → React + Vite (Static Site en Render)
backend/           → Node.js + Express + Socket.io (Web Service en Render)
  src/
    routes/        → API REST endpoints
    services/      → lógica de negocio
      agents/      → orchestrator.js, sales.js, orders.js
      pipeline.js  → orquesta los 3 agentes
      shopify-api.js → GraphQL directo a Shopify Admin API
      scheduled-orders.js  → detección y extracción de pedidos futuros
      scheduled-follow-up.js → cron job diario para follow-up con template
      bot-logger.js → logging estructurado con trace IDs
    db/
      database.js  → queries PostgreSQL (pg pool)
      setup.js     → migraciones DDL (se corren en cada arranque)
  scripts/         → scripts one-off para Railway (normalizar datos, crear templates, etc.)
```

**URLs de producción:**
- Backend: `https://whatsapp-crm-front.onrender.com`
- Frontend: `https://whatsapp-crm-6fzm.onrender.com` (Static Site — requiere Manual Deploy)
- Repo: `https://github.com/raimundovaldivia/whatsapp-crm`

---

## Git — cómo pushear cambios

**⚠️ El workspace está en NTFS (Windows). Git en NTFS tiene problemas con lock files.**
**NUNCA hacer git directamente en `/sessions/.../mnt/A-SHOPIFY/whatsapp-crm`. SIEMPRE usar el clon en `/tmp/crm-push`.**

**Token GitHub:** en auto-memory (`reference_github_token.md`). NUNCA ponerlo en ningún archivo del repo — GitHub Push Protection lo bloquea y rechaza el push.

**Flujo de push:**

```bash
# Si el clon no existe:
cd /tmp && rm -rf crm-push
git clone "https://raimundovaldivia:<TOKEN>@github.com/raimundovaldivia/whatsapp-crm.git" crm-push
cd crm-push
git config user.email "raivaldiviabou@gmail.com"
git config user.name "Raimundo Valdivia"

# Siempre antes de copiar archivos (evitar divergencia):
cd /tmp/crm-push && git fetch origin && git reset --hard origin/main

# Copiar, commitear, pushear:
cp /sessions/hopeful-admiring-carson/mnt/A-SHOPIFY/whatsapp-crm/<archivo> /tmp/crm-push/<archivo>
git add <archivos>
git commit -m "tipo: descripción\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
git push origin main
```

Después del push: **backend en Railway hace auto-deploy**. El frontend (Render Static Site) requiere **Manual Deploy** en el dashboard de Render.

---

## Base de datos — tablas clave

PostgreSQL multi-tenant. **NUNCA hacer queries sin `WHERE organization_id = $1`.**

### contacts
La tabla central de clientes. El teléfono es el ID canónico.

```
phone        TEXT    → formato canónico: 56XXXXXXXXX (sin +, con código de país)
address1     TEXT    → calle y número (campo estructurado — usar este)
address      TEXT    → campo legacy de texto libre (fallback si address1 es null)
city         TEXT    → ciudad
province     TEXT    → región/provincia
zip          TEXT    → código postal
country      TEXT    → país
opt_out      BOOLEAN → no quiere mensajes (excluir de broadcast)
last_order_at TIMESTAMP → se actualiza tanto por Shopify como por pedidos del bot
total_orders  INTEGER   → count de pedidos
contact_type  TEXT    → 'lead' | 'customer'
shopify_id    TEXT    → ID de cliente en Shopify
```

**Funciones para upsert:**
- `upsertContact(orgId, { phone, name, email, address, city, region, shopifyId })` — campos básicos, campo `address` legacy
- `upsertShopifyCustomerProfile(orgId, c)` — upsert completo con `address1`, `address2`, `city`, `province`, `zip`, `country` — **usar esta cuando lleguen datos ricos de Shopify**

### conversations
```
phone_number  TEXT    → teléfono normalizado (56XXXXXXXXX)
pipeline_state TEXT   → estado del pipeline (ver sección Pipeline)
agent_mode    TEXT    → 'ai' | 'human'
```

### orders (pedidos del bot/CRM)
```
customer_phone TEXT   → teléfono normalizado
shipping_address JSONB → { address, city } o { address1, city, zip }
status        TEXT    → 'nuevo' | 'confirmed' | 'payment_received' | 'sent' | 'cancelled'
```

### shopify_orders (caché de órdenes Shopify)
```
customer_phone  TEXT  → teléfono normalizado (56XXXXXXXXX)
shipping_city   TEXT  → ciudad de envío
shipping_address1 TEXT → dirección editable manualmente
financial_status TEXT → 'PAID' | 'PENDING' | 'REFUNDED' | 'VOIDED'
items           JSONB → [{ name, quantity, price }]
raw_json        JSONB → objeto completo de la orden de Shopify
```

### scheduled_orders (pedidos para fecha futura)
```
phone          TEXT   → teléfono del cliente
desired_date   DATE   → fecha en que quiere el pedido
product_notes  TEXT   → qué quiere pedir (extraído por LLM)
template_name  TEXT   → template de WhatsApp a usar en el follow-up
status         TEXT   → 'pending' | 'sent' | 'cancelled'
```

---

## Normalización de teléfonos — regla de oro

**Formato canónico: `56XXXXXXXXX` (11 dígitos, sin +, sin espacios)**

`normalizePhone()` en `database.js` es la función única para esto. Aplicarla SIEMPRE antes de guardar o comparar teléfonos.

```js
const { normalizePhone } = require('../db/database');
const phone = normalizePhone(rawPhone); // 56912345678
```

**Bugs históricos por no normalizar:**
- `cleanPhone()` en `shopify-webhook.js` solo quitaba el `+` sin agregar `56` → duplicados en contacts
- `customer_phone` en `shopify_orders` se guardaba sin normalizar → JOIN con contacts fallaba → "Sin pedidos" aunque el contacto tenía historial
- **Regla:** toda función que guarde teléfono en DB debe pasar por `normalizePhone()` primero

**JOINs entre tablas por teléfono:** usar `LATERAL` con `LIMIT 1` para evitar duplicados si hay datos sucios:
```sql
LEFT JOIN LATERAL (
  SELECT address1, city FROM contacts
  WHERE organization_id = so.organization_id AND phone = so.customer_phone
  LIMIT 1
) ct ON true
```

---

## Normalización de nombres

`normalizeName()` en `database.js` — convierte a Title Case respetando partículas (de, del, la, etc.).
- `"JUAN PÉREZ"` → `"Juan Pérez"`
- `"juan de la vega"` → `"Juan de la Vega"`
- Nombres con mezcla de mayúsculas/minúsculas ya formateados → no se tocan

Aplicar en `upsertContact`, `upsertShopifyCustomerProfile`, `upsertShopifyOrders`.

---

## Pipeline — estados

```
exploring        → cliente explorando, sin intención clara
interested       → muestra interés en un producto
collecting_order → confirmó compra, bot recopilando datos (nombre, dirección)
confirmed        → datos recopilados, orden creada
awaiting_payment → esperando comprobante
scheduled        → quiere pedir para fecha futura explícita (ej: "el viernes")
future_interest  → interés vago sin fecha ("lo pienso", "ya te aviso")
template_sent    → se envió template de follow-up (ventana 24h expirada)
done             → flujo completado
```

**Intenciones clasificadas por Haiku:** `greeting | exploring | interested | wants_to_order | order_confirmed | payment | complaint | opt_out | other`

**Detección de intención futura:**
- `isFutureOrderIntent(msg)` → fecha explícita → `scheduled` → cron job envía template el día indicado
- `isSoftFutureIntent(msg)` → sin fecha ("de repente", "quizás", "ya te aviso") → `future_interest` → salesAgent con modo no-presión
- "de repente" en Chile significa "quizás", no "de repente" — está en los patrones

---

## Historial de compras — dos tablas

El historial de un cliente está en DOS tablas:
- `shopify_orders` → órdenes que pasaron por Shopify
- `orders` → órdenes generadas por el bot/CRM manual

El endpoint `GET /api/orders/history/:phone` ya devuelve ambas:
```js
{ shopifyOrders: [...], botOrders: [...], summary: { totalPedidos, totalGastado, ultimaCompra } }
```

El frontend (ChatWindow.jsx) mezcla ambas listas ordenadas por fecha y muestra badge "Shopify" o "Bot". **El resumen debe sumar ambas fuentes.**

---

## Broadcast — filtros importantes

`GET /api/contacts/broadcast` excluye:
- Contactos con `opt_out = TRUE`
- Contactos sin teléfono

El frontend además filtra por `last_order_at` (excluye quienes compraron recientemente).

**⚠️ CRÍTICO:** `last_order_at` se actualiza en dos momentos:
1. Cuando Shopify sincroniza una orden (`upsertShopifyOrders`)
2. Cuando el bot crea un pedido (`createOrder`) — **se actualiza en contacts vía `normalizePhone(customerPhone)`**

Si `createOrder` no actualiza `last_order_at`, clientes con pedidos recientes del bot aparecen en el broadcast.

---

## Proveedor WhatsApp: Kapso

- Webhook de Kapso: `POST /kapso-webhook` — único handler para mensajes
- Webhook de Meta: `POST /webhook` — **ignorar si provider='kapso'** (guard ya implementado)
- Envío: `kapso-whatsapp.js` usa header `X-API-Key` (no `Authorization: Bearer`)
- `access_token` de Meta es null para orgs Kapso — **eso es correcto, no es un bug**

**NUNCA procesar el mismo mensaje dos veces.** Kapso Y Meta envían el mismo mensaje. El guard en `webhook.js` detecta `provider='kapso'` y retorna sin procesar.

---

## Shopify — integración directa

GraphQL directo a `https://{shop}/admin/api/2025-01/graphql.json`.

```js
const ds = await db.getPrimaryDataSource(orgId);
const { shop, token } = shopifyApi.credentialsFrom(ds);
```

**API version 2025-01 — campos renombrados:**
- `financialStatus` → `displayFinancialStatus`
- `fulfillmentStatus` → `displayFulfillmentStatus`
- `totalSpentV2` → `amountSpent`

**⚠️ NO remover de `ORDERS_QUERY`:** `shippingAddress { firstName lastName address1 address2 city province zip country phone }` y `billingAddress { ... }`. Si no están, llegan como null aunque existan en Shopify. Esto causó pérdida de teléfonos y direcciones.

**NO usar raigentic** para datos de Shopify — tiene tokens expirables que causan 401 periódicos.

---

## Creación de órdenes en Shopify

```
handleOrderCollection → createShopifyOrder → shopifyApi.createDraftOrder
```

Si `resolveVariantId` no encuentra el producto → **custom line item** (title + price). Válido en Draft Orders API.

**Prevención de duplicados:** `claimOrderCreation(conversationId)` hace un `UPDATE ... WHERE pipeline_state = 'collecting_order'`. Solo el primero en ejecutarlo gana (rowCount > 0). Usado para evitar que dos mensajes simultáneos creen dos órdenes.

---

## Modelos de IA

- `claude-haiku-4-5-20251001` — clasificación de intención, escalación, extracción de datos (rápido/barato)
- `claude-sonnet-4-6` — agente de ventas, agente de órdenes (mejor calidad)

---

## Direcciones — campos canónicos

La tabla `contacts` tiene dos sistemas de campos de dirección:
- **Nuevo (estructurado):** `address1`, `address2`, `city`, `province`, `zip`, `country`
- **Legacy (texto libre):** `address` (campo viejo)

**Regla:** siempre priorizar `address1`. Si está vacío, usar `address` como fallback.

```js
const addr = contact.address1 || contact.address || '';
const city = contact.city || '';
```

La tabla `shopify_orders` tiene `shipping_city` (histórico) y `shipping_address1` (agregado para edición manual).

---

## Sistema de Re-enganche

- `routes/reengagement.js` — análisis y envío
- `services/reengagement-calibration.js` — backtesting histórico
- Tablas: `reengagement_daily_cache`, `reengagement_predictions`, `org_reengagement_calibration`

**Batches de predicción IA:**
- Batch size: **20 clientes máximo** (más → JSON supera max_tokens)
- `max_tokens`: **8192 mínimo** (menos → respuesta truncada, `JSON.parse` devuelve `[]` silenciosamente)
- Fallback si IA falla: `predictedDays = avgFreqDays - daysInactive`

**Caché:** una vez por día en `reengagement_daily_cache`. Refresh asíncrono (`?refresh=true`) porque Render corta conexiones a los 30s. El análisis tarda 3-5 min.

---

## WhatsApp Templates (ventana 24h)

Para enviar a clientes que no escribieron en 24h se necesita template aprobado por Meta.

```js
kapsoService.sendTemplate(to, templateName, languageCode, components, wc)
// components: [{ type: 'body', parameters: [{ type: 'text', text: 'Juan' }] }]
```

**Endpoints:**
- `GET  /api/templates` → lista templates (APPROVED/PENDING/REJECTED)
- `POST /api/templates` → crear template
- `POST /api/templates/generate` → IA genera draft de template
- `POST /api/reengagement/send-bulk` → envío masivo con template
- `POST /api/conversations/:id/send-template` → desde chat individual

**Pedidos agendados:** template `pedido_agendado_seguimiento` — 2 variables: `{{1}}` nombre, `{{2}}` producto. Cron job en `scheduled-follow-up.js` lo envía a las 9AM Chile (13:00 UTC).

---

## Agente de escalación

- Saludos simples ("hola", "hi") → **NUNCA escalan**
- Requiere `botResponses >= 2` antes de llamar a la IA
- Requiere `history.length >= 8` y `botResponses >= 3` para la IA
- El umbral es conservador — Haiku tiende a sobre-escalar con umbrales bajos

**Auto-reset modo humano:** si pasaron >= 120 min sin respuesta humana, la conversación vuelve a modo IA automáticamente.

---

## Bot Logger

```js
const L = createBotLogger(orgName, phone);
L.in(userMessage);          // mensaje entrante
L.intent('wants_to_order'); // intención clasificada
L.agent('sales', ms);       // agente usado + tiempo
L.response(botReply);       // respuesta del bot
L.done();                   // fin del flujo
```

Llamar `L.agent('nombre', Date.now() - t)` en **cada** rama de retorno de `pipeline.js`.

---

## Variables de entorno (Railway backend)

```
DATABASE_URL          → PostgreSQL connection string
ANTHROPIC_API_KEY     → Claude API
KAPSO_API_KEY         → Kapso (puede estar en DB por org)
KAPSO_WABA_ID         → WhatsApp Business Account ID
JWT_SECRET            → auth tokens
```

---

## Scripts one-off (Railway)

```bash
railway run node backend/scripts/normalize-shopify-phones.js    # normaliza customer_phone histórico
railway run node backend/scripts/normalize-contact-names.js     # normaliza nombres a Title Case
railway run node backend/scripts/create-scheduled-order-template.js  # crea template pedido_agendado_seguimiento
```

---

## Errores conocidos y sus causas

| Error | Causa | Solución |
|-------|-------|----------|
| Duplicados en contacts | Teléfonos sin normalizar (`cleanPhone` vs `normalizePhone`) | Siempre usar `normalizePhone()` antes de guardar |
| Pedidos aparecen duplicados en lista | JOIN normal con contacts duplicados | Usar `LEFT JOIN LATERAL (...) LIMIT 1` |
| "Sin pedidos" aunque el contacto tiene historial | `customer_phone` en `shopify_orders` sin normalizar | `normalizePhone()` antes del INSERT |
| Broadcast llega a clientes que ya pidieron | `createOrder` no actualizaba `last_order_at` | Ya corregido — lo actualiza vía `normalizePhone(customerPhone)` |
| Historial solo muestra pedidos Shopify | Frontend solo leía `shopifyOrders` del response | Mezclar `shopifyOrders` + `botOrders` |
| `Merchandise title is empty` | variantId null en createDraftOrder | Custom line item fallback (implementado) |
| `duplicate key messages_whatsapp_message_id_key` | Meta + Kapso duplican el mismo mensaje | `ON CONFLICT DO NOTHING` + guard en webhook.js |
| `Authorization: Bearer null` | Org usa Kapso, access_token es null | Guard antes de pipeline en webhook.js |
| Escalación en "hola" | Historial sucio | Whitelist de saludos en checkEscalation |
| JSON.parse silencioso en predicciones | `max_tokens` muy bajo, respuesta truncada | Mantener `max_tokens: 8192` |

---

## LO QUE NO HACER

- No usar `cleanPhone()` — solo `normalizePhone()` de `database.js`
- No hacer JOIN directo `contacts.phone = tabla.phone` sin LATERAL si puede haber duplicados
- No llamar a raigentic para datos de Shopify (usa shopify-api.js directo)
- No escalar por saludos, preguntas de producto, o procesos de pedido en curso
- No bajar el umbral de escalación — Haiku sobre-escala
- No agregar `await` a `pool.query` sin verificar que el caller también use `async`
- No procesar mensajes en `webhook.js` cuando `provider='kapso'` — handler es `kapso-webhook.js`
- No remover `shippingAddress`/`billingAddress` de `ORDERS_QUERY` en shopify-api.js
- No bajar `max_tokens` del batch de predicción por debajo de 8192
- No subir el batch size de predicción por encima de 20
- No hacer git directamente en el workspace NTFS — siempre usar `/tmp/crm-push`
- No poner tokens de GitHub en ningún archivo del repo
- No usar `upsertContact()` cuando hay datos ricos de dirección de Shopify — usar `upsertShopifyCustomerProfile()`
