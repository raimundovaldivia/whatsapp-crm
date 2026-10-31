# Revisión de conversaciones sin envíos

En Mensajería → **Revisar chats**, pega hasta 500 teléfonos chilenos y un objetivo. La revisión queda guardada por organización y procesa tres pasos de clientes en paralelo desde la pantalla. Puedes pausar, cerrar y continuar; una petición interrumpida se recupera después de cinco minutos. No se ejecuta un envío ni una programación, ni se activa un cupón.

## Evidencia y cobertura

- Une los teléfonos históricos usando el resolvedor de identidad existente, siempre dentro de la organización. Incluye canales comerciales; excluye canales personales asignados a trabajadores.
- Consulta hasta 10.000 mensajes guardados por identidad, con el total real. Si hay más, la ficha se marca incompleta y no propone un mensaje utilizable.
- Divide los textos por bloques sin recortarlos silenciosamente. Verifica que cada cita exista exactamente en un mensaje entrante. Los mensajes del vendedor no prueban preferencias del cliente.
- Los audios ya transcritos se leen. Imágenes, documentos, videos o audios sin transcripción se marcan como pendientes de revisión humana; el análisis no descarga ni reenvía esos archivos.
- El historial disponible es el guardado en CRM, no una garantía de haber sincronizado todo WhatsApp.
- Cada borrador conserva una huella de mensajes, compras, contactos, campañas, catálogo y pedidos agendados. Al abrir una ficha y cada 30 segundos se comprueba de nuevo; si cambió, se retira el mensaje y se pide reanalizar. Cambiar el día comercial también invalida el borrador.

## Reglas de esta revisión

Las exclusiones se ejecutan en el servidor y no pueden relajarse escribiendo una instrucción: empresas, baja comercial, rechazo vigente en la semana, reclamo sin resolución, falta de mensajes entrantes, pedido futuro pendiente, campaña sin respuesta en siete días y cualquier pedido creado desde el lunes de la semana de America/Santiago. Esta última regla incluye pendientes y cancelados para respetar la exclusión comercial solicitada. El contador de compras, en cambio, utiliza el libro de pedidos pagados/entregados deduplicado.

Los resultados distinguen borrador, pausa, exclusión y revisión manual. La prioridad es cualitativa, sin porcentaje de compra. La pantalla de evaluación existente etiqueta sus puntajes como reglas sin calibrar; el acierto de fecha de recompra tampoco se presenta como probabilidad de compra hoy.

## Oferta exclusiva

Después de revisar la evidencia se puede preparar una propuesta para un teléfono. Requiere precio menor al catálogo, fecha futura, cantidad máxima, stock de catálogo suficiente, costo configurado y margen bruto mínimo. El margen se calcula como `(precio - costo) / precio`. La propuesta incluye la restricción explícita al teléfono, vencimiento y no acumulación. Queda dentro de la revisión con `active: false`; no se inserta en `campaign_offers`, no se canjea y no se conecta a la cola de envíos. La disponibilidad física y los costos adicionales deben confirmarse comercialmente.

## Datos y acceso

Las dos tablas `conversation_review_runs` y `conversation_review_contacts` se crean de forma aditiva al primer acceso, compatible con `SKIP_DATABASE_SETUP=1`. Todas las operaciones de datos están limitadas por `organization_id`. La ruta se monta bajo la autenticación de reenganche, roles owner/admin/supervisor y acceso contratado a Marketing. No se escriben datos personales en el repositorio.

El archivo exportado es un informe interno, no una lista compatible con el envío. Siempre contiene `reviewOnly: true`, `sendAllowed: false` y canal previsto Evolution. No existe botón, endpoint de autorización ni transporte de WhatsApp en este módulo.

## Validación

`node --test test/conversation-review.test.cjs` cubre calendario de Chile, compras pendientes/canceladas, preferencias negativas, rechazos y bajas antiguas, textos largos, citas inventadas, adjuntos, aislamiento por tienda, identidad histórica, exclusión de canales personales, reanudación e invalidación. Ejecutar además `npm test` en backend/frontend y `npm run build` en frontend.
