# Ventas del día: primera versión

## Objetivo

Consultar en Estadísticas el diagnóstico diario sin depender de Shopify. El CRM es la fuente de pedidos, conversaciones y comprobantes. Esta versión no cambia sincronizaciones, catálogo, webhooks ni credenciales de Shopify; no publica cambios en Railway.

## Contrato de lectura

`GET /api/dashboard/daily-sales?from=YYYY-MM-DD&to=YYYY-MM-DD`

Requiere sesión de owner/admin y toma la organización exclusivamente de esa sesión. Lectura consistente en una transacción `REPEATABLE READ READ ONLY`; sin llamadas a Shopify, proveedores de IA ni envío de mensajes. El período máximo es 31 días y no admite fechas futuras. Las fechas de negocio usan America/Santiago, incluidos cambios de horario. Las columnas TIMESTAMP existentes se interpretan como UTC.

- **Consultas**: personas con al menos un mensaje entrante en las fechas seleccionadas. Se unifican teléfonos equivalentes entre canales; identidades sin teléfono se mantienen separadas. La tasa puede incluir compradores recurrentes: no representa exclusivamente adquisición.
- **Conversión de consultas**: personas de ese grupo con pedido CRM creado desde su primera consulta del período hasta la actualización. Puede cambiar cuando compren después. Un pedido anterior aún en curso se clasifica como atención operativa, sin inventar una conversión ni sugerir una venta duplicada.
- **Pedidos creados**: pedidos CRM creados en el período, excluyendo borradores y cancelaciones. Valor de pedidos no significa dinero cobrado.
- **Cobrado**: efectivo registrado en entrega, pagos marcados pagados y comprobantes verificados; imágenes pendientes/preverificadas y elegir transferencia no confirman el pago. Pagos parciales y comprobantes con la misma referencia o movimiento se limitan al total del pedido. Sin referencia/movimiento, varios comprobantes no se suman como transferencias independientes.
- **Fecha del cobro**: se usa payment_marked_at o bank_verified_at según la evidencia. Los pagos confirmados sin fecha no se asignan al día de creación del pedido; aparecen advertidos por separado. Es la fecha de registro/confirmación disponible, no necesariamente la fecha económica del movimiento bancario.
- **Saldo pendiente y entregas pendientes**: situación actual de todos los pedidos vigentes, sin limitar al período de creación. Un pago no es prueba de entrega. Los saldos reducen abonos confirmados; no incorporan un libro de devoluciones/reembolsos.

## Origen y atribución

El origen se reconstruye a partir del primer mensaje entrante disponible entre los canales de la persona. Se considera adquisición desde anuncio si existe una atribución a 30 minutos o menos de ese primer mensaje; si falta evidencia se informa «Directo / no identificado», sin asumir que fue orgánico. Se conserva el historial existente; no se escriben campos nuevos de adquisición.

Por cada pedido del período se selecciona el último anuncio evidenciado dentro de los siete días anteriores. La ventana de siete días es una decisión inicial explícita y visible; no indica causalidad ni se asignan todas las recompras al primer anuncio. Sin toque reciente identificado, el pedido queda sin campaña reciente. Recompra exige otro pedido CRM previo, no un pedido histórico de Shopify. Un comprador puede aparecer en varias filas de campañas; el total se deduplica por separado.

## Oportunidades

Prioriza atención humana y datos incompletos. Muestra motivo observado, confirmado manualmente o inferido por separado. El silencio después de una oferta no confirma una objeción de precio. Las bajas y negativas indican no contactar. Abrir un chat no envía mensajes ni aplica seguimientos.

## Límites y siguientes entregas

- La pantalla se actualiza cada minuto mientras está visible y permite recarga manual. No ejecuta procesos de cierre en segundo plano.
- Las cifras históricas se recalculan con los estados vigentes. **No son cierres diarios inmutables**; cancelaciones y cambios de evidencia pueden alterar los días anteriores.
- No hay todavía un libro de pagos/reembolsos que permita reconstruir todos los movimientos históricos. Las fechas ausentes se muestran, no se inventan.
- No se cambia la importación de pedidos Shopify en esta entrega. La desactivación de esa importación debe configurarse como capacidad de integración por organización, sin cortar catálogo ni afectar otras empresas.
- Los paneles previos de Campañas, Pedidos y Dashboard conservan sus cálculos anteriores. La unificación de esos consumidores y los resultados por seguimiento requieren una entrega posterior; el panel nuevo no afirma que esas cifras ya coincidan.
- La consulta procesa el historial de la organización en el servidor. Antes de escalar a historiales grandes, medir tiempos con datos representativos y sustituir lecturas completas por agregados/indexación, manteniendo las mismas pruebas.

## Validación

Pruebas con PostgreSQL embebido sin tablas Shopify verifican consultas, límites de Chile, lectura sin escrituras y separación entre organizaciones. Pruebas de reglas cubren conversión posterior, recompra/atribución, pagos parciales, comprobantes duplicados, exclusiones y consultas operativas. Frontend conserva el acceso al chat y prueba la corrección de Seguimiento que causaba `HOT_STATES is not defined`.
