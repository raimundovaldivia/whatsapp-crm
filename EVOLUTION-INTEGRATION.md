# Canal de WhatsApp con Evolution API

Evolution API se conecta con **nuestra aplicación**. Shopify es otra conexión externa y no participa en el transporte de mensajes.

```text
Shopify ─────────────┐
                     │
WhatsApp ← Evolution ├── Nuestra app ── IA, ventas, pedidos y atención humana
                     │
Otras conexiones ────┘
```

## Qué quedó integrado

- Varios números de WhatsApp por organización.
- Una instancia de Evolution por número.
- QR de vinculación desde Ajustes → WhatsApp.
- Un número predeterminado para iniciar conversaciones.
- Selección del número al crear una conversación nueva.
- Cada conversación conserva el número por el que entró.
- Mensajes entrantes enviados al pipeline de IA, ventas y pedidos de la app.
- Derivación a coordinación o atención humana usando el comportamiento existente.
- Mensajes manuales, seguimientos, cobros y avisos de pedidos enviados por el canal asociado.
- Webhook separado y autenticado con un token aleatorio por canal.

## Levantar Evolution gratuitamente

El software es gratuito. Necesita una máquina encendida permanentemente. Desde la carpeta del proyecto:

1. Define `EVOLUTION_API_KEY`, `EVOLUTION_DB_PASSWORD` y, para un servidor público, `EVOLUTION_PUBLIC_URL`.
2. Levanta `docker-compose.evolution.yml`.
3. Publica Evolution detrás de HTTPS si la app se encuentra en Railway u otro servidor externo.
4. En la app, abre Ajustes → WhatsApp → **Números libres · Evolution API**.
5. Ingresa la URL pública, API Key, nombre de instancia y nombre descriptivo del número.
6. Escanea el QR desde WhatsApp → Dispositivos vinculados.

La URL pública del backend de la app debe estar configurada en `CRM_PUBLIC_URL`, `PUBLIC_URL` o `BACKEND_URL`. La app registra automáticamente un webhook diferente para cada número.

## Enrutamiento con varios números

- Una respuesta siempre sale por el canal guardado en la conversación.
- Un chat nuevo usa el canal seleccionado en el formulario.
- Si no se selecciona uno, se usa el canal marcado como predeterminado.
- Las conversaciones antiguas conservan Meta, Kapso o Twilio si fueron creadas antes de habilitar Evolution.
- El mismo cliente puede mantener conversaciones distintas con varios números sin mezclar historiales.

## Consideraciones operativas

Evolution utiliza una conexión no oficial basada en WhatsApp Web. No necesita templates ni aplica técnicamente la ventana de 24 horas, pero WhatsApp puede desconectar o bloquear números ante automatización abusiva. Usa consentimiento, límites de frecuencia y evita campañas masivas repetitivas.
