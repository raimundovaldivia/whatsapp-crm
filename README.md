# 🤖 Aplicación comercial con WhatsApp y agentes de IA

Una aplicación comercial que centraliza WhatsApp, atención humana, agentes de inteligencia artificial, ventas y pedidos. Puede usar Shopify como conexión de catálogo y operaciones, y admite Meta, Kapso, Twilio y varios números mediante Evolution API.

---

## ✨ Características

- 💬 **UI tipo WhatsApp** — interfaz familiar para gestionar todas las conversaciones
- ✍️ **Redacción individual en Evolution** — escribe una instrucción comercial, prepara borradores con las compras y conversaciones de cada cliente, corrige o excluye destinatarios y autoriza los textos exactos antes de enviarlos. El texto común manual sigue disponible como opción explícita.
- 🤖 **Agentes IA intercambiables** — Claude o DeepSeek cubren conversación, análisis, campañas, asistentes e imágenes
- ⏸️ **Toggle IA/Humano por conversación** — pausa el bot y toma control cuando quieras
- 🛍️ **Conexión Shopify** — aporta catálogo, clientes y pedidos cuando está habilitada
- 🔔 **Tiempo real** — los mensajes aparecen instantáneamente con Socket.io
- 📦 **Cache de productos** — evita llamadas excesivas a la API de Shopify
- 📊 **Contador de no leídos** — igual que WhatsApp
- 🔍 **Buscador** — filtra conversaciones por nombre, teléfono o mensaje
- 🚚 **Seguimiento de reparto** — al iniciar una ruta, el cliente recibe un enlace temporal para ver la ubicación del repartidor
- 🧾 **Identificación de pedidos** — los pedidos creados en el CRM se muestran como `#DR-<número>`; los números propios de Shopify se conservan
- 💸 **Cobranza con compromisos** — comprobantes, pedidos marcados “no cobrar” y promesas con fecha detienen recordatorios duplicados; el seguimiento se reanuda en la fecha acordada
- 📅 **Confirmación de reparto** — una fecha indicada después de confirmar el pedido se guarda en el pedido y actualiza las rutas aún no iniciadas
- 🔔 **Canal del administrador** — las alertas se conservan en cola y el aviso del CRM abre WhatsApp para reactivar la ventana antes de reenviarlas
- 📈 **Evaluación del bot** — la revisión cualitativa procesa la muestra con concurrencia limitada y admite evaluaciones de hasta dos minutos desde la interfaz
- 🤝 **Programa de referidos** — $2.000 para cada nuevo comprador y $2.000 para quien lo refiere, bonos personales de un uso, bandeja al completar cinco compras válidas, reglas por etapas y automatizaciones gestionadas dentro del CRM

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
- La calificación comercial se muestra con puntaje y razones. Una consulta de precio queda en **Explorando**; **Muy caliente** exige intención explícita de compra, producto y cantidad o datos concretos.
- El estado operativo del bot (`pipeline_state`) y la temperatura comercial son independientes. Quitar un contacto de Hot no altera el flujo de su conversación.
- **Evaluar 200** guarda una fotografía de la clasificación vigente y la propuesta nueva sin modificar conversaciones. Cada ejecución recibe un ID auditable; solo un owner o admin puede aplicar después esa evaluación, y las conversaciones que cambiaron desde la fotografía se omiten.

### Ventana de chat (derecha)
- Los mensajes del agente IA se muestran con el icono 🤖 en verde oscuro
- Los mensajes que tú envíes aparecen en azul oscuro con icono 👤

### Toggle IA/Humano
- **Botón "Tomar control"** → Pausa el agente IA, puedes responder tú
- **Botón "Activar IA"** → El agente vuelve a responder automáticamente
- Si el cliente escribe "quiero hablar con una persona" el bot se pausa automáticamente
- Los reclamos por alimento en mal estado siempre se escalan. Un producto distinto recién entregado recibe primero una oferta automática de cambio; si el cliente acepta, el caso pasa al equipo con el pedido identificado.
- Las dudas por tamaño de huevos se responden por peso según NCh 1372 (Grande 54–61 g, Extra Grande 61–68 g y Especial sobre 68 g) y se ofrece revisar evidencia si el calibre no corresponde.
- Una tercera persona que pregunta por el despacho de una clienta puede obtener el estado general usando número de pedido o teléfono, sin exponer otros datos personales.
- A los clientes nuevos se les solicita una sola opinión, 24 horas después de su primera entrega. Se cruzan pedidos CRM y Shopify por teléfono para no preguntar dos veces. Las notas 1–3 y comentarios negativos se derivan a postventa; 4–5 reciben agradecimiento automático.
- El seguimiento de opinión excluye bajas, conversaciones atendidas por humanos, entregas con resolución pendiente y cambios/devoluciones abiertos. Las respuestas se consultan por `GET /api/customer-feedback` con aislamiento por organización y roles de supervisión.
- El seguimiento conserva el canal de la conversación asociada al pedido: Evolution envía por Evolution. En Meta/Kapso se usa texto normal mientras la ventana de 24 horas esté abierta y el template Utility aprobado solamente cuando esté cerrada; nunca se cambia a Evolution por el solo hecho de que la ventana Meta haya vencido.

### Seguimiento de despacho

- Requiere `CRM_PUBLIC_URL` (o `PUBLIC_URL`/`BACKEND_URL`) apuntando al backend público.
- El enlace usa un token aleatorio; la base guarda solo su hash. No muestra nombre, teléfono, dirección ni identidad del repartidor.
- La ubicación se publica únicamente para una ruta `in_progress` y deja de estar disponible al cerrar esa parada, terminar la ruta, revocar el enlace o después de 12 horas.
- En Meta/Twilio con la ventana de 24 horas cerrada, el template Utility aprobado debe incorporar el enlace como variable o botón; un template antiguo sin esa variable seguirá avisando la salida, pero no podrá mostrar el enlace.

Para pedir la opinión fuera de la ventana de 24 horas, asigna en **Configuración → Templates** un template Utility para **Opinión primera compra** con `{{1}}` Nombre y `{{2}}` Pedido. Sin ese template el proceso reintenta y no envía texto libre fuera de la ventana permitida.

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

Selecciona la tienda y abre **Configuración de la cuenta → IA & Bot**. Guarda sus especificaciones técnicas, nombres comerciales y modalidad de venta en **Contexto de la tienda**; configura el tono y las instrucciones en **Personalidad del agente**. Estas reglas pertenecen al setup de esa organización, no al código compartido del bot.

El pipeline de WhatsApp y el bot social leen `store_context` y `ai_system_prompt_extra` de la organización activa. No copies reglas de una marca al contexto de otra. Los ajustes se guardan mediante las rutas existentes `/api/settings/store-context` y `/api/settings`, protegidas para owner/admin.

### Cambiar de tienda sin cerrar sesión

En escritorio, abre el menú de cuenta de la esquina superior izquierda y usa **Tienda activa**. En móvil, el selector está en **Más**. Cada tienda mantiene su propio catálogo, conversaciones, bot, módulos y permisos. Guarda los formularios pendientes antes de cambiar: la aplicación vuelve a cargar los datos de la tienda elegida.

El login autoriza únicamente las cuentas del mismo correo cuya contraseña se verificó. Para una sesión anterior o una tienda con otra contraseña, usa **Verificar otra tienda de mi cuenta** una vez por sesión; la contraseña no se guarda. Compartir correo por sí solo nunca concede acceso.

`GET /api/auth/organizations` lista los accesos vigentes de la sesión; `POST /api/auth/verify-organizations` verifica las credenciales adicionales y `POST /api/auth/switch-organization` recibe un `organizationId` entero. El servidor revalida usuario, organización, correo, rol y versión de autorización antes de emitir el token de destino, sin ampliar la fecha de vencimiento original. No necesita migraciones y conserva compatibilidad con tokens antiguos y clientes móviles.

Cambiar de tienda recarga también las otras pestañas del mismo origen. Las solicitudes y respuestas de una sesión anterior se descartan para evitar que formularios, cachés o conexiones activas mezclen tiendas. La configuración del bot se guarda después de comprobar el nombre de la tienda activa.

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
| POST | `/api/conversations/scan-hot-leads` | Evaluar hasta 200 conversaciones y guardar antes/propuesta sin aplicar |
| GET | `/api/conversations/lead-qualification-runs/:runId` | Consultar el detalle auditable de una evaluación |
| POST | `/api/conversations/lead-qualification-runs/:runId/apply` | Aplicar una evaluación guardada omitiendo conversaciones que cambiaron |
| PATCH | `/api/conversations/:id/hot-lead-exclusion` | Excluir o reincorporar una conversación de Hot sin cambiar el pipeline |
| GET | `/api/referrals` | Métricas, códigos y seguimiento del programa de referidos |
| POST | `/api/referrals/codes` | Preparar código e invitación de un cliente con compra válida |
| POST | `/api/referrals/claims` | Registrar manualmente a una persona referida |
| PATCH | `/api/referrals/:id/status` | Rechazar un referido con motivo; no concede premios manuales |
| GET | `/api/referrals/program` | Reglas, plantillas de programa, bonos, mensajes, productos y auditoría |
| PUT | `/api/referrals/settings` | Guardar reglas validadas y estado del programa |
| POST | `/api/referrals/command` | Interpretar instrucciones y aplicar una propuesta revisada |
| POST | `/api/referrals/prepare` | Preparar hasta 100 invitaciones para compradores elegibles, sin enviar |
| POST | `/api/referrals/reconcile` | Verificar compras y emitir beneficios únicos |
| POST | `/api/referrals/messages/approve` | Aprobar mensajes concretos para envío por el proceso automático |
| POST | `/api/referrals/rewards/:id/preview` | Revisar el canje de un bono en un pedido |
| POST | `/api/referrals/rewards/:id/redeem` | Consumir un bono y actualizar pedido/stock atómicamente |
| GET | `/referido/:organizacion/:codigo` | Abrir WhatsApp con el código para atribución automática |
| GET | `/api/settings` | Configuración del sistema |
| PUT | `/api/settings` | Actualizar configuración |
| POST | `/api/settings/refresh-products` | Refrescar cache Shopify |
| GET | `/api/products` | Lista productos e incluye `favorite_count` para medir favoritos |
| PUT | `/store/:slug/products/:productId/favorite` | Marca o desmarca un producto favorito para un visitante anónimo |
| GET | `/webhook` | Verificación webhook Meta |
| POST | `/webhook` | Recibir mensajes de WhatsApp |

---

## 📝 Notas importantes

### Operar referidos

En **Referidos → Programa**, elegir un programa (cinco amigos, doble beneficio o premios por etapas), seleccionar la bandeja del catálogo y guardar. Los valores iniciales son $2.000 para ambas personas, una bandeja al llegar a cinco compradores, 30 días de vigencia y sin compra mínima. La bandeja se agrega al próximo pedido. El programa y los envíos automáticos empiezan desactivados; cambiar el código fuente no activa campañas existentes.

El comprador invitado recibe un bono de bienvenida único. Quien invita recibe un bono de $2.000 por cada nuevo cliente cuya compra esté pagada y entregada, más los premios por metas. Solo cuentan personas distintas según su teléfono normalizado. No se admiten autorreferencias ni compradores que ya compraron antes de presentar el código. Los pedidos en borrador no cuentan como compras. Cada meta se premia una sola vez; no hay una nueva bandeja automática al llegar a diez salvo que exista esa segunda meta explícita.

El código `REF-…` puede compartirse con distintas personas. Cada `BONO-…` es personal, de un solo uso, con vencimiento y un pedido de canje registrado. Un pedido admite un bono de descuento y un regalo; no acumula dos del mismo tipo. El monto del pedido debe superar el descuento. Cancelar el pedido no recupera el bono. Devoluciones, pagos revertidos y cancelaciones invalidan conversiones y beneficios todavía disponibles; los ya consumidos quedan en auditoría y no se cobran automáticamente al cliente.

**Lenguaje natural:** «Da 2000 para ambos y una bandeja a los 5 compradores», «Prepara códigos para mis compradores», «Revisa compras», «Recuerda a los clientes a los 7 días», «Pausa referidos», «Activa referidos». Primero se muestra la propuesta y luego se aplica. Las instrucciones no reconocidas se rechazan sin cambiar reglas. También se pueden editar importes y hasta cinco metas directamente.

**Automatizaciones:** revisión de compras cada minuto; invitación después de una entrega pagada (24 horas configurables); aviso del bono; un recordatorio por bono después de siete días configurables. Sin envío automático, quedan borradores. En **Mensajes**, revisar destinatarios y texto y aprobar los seleccionados. El envío utiliza la integración existente, exclusiones y horario 09:00–21:00 de America/Santiago. Si la ventana de WhatsApp está cerrada, se necesita una plantilla MARKETING aprobada, asignada en Mensajería al caso «Invitaciones y beneficios de referidos», con una variable para el texto completo. Un envío de resultado incierto se conserva para revisión y nunca se reintenta por sí solo.

**Canje:** en **Bonos y regalos**, elegir un bono, un pedido pendiente del mismo cliente y revisar el total antes de confirmar. Se comprueba stock para la bandeja. El canje admite pedidos independientes del CRM antes del pago y antes de enviarlos a reparto. Los pedidos con orden/borrador/enlace de pago Shopify se rechazan para evitar que el descuento quede solo en la copia local. El código se atribuye desde WhatsApp o desde el registro manual del CRM; no añade un campo de cupón al checkout de Shopify ni al de la tienda pública.

**Compatibilidad y puesta en marcha:** `referrals.sql` permanece intacto; `referrals-rewards-v2.sql` se integra a la secuencia existente de arranque. No ejecutar setup, migraciones remotas o despliegues sin solicitud explícita. Los registros manuales antiguos no generan dinero retroactivamente. Un código nuevo conserva sus condiciones aunque luego se edite el programa. La identidad se controla por teléfono, no por identidad civil: varios números de una misma persona requieren revisión del equipo.

**Verificación local:** `node --test --test-concurrency=4 test/*.test.cjs` desde backend y `npm test` / `npm run build` desde frontend. La suite de referidos usa PGlite y WhatsApp simulado. No acredita entregas reales ni un despliegue en producción.

- **Número de prueba**: Meta te permite hasta 5 números de prueba gratis. Para producción necesitas aprobar tu número de negocio.
- **Costos de WhatsApp**: Meta cobra por conversación iniciada por el negocio (24h window gratis para responder mensajes iniciados por el cliente).
- **Costo IA**: depende del proveedor y modelo configurados para texto, herramientas e imágenes.
- **Shopify cache**: Los productos se actualizan automáticamente cada hora.

### Redacción individual por Evolution

En Mensajería masiva, el canal Evolution permite indicar el objetivo y las condiciones en lenguaje natural para hasta 5.000 clientes. La IA vigente redacta por cliente con su historial y conversación; preparar borradores no envía mensajes. Cada texto puede corregirse o excluirse antes de autorizar el lote. Editar un mensaje en revisión detallada lo marca como revisado; también existe una acción para marcar todos. La autorización se vincula mediante una huella a los destinatarios, textos y ofertas exactos, que se guardan en la cola existente. Las campañas detenidas mantienen su estado. Esta función envía texto y no incorpora imágenes.

La selección excluye bajas, rechazos explícitos, reclamos recientes y contactos comerciales sin respuesta durante los últimos siete días. Una campaña antigua sin respuesta no equivale a una baja: queda disponible para un borrador prudente y revisión humana.

Las ofertas son personales: se guardan por organización, conversación y producto, y se activan tras un envío aceptado. No cambian el catálogo público. El selector de productos consume la respuesta `{ products: [...] }` y permite reintentar si falla la carga. El vencimiento se edita con fecha y hora de Chile; una fecha sin hora conserva vigencia hasta el cierre de ese día. La cola omite mensajes cuyas ofertas hayan vencido antes de enviarlos.

El inbox y sus contadores muestran conversaciones con un mensaje real. Las conversaciones reservadas para ofertas pendientes permanecen disponibles para la campaña y aparecen automáticamente al guardarse el primer mensaje. El filtro solo afecta la vista del CRM: no borra registros, modifica la cola ni necesita reiniciar el servidor de envíos. También conserva mensajes multimedia sin texto de vista previa.

La revisión permite recuperar textos desde un JSON con `contacts: [{ phone, message }]` para exactamente los contactos seleccionados (máximo 100). Solo recupera los textos y su orden: descarta autorizaciones, precios e identidad importados, exige completar y validar las ofertas y revisar cada mensaje nuevamente. No crea campañas ni envía al importar.

Para estas reglas, ejecutar las pruebas del backend y `npm test` en el frontend. Las regresiones cubren horario de invierno/verano, almacenamiento UTC, ofertas vencidas en cola, carga del catálogo y recuperación sin autorización heredada. Los imports de las pruebas admiten rutas Windows.

### Compatibilidad y verificación de la integración

Las ofertas automáticas de recuperación conservan `personal_offers`; las ofertas por producto de campañas utilizan `campaign_offers`. Los datos, restricciones e integraciones de ambas tablas se conservan. Los esquemas SQL vigentes de `main` no se reemplazan por las versiones anteriores de la rama; referidos agrega sus extensiones incrementales existentes.

`backend/test/schema-compatibility.test.cjs` comprueba la repetición del setup con ofertas guardadas, la coexistencia de ambos esquemas y el aislamiento entre empresas. `backend/test/delivery-finish-route.test.cjs` comprueba el cierre manual, roles reales, identificadores inválidos, aislamiento, repetición y rollback. Son pruebas locales con PostgreSQL embebido; no ejecutan migraciones ni envíos en producción.

El frontend ejecuta 13 pruebas de catálogo, canales del chat, ofertas e inbox. El workflow de GitHub las incluye antes de compilar. Para la app de repartidores, la comprobación local de CI es `EXPO_OFFLINE=1 npx expo export --platform android --max-workers 2 --output-dir dist-audit`; no crea ni publica un APK.
