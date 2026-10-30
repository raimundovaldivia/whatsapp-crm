# Estados de despacho de un pedido

Las acciones individuales de Pedidos usan `PATCH /api/orders/:id/status`.
Aceptan `nuevo`, `por_despachar`, `en_camino`, `no_entregado` y `entregado`,
además de los estados anteriores `draft`, `sent`, `payment_received`, `paid`
y `cancelled`. La ruta exige sesión y rol owner, admin o supervisor.

El identificador debe ser un entero positivo. Tanto la lectura como la escritura
se limitan a la organización de la sesión; un pedido ajeno devuelve 404.
Los cambios actualizan `updated_at`. Marcar entregado registra `delivered_at`
una sola vez y no confirma el pago.

Estas acciones son el registro manual del pedido. La preparación de carga,
asignación de repartidor, salida, avisos al cliente y cierre de las paradas se
gestionan mediante el módulo Logística y sus rutas existentes. Cambiar un estado
manualmente no equivale a ejecutar ese circuito ni a enviar un aviso por WhatsApp.

Regresión local: `node --test test/order-manual-status.test.cjs` desde `backend/`.
Cubre la secuencia de los botones, conservación del pago pendiente y la hora de
entrega, compatibilidad, identificadores/estados inválidos y aislamiento de tienda.
