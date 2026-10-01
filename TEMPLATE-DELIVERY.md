# Estados de plantillas de WhatsApp

La aceptación HTTP de una plantilla no confirma su envío ni su entrega. Los nuevos mensajes de plantilla se guardan como `pending`; los recibos del proveedor confirman `sent`, `delivered`, `read` o `failed`. El chat muestra los fallidos sin check y conserva código y detalle en `messages.delivery_error`. Un recibo atrasado de envío no borra un fallo ni retrocede una entrega.

Kapso debe suscribir `whatsapp.message.sent`, `whatsapp.message.delivered`, `whatsapp.message.read` y `whatsapp.message.failed`, además de `whatsapp.message.received`. Los errores v2 están en `message.kapso.statuses[].errors`; también se admite el error directo del mensaje y el formato de Meta. Documentación: https://docs.kapso.ai/docs/platform/webhooks/message-events

Si no llegan recibos, la plantilla permanece pendiente; no se considera entregada ni se reenvía automáticamente. Los contadores de campañas reflejan solicitudes aceptadas, no confirmaciones de entrega. El código 131042 muestra una indicación de revisar facturación/elegibilidad; no demuestra por sí mismo una deuda específica.

La migración de inicio agrega `delivery_error` y habilita `pending` conservando los estados existentes. Los mensajes históricos no se reclasifican por suposición: el detalle descartado antes requiere consultar el historial del proveedor o eventos almacenados. No se enviaron mensajes reales para verificar el cambio.

## Automatizaciones y ventana de 24 horas

Configuración → Templates → Automatizaciones centraliza la selección del template aprobado para tres eventos: pedido en camino, cobro por transferencia y pedido agendado. Cada evento acepta únicamente templates aprobados de categoría `UTILITY`, con las variables exactas que requiere el flujo.

La selección es un respaldo, no el canal principal: si el cliente escribió dentro de las últimas 24 horas, el CRM envía texto libre. Solo usa el template cuando la ventana ya está cerrada o cuando el proveedor rechaza el texto porque expiró mientras se intentaba enviar. Las campañas y promociones permanecen fuera de estas asignaciones porque corresponden a `MARKETING`.

Validación: `node --test test/template-status.test.cjs`, suite backend y compilación frontend. Los tests cubren errores inmediatos, respuesta sin ID, recibos fallidos, persistencia, aislamiento por organización y eventos atrasados.

## Cobranza

`charge_requested_at` registra un intento, no entrega ni pago. `charge_message_id` enlaza el pedido con el mensaje del proveedor; despacho consulta ese mensaje. Solo `delivered/read` cuentan como avisos entregados. `pending/sent` esperan confirmación, `failed` permite reintento inmediato y un intento histórico sin evidencia queda `unknown`, bloqueado para reenvío masivo. El pago sigue dependiendo del comprobante, nunca del aviso.

La migración recupera enlaces históricos solo con recibos fallidos/entregados/leídos, misma organización y teléfono, mensaje de cobranza dentro de los 30 segundos anteriores al intento y coincidencia única en ambos sentidos. No atribuye mensajes ambiguos ni infiere entrega desde `sent`. Si el proveedor no entregó recibos, hace falta consultar su historial; no se reenvían los desconocidos por suposición. El envío bloquea concurrentemente el pedido y vuelve a leer su estado antes de llamar al proveedor.

En Despachos, **Verificar envíos** consulta en Kapso los IDs de los avisos sin confirmar del día y actualiza sus estados. No envía mensajes. Usa las credenciales del servidor, por organización, y solo enlaza históricos con correspondencia única. Tras verificar, **Cobrar** permite seleccionar los fallidos confirmados o los pedidos sin intento previo; los entregados y ambiguos quedan fuera. Debe estar regularizado el saldo antes de reintentar. Las consultas fallidas o sin registro permanecen sin verificar.
