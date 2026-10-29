# Cierre de pedidos del bot

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
