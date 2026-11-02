# Cierre de pedidos del bot

El agente de ventas y el simulador reciben en cada turno el estado vigente de
`bot_sales_enabled`, leído para la organización activa. Este dato prevalece
sobre mensajes anteriores sobre una pausa: reactivar ventas no requiere borrar
la conversación. Los controles de catálogo y confirmación siguen aplicándose.
Además, antes de enviar una afirmación de ventas pausadas se vuelve a consultar
el permiso vigente. Si el modelo repite esa pausa cuando la tienda ya habilitó
ventas, se corrige únicamente ese aviso y se conserva la información comercial
restante. Una pausa real, falta de stock o datos incompletos siguen bloqueando
el cierre según sus controles habituales.

La web de Justo Casero muestra los formatos Extra de 180 y Súper Extra de 100.
Consulta precios y disponibilidad por SKU en el catálogo público de su propia
tienda. Si no puede cargarlo, solicita consultar por WhatsApp sin inventar precio
o stock. El número de respaldo también pertenece a Justo Casero, incluido el
primer render anterior a recibir la configuración. Cambiar un precio en el CRM
no requiere modificar el código de la web. La opinión sobre precios usa una
nueva clave local para no reutilizar votos de los antiguos formatos XL/Jumbo.

WhatsApp y el simulador leen el mismo catálogo (`bot-catalog`). Una tienda con
`catalog_source=local` nunca recupera productos de Shopify si su catálogo local
está vacío. Las condiciones comerciales de `delivery_info` están disponibles
para Ventas con IA aunque no tenga contratado el módulo logístico.

El cierre valida catálogo, precio positivo y stock conocido suficiente antes de
mostrar el resumen. Un producto retirado no puede reactivarse por un resumen del
historial. Las promociones vigentes siguen calculándose por el flujo existente;
si cambian productos, importes o datos de entrega se pide revisar otra vez.

La confirmación exige una afirmación completa del cliente, los datos requeridos
y el resumen efectivamente enviado. `ORDEN_CONFIRMADA` y las afirmaciones del
modelo no autorizan una compra. El número del pedido se entrega después de que
la base de datos lo guarda, conservando los controles de duplicados existentes.

Una afirmación completa sobre un resumen ya revisado conserva sus datos: no
vuelve a extraerlos del historial con el modelo. Las correcciones o condiciones
junto al «sí» siguen procesándose y requieren revisar el nuevo resumen. También
se reconoce «Sí, todo correcto. Confirmo el pedido de prueba» como una afirmación
completa; añadir cambios o condiciones impide el cierre directo.

También se reconocen «Todo bien», «Está correcto», «Sí correcto» y «Sí, necesito
me lo envíen», incluso con un agradecimiento en una segunda línea. La frase
completa debe ser afirmativa: preguntas, condiciones, cambios de fecha o producto
y la aprobación únicamente de una dirección no autorizan crear el pedido.

Una consulta aislada sobre transferencia conserva el borrador revisado y recibe
una respuesta breve cuando la tienda tiene instrucciones de pago configuradas
en `payment_info` o `charge_settings.bankDetails`. Sin esa configuración se deriva
al equipo sin inventar datos. Preguntar por pago no confirma ni acredita un pago.
Un agradecimiento recibe como máximo una indicación breve para confirmar; una
consulta no resuelta o un reclamo por mensajes repetidos pasa a `coordinating`
con el borrador conservado. No se vuelve a enviar el resumen completo sin cambios.

Las dos aclaraciones breves del sistema conservan la revisión únicamente si el
historial contiene el resumen enviado y el pedido sigue igual. Cualquier otra
intervención saliente invalida ese contexto. Precio, stock, cambios de datos,
fallos de escritura y bloqueo de duplicados mantienen sus controles anteriores.

El nombre indicado explícitamente en el mensaje actual («a nombre de», «me
llamo», «mi nombre es» o «Nombre:») prevalece sobre el borrador, el contacto y
los resúmenes de compras anteriores, desde el primer turno. Si luego se aporta
dirección o pago, una extracción del historial no puede restaurar otro nombre
ausente de ese mensaje. Otras formulaciones de cambio de nombre siguen usando
el extractor cuando el nombre propuesto aparece en el texto actual. Se conserva
el dato conocido como respaldo y la confirmación única del resumen revisado.

La dirección guarda la calle separada de la ciudad. Se eliminan únicamente
componentes completos de ciudad repetidos al final y separados por comas; no se
recortan nombres de calles que contengan la ciudad. Las firmas de resúmenes
anteriores admiten esa equivalencia de formato, manteniendo la revisión ante
cambios reales de dirección, ciudad, teléfono, notas, fecha, productos o precio.
El catálogo y el stock vigente se comprueban incluso al reutilizar el resumen.

La respuesta rápida de tarifa de reparto exige una relación explícita entre
precio y despacho. Mencionar ambos en partes distintas del mensaje, como
«sin cobro ni despacho», no interrumpe la compra ni la captura de datos.
Una intención de compra, modificación o cancelación reconocida mantiene su
flujo aunque incluya una consulta de tarifa; las consultas de reparto aisladas
siguen respondiéndose con el umbral de la tienda y conservan el borrador.

`ai_enabled_global=false` conserva los mensajes entrantes en CRM y detiene el
procesamiento y el envío automáticos. `bot_sales_enabled=false` permite consultas
sin crear pedidos. Los valores ausentes conservan el comportamiento previo.

IA y Bot muestra productos activos y condiciones pendientes. El operador debe
aprobar precios, stock, cobertura y pagos; el panel no inventa esos valores.
`delivery_info.cutoffTime` permite definir la hora límite en Chile, inclusive.
Sin valor explícito se conserva el corte histórico 12:50/13:00. No se copian
marcas, catálogos, cuentas bancarias ni datos de clientes entre organizaciones.

El simulador valida catálogo y confirmación sin guardar pedidos ni enviar
WhatsApp; no certifica entrega al proveedor ni ejecuta los beneficios personales
o campañas de un contacto real. La verificación final requiere una compra de
prueba por WhatsApp y la comprobación del número en CRM.

Pruebas principales: `order-confirmation`, `bot-settings`, `evolution-media`,
`sales-closing`, `delivery-status-pipeline` y la suite completa del backend.
