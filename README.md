# 🤖 WhatsApp CRM con Agente IA para Shopify

Un CRM completo de WhatsApp con agente de inteligencia artificial que responde automáticamente a tus clientes usando el catálogo de tu tienda Shopify. Construido con **Claude (Anthropic)**, **Node.js**, **React** y la **API de WhatsApp Business de Meta**.

---

## ✨ Características

- 💬 **UI tipo WhatsApp** — interfaz familiar para gestionar todas las conversaciones
- 🤖 **Agente IA con Claude** — responde preguntas sobre productos, precios y disponibilidad
- ⏸️ **Toggle IA/Humano por conversación** — pausa el bot y toma control cuando quieras
- 🛍️ **Integración Shopify** — el agente conoce tu catálogo completo en tiempo real
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
│  Anthropic API  │ ◄────────────────►│                      │
│  (Claude)       │                   └──────────────────────┘
└─────────────────┘
```

---

## 🚀 Instalación y Setup

### Prerequisitos

- Node.js 18+
- Cuenta de Meta for Developers
- Cuenta de Anthropic (Claude API)
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
ANTHROPIC_API_KEY=sk-ant-...
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

### Paso 5 — Obtener API Key de Anthropic

1. Ve a [console.anthropic.com](https://console.anthropic.com)
2. Crea una API Key → `ANTHROPIC_API_KEY`

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
| GET | `/webhook` | Verificación webhook Meta |
| POST | `/webhook` | Recibir mensajes de WhatsApp |

---

## 📝 Notas importantes

- **Número de prueba**: Meta te permite hasta 5 números de prueba gratis. Para producción necesitas aprobar tu número de negocio.
- **Costos de WhatsApp**: Meta cobra por conversación iniciada por el negocio (24h window gratis para responder mensajes iniciados por el cliente).
- **Costo Claude**: Aproximadamente $0.003 por mensaje respondido con claude-sonnet-4-6.
- **Shopify cache**: Los productos se actualizan automáticamente cada hora.
