# Problemas conocidos y alcance pendiente

Estado basado en auditorías del 24-09-2026 y comprobaciones dirigidas contra el árbol local actual. No es una nueva auditoría. “Resuelto localmente” no significa desplegado.

## Pendientes de alta prioridad

- **Tienda pública:** `routes/store.js` sigue mostrando productos B2B, no reserva ni valida stock en checkout, no usa idempotencia y siempre comunica contra entrega. Dos compras simultáneas pueden exceder inventario o duplicarse.
- **Validación de productos:** el CRUD y la capa DB todavía aceptan valores sin una política uniforme ni restricciones SQL para precio, stock y precios por volumen.
- **Correlación Shopify:** `shopify-webhook.js` aún puede asociar un evento al pedido más reciente del teléfono y extrae `Conv:` como supuesto ID de borrador. Falta correlación inequívoca y revisión de importe/productos.
- **Cotización vs Shopify:** descuentos y precios especiales pueden existir solo en el total/nota local; las variantes del borrador Shopify usan su precio de Shopify. Debe verificarse el total externo antes de enviar el enlace.
- **Conciliación:** `reconciliation.unmatch()` restaura estados anteriores sin comprobar cambios posteriores; puede pisar una actualización logística o financiera más reciente.
- **Asistente administrativo:** acepta historial del navegador, comparte historial por organización, escribe configuración directamente, puede borrar campos omitidos, marca setup completo sin validar conexiones y su bucle de herramientas no tiene límite propio. No ampliar sus acciones antes de centralizar permisos, validación, propuesta y auditoría.

## Arquitectura y producto pendientes

- La API inicia también todos los jobs; varias réplicas pueden duplicar temporizadores. Falta separación API/worker o coordinación equivalente.
- El bot conserva moneda/formato/zona/país chilenos y límites de descuento incrustados. Falta perfil versionado por organización, simulador y rollback.
- No existen invitaciones, recuperación de cuenta, cobro automático de licencias ni ciclo completo de suscripción. La operación comercial es asistida.
- Varios caminos de envío llaman proveedores concretos. Falta una política común de envío y pruebas de contrato entre proveedores.
- Campañas largas corren dentro de solicitudes HTTP y sus controles no son uniformes entre envío individual y masivo.
- `mobile-admin` duplica parte del panel web; su necesidad y alcance deben validarse antes de ampliar ambas superficies.
- Tokens móviles se guardan en AsyncStorage; evaluar almacenamiento seguro del sistema antes de una exposición más amplia.

## Verificación faltante

- Sin lint, typecheck, tests de frontend ni E2E automatizados.
- Sin prueba documentada de restauración, respaldo externo, carga o recuperación regional.
- Sin matriz completa rol × endpoint × contrato × organización.
- Sin pruebas seguras de integración completas con Shopify/WhatsApp ni dispositivos físicos para cámara, GPS, push y conectividad intermitente.
- La reserva atómica de inventario entre CRM y Shopify sigue sin resolverse.

## Cerrado en el árbol local actual

Estos hallazgos históricos ya tienen implementación y regresiones locales; comprueba el código antes de reabrirlos:

- evasión comercial por mayúsculas;
- degradación/suspensión del propietario y cupos de usuarios activos;
- revocación de sesión y privilegios WhatsApp al suspender usuarios;
- pausa global antes de consumir turnos del bot;
- confirmación explícita sobre el mismo resumen del pedido;
- cantidades inválidas, stock conocido y precio por volumen tras unir líneas;
- prioridad de solicitudes explícitas de atención humana;
- asignación humana persistente, secretaria privada y estados de entrega;
- comprobantes parciales y deduplicación de evidencia;
- exclusión de pedidos futuros en despacho.

La publicación de estos cambios no está demostrada por el repositorio. `USER-SEATS-AND-BOT-SAFETY.md` y `ADMIN-HANDOFF.md` registran el alcance local.

## Recomendaciones deliberadamente no implementadas

No se añadieron CI complejo, framework de migraciones, cola externa, microservicios, observabilidad extensa, E2E ni nuevas dependencias. Requieren una decisión independiente basada en frecuencia de fallos, coste operativo y necesidades reales.
