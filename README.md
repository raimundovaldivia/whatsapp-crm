# 🤖 Aplicación comercial con WhatsApp y agentes de IA

Una aplicación comercial que centraliza WhatsApp, atención humana, agentes de inteligencia artificial, ventas y pedidos. Puede usar Shopify como conexión de catálogo y operaciones, y admite Meta, Kapso, Twilio y varios números mediante Evolution API.

---

## ✨ Características

- 💬 **UI tipo WhatsApp** — interfaz familiar para gestionar todas las conversaciones
- 🤖 **Agentes IA intercambiables** — Claude o DeepSeek cubren conversación, análisis, campañas, asistentes e imágenes
- ⏸️ **Toggle IA/Humano por conversación** — pausa el bot y toma control cuando quieras
- 🛍️ **Conexión Shopify** — aporta catálogo, clientes y pedidos cuando está habilitada
- 🔔 **Tiempo real** — los mensajes aparecen instantáneamente con Socket.io
- 📦 **Cache de productos** — evita llamadas excesivas a la API de Shopify
- 📊 **Contador de no leídos** — igual que WhatsApp
- 🔍 **Buscador** — filtra conversaciones por nombre, teléfono o mensaje

---

## 🏗️ Arquitectura

```
┌─────────────────┐     webhooks      ┌──────────────────────┐
│   WhatsApp API  │ ──────────────►   │   Backend Node.js    │
│   (Meta Cloud)  │ ◄──────────────   │   Express + SQLite   │
└─────────────────┘   send message    │   Socket.io          │
                                      └──────────┬───────────┘
┌─────────────────┐                              │ REST + WS
│   Shopify API   │ ◄────────────────────────►   │
│   (productos)   │                              │
└─────────────────┘                   ┌──────────▼───────────┐
                                      │   Frontend React     │
┌─────────────────┐                   │   CRM tipo WhatsApp  │
│ Proveedor de IA │ ◄────────────────►│                      │
│ Claude/DeepSeek │                   └──────────────────────┘
└─────────────────┘
```

---

## 🚀 Instalación y Setup

### Prerequisitos

- Node.js 18+
- Cuenta de Meta for Developers
- Cuenta del proveedor de IA elegido: Anthropic o DeepSeek
- Tienda Shopify con acceso de administrador

---

### Paso 1 — Clonar e instalar dependencias

```bash
# Instalar backend
cd backend
npm install

# Instalar frontend
cd ../frontend
npm install
```

---

### Paso 2 — Configurar variables de entorno

**Backend** (`backend/.env`):
```env
PORT=3001
WHATSAPP_TOKEN=tu_access_token_permanente
WHATSAPP_PHONE_NUMBER_ID=tu_phone_number_id
WHATSAPP_BUSINESS_ACCOUNT_ID=tu_business_account_id
WEBHOOK_VERIFY_TOKEN=cualquier_palabra_secreta_que_eliges
# Elige anthropic (predeterminado) o deepseek para todos los procesos de IA
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=tu_clave_de_anthropic
# Si AI_PROVIDER=deepseek:
DEEPSEEK_API_KEY=tu_clave_de_deepseek
# Opcional: transcripción de audios cuando WhatsApp no entrega texto
AUDIO_TRANSCRIPTION_PROVIDER=openai
OPENAI_API_KEY=tu_clave_de_openai
SHOPIFY_STORE_URL=tu-tienda.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_...
FRONTEND_URL=http://localhost:5173
```

**Frontend** (`frontend/.env`):
```env
VITE_BACKEND_URL=http://localhost:3001
```

---

### Paso 3 — Obtener credenciales de Meta (WhatsApp)

1. Ve a [developers.facebook.com](https://developers.facebook.com)
2. Crea una nueva app → tipo **Business**
3. Agrega el producto **WhatsApp**
4. En **WhatsApp > API Setup**:
   - Copia el **Phone Number ID** → `WHATSAPP_PHONE_NUMBER_ID`
   - Copia el **WhatsApp Business Account ID** → `WHATSAPP_BUSINESS_ACCOUNT_ID`
   - Genera un **Access Token Permanente** → `WHATSAPP_TOKEN`
5. En **WhatsApp > Configuration > Webhooks**:
   - URL: `https://TU-DOMINIO/webhook`
   - Verify Token: el mismo valor que pusiste en `WEBHOOK_VERIFY_TOKEN`
   - Suscribir a: `messages`, `message_deliveries`, `message_reads`

---

### Paso 4 — Obtener credenciales de Shopify

1. Ve a tu tienda Shopify → **Configuración → Apps y canales de ventas**
2. Click en **Desarrollar apps**
3. Crea una nueva app
4. En **Configuración de la API de Admin**, da acceso a:
   - `read_products`
   - `read_inventory`
5. Instala la app y copia el **Access Token** → `SHOPIFY_ACCESS_TOKEN`
6. Tu URL de tienda es: `tu-tienda.myshopify.com` → `SHOPIFY_STORE_URL`

---

### Paso 5 — Elegir proveedor de IA

Claude sigue siendo el proveedor predeterminado:

1. Define `AI_PROVIDER=anthropic`.
2. Crea una clave en [console.anthropic.com](https://console.anthropic.com) y guárdala en `ANTHROPIC_API_KEY`.

Para usar DeepSeek en todos los procesos de IA:

1. Define `AI_PROVIDER=deepseek`.
2. Crea una clave en [platform.deepseek.com](https://platform.deepseek.com) y guárdala en `DEEPSEEK_API_KEY`.
3. Opcionalmente define `DEEPSEEK_MODEL`, `DEEPSEEK_FAST_MODEL`, `DEEPSEEK_SMART_MODEL` o `DEEPSEEK_VISION_MODEL`. Sin overrides se usa `deepseek-flash`.

El proveedor seleccionado se aplica a conversaciones, pedidos, evaluaciones, campañas, reenganche, asistentes administrativos, notificaciones y análisis visual. No hay llamadas directas a un proveedor fuera de la capa común. En el endpoint compatible con Anthropic, DeepSeek recibe `thinking: { type: 'disabled' }`; esto permite exigir la respuesta estructurada de los borradores sin activar razonamiento incompatible con una herramienta obligatoria. Referencia: [compatibilidad oficial](https://api-docs.deepseek.com/guides/anthropic_api/).

Los audios tienen una etapa previa: WhatsApp/Kapso puede entregar la transcripción o el backend puede obtenerla con `AUDIO_TRANSCRIPTION_PROVIDER=openai` y `OPENAI_API_KEY`. Una vez transcrito, el texto siempre continúa por el proveedor elegido en `AI_PROVIDER`. Claude y DeepSeek reciben texto e imágenes, no el audio crudo.

Todas las respuestas generadas pasan por las mismas protecciones de frescura, escalamiento y promesas al equipo, tanto en Kapso como en Evolution y en reintentos. Los mensajes salientes generados por IA guardan proveedor, modelo y versión de prompt para facilitar auditorías sin almacenar claves ni razonamientos internos.

---

### Paso 6 — Iniciar en desarrollo

```bash
# Terminal 1 — Backend
cd backend
npm run dev

# Terminal 2 — Frontend
cd frontend
npm run dev
```

Abrir: [http://localhost:5173](http://localhost:5173)

---

## 🌐 Deploy en Railway (Recomendado)

### Backend

1. Crea una cuenta en [railway.app](https://railway.app)
2. Conecta tu repositorio de GitHub
3. Selecciona la carpeta `backend` como raíz
4. Agrega todas las variables de entorno del `.env.example`
5. Railway te dará una URL pública tipo: `https://tu-app.up.railway.app`
6. Usa esa URL para configurar el webhook de Meta

### Frontend

1. Crea otro servicio en Railway (o usa [Vercel](https://vercel.com))
2. Selecciona la carpeta `frontend`
3. Agrega: `VITE_BACKEND_URL=https://tu-backend.up.railway.app`
4. Build command: `npm run build`
5. Output directory: `dist`

---

## 🐳 Deploy con Docker

```bash
# Copiar archivos .env
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
# Editar los .env con tus valores...

# Construir y levantar
docker-compose up --build -d
```

---

## 📱 Uso del CRM

### Probabilidad de compra

El panel **Más funciones → Evaluación** puede puntuar las conversaciones de un período y priorizarlas por:

- probabilidad de compra dentro de 24 y 48 horas;
- cantidad probable de huevos;
- huevos esperados (`probabilidad × cantidad`);
- señales que explican el cálculo;
- bloqueo conversacional y próxima acción sugerida.

Cada evaluación se guarda por organización, fecha, rango y versión del modelo. Después de 24 y 48 horas el sistema contrasta la estimación con pedidos reales y calcula error Brier para poder recalibrar el modelo. La recomendación describe una estrategia conversacional; cualquier mensaje se redacta desde el historial individual y no desde una plantilla genérica.

Endpoints protegidos para `owner`, `admin` y `supervisor`:

- `GET /api/bot-eval/purchase-probability?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `POST /api/bot-eval/purchase-probability/recalculate` con `{ "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }`

### Panel de conversaciones (izquierda)
- Lista todas las conversaciones ordenadas por último mensaje
- El punto verde/amarillo indica si el agente IA está activo o pausado
- Los números en verde muestran mensajes no leídos

### Ventana de chat (derecha)
- Los mensajes del agente IA se muestran con el icono 🤖 en verde oscuro
- Los mensajes que tú envíes aparecen en azul oscuro con icono 👤

### Toggle IA/Humano
- **Botón "Tomar control"** → Pausa el agente IA, puedes responder tú
- **Botón "Activar IA"** → El agente vuelve a responder automáticamente
- Si el cliente escribe "quiero hablar con una persona" el bot se pausa automáticamente

### Cierre y seguimiento comercial
- Los pedidos iniciados antes de las **12:50** mantienen la opción de despacho del día hasta las **13:00**, sujeta a stock y cupo.
- Desde las 12:50, los pedidos nuevos reciben como alternativa el próximo día de despacho. Si un pedido protegido termina después de las 13:00, se deriva al equipo sin contradecir ni rechazar al cliente.
- Los cierres en curso reciben seguimiento breve a los **5 minutos**; otros interesados, a los **15 minutos**. Se permiten como máximo dos intentos y nunca dos en la misma etapa.
- No se envían seguimientos cuando el cliente ya respondió, pidió no recibir mensajes, tiene un pedido o pago activo, o la conversación está en atención humana.
- Si el cliente indica que ya no necesita o que compró en otro lugar, se le pregunta una sola vez si nos consideraría para una próxima compra. Solo si responde que no se consulta el motivo, y el resultado queda visible en el análisis de campaña.
- La pestaña **Calientes** prioriza pedidos en curso y muestra la vigencia del despacho; **Seguimiento** reúne conversaciones aún recuperables.

### Cobranza y coordinación operativa
- Si un cliente informa que podrá transferir en una fecha futura, el bot registra el compromiso y suspende los cobros automáticos hasta ese día.
- Los pedidos con comprobante pendiente, pago verificado o una nota explícita de "no cobrar" se excluyen de cobranza para evitar duplicados.
- Una fecha de entrega confirmada después de crear el pedido se guarda en el pedido y lo retira de rutas que aún no comenzaron.
- Cuando la ventana de WhatsApp del admin está cerrada, el aviso del CRM permite abrir el chat del negocio con un mensaje preparado para reactivarla.
- La evaluación de calidad procesa conversaciones en paralelo y admite hasta 120 segundos antes de informar timeout.

---

## ⚙️ Personalizar el agente

Puedes modificar las instrucciones del agente en `backend/src/services/ai-agent.js`, en la variable `BASE_SYSTEM_PROMPT`. También puedes agregar instrucciones adicionales desde la API:

```bash
PUT /api/settings
{
  "ai_system_prompt_extra": "Siempre menciona nuestro descuento del 10% para primera compra."
}
```

---

## Rutas públicas

- `/justo-casero`: landing de la marca Justo Casero para vender exclusivamente cajas de huevos café XL y Jumbo. Los pedidos y votos del Radar Casero se abren por WhatsApp y entran al mismo CRM de la organización.
- `justocasero.com`, `www.justocasero.com`, `justocasero.cl` y `www.justocasero.cl`: dominios preparados para mostrar esa landing cuando apunten a este frontend.

---

## 🔧 API Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/conversations` | Lista todas las conversaciones |
| GET | `/api/conversations/:id/messages` | Mensajes de una conversación |
| POST | `/api/conversations/:id/messages` | Enviar mensaje manual |
| PATCH | `/api/conversations/:id/agent-mode` | Cambiar modo (ai/human) |
| GET | `/api/settings` | Configuración del sistema |
| PUT | `/api/settings` | Actualizar configuración |
| POST | `/api/settings/refresh-products` | Refrescar cache Shopify |
| GET | `/api/products` | Lista productos e incluye `favorite_count` para medir favoritos |
| PUT | `/store/:slug/products/:productId/favorite` | Marca o desmarca un producto favorito para un visitante anónimo |
| GET | `/webhook` | Verificación webhook Meta |
| POST | `/webhook` | Recibir mensajes de WhatsApp |

---

## 📝 Notas importantes

- **Número de prueba**: Meta te permite hasta 5 números de prueba gratis. Para producción necesitas aprobar tu número de negocio.
- **Costos de WhatsApp**: Meta cobra por conversación iniciada por el negocio (24h window gratis para responder mensajes iniciados por el cliente).
- **Costo IA**: depende del proveedor y modelo configurados para texto, herramientas e imágenes.
- **Shopify cache**: Los productos se actualizan automáticamente cada hora.

### Redacción individual por Evolution

En Mensajería masiva, el canal Evolution permite indicar el objetivo y las condiciones en lenguaje natural. La IA vigente redacta por cliente con su historial y conversación; preparar borradores no envía mensajes. Cada texto debe revisarse y puede corregirse o excluirse antes de autorizar el lote. La autorización se vincula a los destinatarios y textos exactos, que se guardan en la cola existente. Cambiar un mensaje exige volver a revisarlo. Las campañas detenidas mantienen su estado. Esta función envía texto y no incorpora imágenes.

Las ofertas son personales: se guardan por organización, conversación y producto, y se activan tras un envío aceptado. No cambian el catálogo público. El selector de productos consume la respuesta `{ products: [...] }` y permite reintentar si falla la carga. El vencimiento se edita con fecha y hora de Chile; una fecha sin hora conserva vigencia hasta el cierre de ese día. La cola omite mensajes cuyas ofertas hayan vencido antes de enviarlos.

El inbox y sus contadores muestran conversaciones con un mensaje real. Las conversaciones reservadas para ofertas pendientes permanecen disponibles para la campaña y aparecen automáticamente al guardarse el primer mensaje. El filtro solo afecta la vista del CRM: no borra registros, modifica la cola ni necesita reiniciar el servidor de envíos. También conserva mensajes multimedia sin texto de vista previa.

La revisión permite recuperar textos desde un JSON con `contacts: [{ phone, message }]` para exactamente los contactos seleccionados (máximo 100). Solo recupera los textos y su orden: descarta autorizaciones, precios e identidad importados, exige completar y validar las ofertas y revisar cada mensaje nuevamente. No crea campañas ni envía al importar.

Para estas reglas, ejecutar las pruebas del backend y `npm test` en el frontend. Las regresiones cubren horario de invierno/verano, almacenamiento UTC, ofertas vencidas en cola, carga del catálogo y recuperación sin autorización heredada. Los imports de las pruebas admiten rutas Windows.
