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
      agents/      → orquestador.js, sales.js, orders.js
      pipeline.js  → orquesta los 3 agentes
      shopify-api.js → GraphQL directo a Shopify Admin API
    db/database.js → queries PostgreSQL (pg pool)
```

**URLs de producción:**
- Backend: `https://whatsapp-crm-front.onrender.com` (nombre confuso pero es el backend)
- Frontend: `https://whatsapp-crm-6fzm.onrender.com` (Static Site, requiere redeploy manual)
- Repo: `https://github.com/raimundovaldivia/whatsapp-crm`

---

## Git — cómo pushear cambios

**Token GitHub (PAT):**  
El token real está guardado en memoria local de Claude (no en el repo para evitar Push Protection de GitHub).  
> ⚠️ Si el push da 403, el token expiró. Generar uno nuevo en https://github.com/settings/tokens → Fine-grained → repo `whatsapp-crm` → permisos: **Contents: Read & Write** → decirle a Claude el nuevo token.

**Flujo de push — Claude usa /tmp/crm-push (clon temporal):**

```bash
# 1. Preparar clon temporal (una vez por sesión)
cd /tmp && rm -rf crm-push
git clone https://TOKEN@github.com/raimundovaldivia/whatsapp-crm.git crm-push
cd crm-push
git config user.email "raivaldiviabou@gmail.com"
git config user.name "Rai"

# 2. Copiar archivos modificados desde el workspace
cp /sessions/.../mnt/A-SHOPIFY/whatsapp-crm/<ruta> /tmp/crm-push/<ruta>

# 3. Commit y push
git add <archivos>
git commit -m "feat: ..."
git push origin main
```

**Regla:** nunca hacer `git push` directo al workspace NTFS — siempre desde el clon `/tmp/crm-push`.

Después del push, el backend en Render hace **auto-deploy**. El frontend (Static Site) requiere **Manual Deploy** en el dashboard de Render.

---

## Proveedor WhatsApp: Kapso (activo)

La org usa **Kapso** como proxy de Meta Cloud API. Esto es importante:

- Webhook de Kapso: `POST /kapso-webhook` — recibe mensajes y responde con IA
- Webhook de Meta: `POST /webhook` — **ignorar si provider='kapso'** (guard ya implementado)
- Envío: `kapso-whatsapp.js` usa `X-API-Key` en lugar de `Authorization: Bearer`
- El `access_token` de Meta es null para orgs que usan Kapso — eso es correcto, no es un bug

**NUNCA procesar el mismo mensaje dos veces.** Kapso Y Meta envían el mismo mensaje a sus respectivos webhooks. El guard en `webhook.js` detecta `provider='kapso'` y retorna sin procesar. `saveMessage` usa `ON CONFLICT (whatsapp_message_id) DO NOTHING` como segunda defensa.

---

## Shopify — integración directa (sin raigentic)

Se usa `shopify-api.js` con GraphQL directo a `https://{shop}/admin/api/2025-01/graphql.json`.

**Credenciales:** `ds.config.accessToken` (OAuth offline token permanente). Se obtienen de `db.getPrimaryDataSource(orgId)`.

```js
const ds = await db.getPrimaryDataSource(orgId);
const { shop, token } = shopifyApi.credentialsFrom(ds);
```

**API version 2025-01 — campos renombrados:**
- `financialStatus` → `displayFinancialStatus`
- `fulfillmentStatus` → `displayFulfillmentStatus`
- `totalSpentV2` → `amountSpent`

**NO usar raigentic** para datos de Shopify. Raigentic tiene `expiringOfflineAccessTokens: true` que causa 401s periódicos. Toda la lógica de productos, clientes y órdenes va directo por GraphQL.

---

## Pipeline de 3 agentes

```
mensaje entrante
  → checkEscalation()  ← en paralelo con classifyIntent
  → classifyIntent()
  → si escalación: setAgentMode('human'), respuesta de escalación
  → si collecting_order: handleOrderCollection()
  → si wants_to_order / interested: salesAgent
  → default: salesAgent (exploring)
```

**Agente de escalación (`orchestrator.js` → `checkEscalation`):**
- Saludos simples ("hola", "hi", "buenas") → NUNCA escalan
- Solicitud explícita de humano → escala inmediato (high)
- Frustración fuerte → escala inmediato (high)
- Requiere `botResponses >= 2` antes de llamar a la IA
- Requiere `history.length >= 8` y `botResponses >= 3` para la llamada a Haiku
- El umbral es conservador a propósito — la IA Haiku tiende a sobre-escalar

**Auto-reset de modo humano:**
Si una conversación está en `agent_mode='human'` y el cliente escribe, el bot verifica cuánto tiempo pasó desde el último mensaje humano (`minutesSinceLastHumanReply`). Si pasaron >= 120 minutos, auto-reset a modo IA. Implementado en `kapso-webhook.js` y `webhook.js`.

---

## Creación de órdenes en Shopify

Flujo: `handleOrderCollection` → `createShopifyOrder` → `shopifyApi.createDraftOrder`

**Draft Order:** Shopify necesita `variantId` o un custom line item. Si `resolveVariantId` no encuentra el producto por nombre, se usa un **custom line item** con `title` + `originalUnitPrice`. Esto es válido en la API de Draft Orders.

```js
// Con variantId:
{ variantId: "gid://shopify/ProductVariant/123", quantity: 1 }

// Sin variantId (fallback):
{ title: "Nombre producto", originalUnitPrice: "12000", quantity: 1 }
```

`resolveVariantId` hace dos búsquedas: nombre completo primero, luego 3 primeras palabras como keywords.

---

## Modelos de IA usados

- `claude-haiku-4-5-20251001` — orquestador, escalación (rápido/barato)
- `claude-sonnet-4-6` — agente de ventas, agente de órdenes (mejor calidad)

---

## Base de datos

PostgreSQL multi-tenant. Cada org tiene `organization_id`. Nunca hacer queries sin filtrar por `orgId`.

Funciones clave en `database.js`:
- `upsertConversation` — crear/obtener conversación por teléfono
- `saveMessage` — usa `ON CONFLICT (whatsapp_message_id) DO NOTHING` para deduplicar
- `setAgentMode(id, 'ai'|'human')` — cambiar modo de respuesta
- `updatePipelineState(id, state, orderDraft)` — actualizar estado del pipeline
- `minutesSinceLastHumanReply(conversationId)` — para auto-reset de modo humano

---

## Errores conocidos y sus causas

| Error | Causa | Solución |
|-------|-------|----------|
| `Merchandise title is empty` | variantId null en createDraftOrder | Custom line item fallback (ya implementado) |
| `duplicate key messages_whatsapp_message_id_key` | Meta + Kapso procesan el mismo mensaje | `ON CONFLICT DO NOTHING` + guard en webhook.js |
| `Authorization: Bearer null` | Org usa Kapso, access_token es null | Guard antes de pipeline en webhook.js |
| `131037` al enviar WhatsApp | Display name no aprobado en Meta Business Manager | Aprobar en Meta Business Manager (no es código) |
| Escalación en "hola" | Historial sucio de mensajes sin respuesta del bot | Whitelist de saludos en checkEscalation |
| Bot no responde tras modo humano | Conversación atascada en modo humano | Auto-reset a 120 min en webhooks |

---

## WhatsApp Templates (ventana 24h expirada)

Cuando el cliente no escribe en 24h, WhatsApp **solo permite templates pre-aprobados**.

### Flujo
1. Template se crea en Meta Business Manager → espera aprobación (1-3 días)
2. Template aprobado tiene: `name`, `language` (ej: `es`), `components` (HEADER, BODY, FOOTER)
3. Variables en BODY: `{{1}}`, `{{2}}` etc.
4. Para enviar: `kapsoService.sendTemplate(to, name, languageCode, components, wc)`
   - `components`: `[{ type: 'body', parameters: [{ type: 'text', text: 'Juan' }] }]`

### Endpoints
- `GET  /api/reengagement/templates` → lista templates aprobados de la org
- `POST /api/reengagement/send`      → soporta `{ phone, templateName, languageCode, components }` O `{ phone, message }`
- `POST /api/reengagement/send-bulk` → igual pero `items[]`
- `POST /api/conversations/:id/send-template` → desde chat individual

### Configuración necesaria
- `business_account_id` en `whatsapp_configs` (WABA ID de Meta) — o env var `KAPSO_WABA_ID`
- Para Kapso: se obtiene en app.kapso.ai → tu número → WABA ID

### UI
- ReengagementPanel: botón "📋 Usar Template" en header → activa modo template → selector + variables + preview → envío masivo
- ChatWindow: botón "📋 Template" en header de conversación → modal con selector, variables, preview, envío

---

## Variables de entorno (Render backend)

```
DATABASE_URL          → PostgreSQL connection string
ANTHROPIC_API_KEY     → Claude API
KAPSO_API_KEY         → Kapso (puede estar en DB por org también)
KAPSO_WABA_ID         → WhatsApp Business Account ID (para listar templates)
PUBLIC_URL            → https://whatsapp-crm-front.onrender.com
FRONTEND_URL          → https://whatsapp-crm-6fzm.onrender.com
JWT_SECRET            → auth tokens
```

---

## Lo que NO hacer

- No llamar a raigentic para datos de Shopify (usa shopify-api.js directo)
- No escalar conversaciones por saludos, preguntas normales de productos, o procesos de pedido en curso
- No bajar el umbral de escalación de la IA — Haiku sobre-escala por naturaleza
- No agregar `await` a `pool.query` sin verificar que el caller también use await (async bug silencioso)
- No agregar lógica en webhook.js para orgs con provider='kapso' — kapso-webhook.js es el handler correcto
