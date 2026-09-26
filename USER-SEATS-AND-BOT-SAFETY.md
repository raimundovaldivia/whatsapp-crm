# Venta por usuarios activos y controles del bot

Implementación local del 24 de septiembre de 2026. No implica despliegue en Railway.

## Cambios implementados

- Equipo permite suspender y reactivar cuentas sin borrar su identidad ni su historial. El endpoint DELETE anterior también suspende para mantener compatibilidad.
- Los cupos cuentan usuarios activos, incluido el propietario. Alta, reactivación y modificación de contrato usan el mismo bloqueo de organización para respetar el límite bajo concurrencia.
- El propietario no puede ser degradado ni suspendido. Nadie puede suspender su propia cuenta. Cada cambio de estado queda registrado en la auditoría comercial.
- La suspensión invalida sesiones, impide la atención por WhatsApp y bloquea avisos privados por WhatsApp y push. Las conexiones de chat existentes revalidan el acceso cada 15 segundos.
- Las restricciones comerciales funcionan también con direcciones en mayúsculas.
- La pausa global explícita del bot se consulta antes de consumir turnos.
- Los pedidos requieren un resumen calculado por el servidor y una confirmación explícita del cliente. Un marcador o afirmación del modelo no autoriza crear pedidos. Los cambios de cantidades, precios, destinatario o dirección exigen otro resumen.
- Se comprueba el stock conocido, se rechazan cantidades inválidas y se recalcula el precio por volumen después de unir líneas repetidas. El valor de stock -1 conserva el significado existente de inventario sin seguimiento.

## Validación

53 pruebas del backend aprobadas, incluidas migraciones PostgreSQL, aislamiento entre tiendas, cupos concurrentes, suspensión, pedidos y los flujos locales de atención humana. Compilación de producción del frontend aprobada.

## Migración y alcance

La migración aditiva `backend/src/db/members.sql` se ejecuta desde el instalador de la base de datos. Conserva activas todas las cuentas existentes. Debe ejecutarse antes de servir la nueva versión.

La validación de stock usa el catálogo disponible; todavía no constituye una reserva atómica entre canales o tiendas externas. La confirmación del cliente no equivale a acreditar un pago.

La refactorización comercial completa sigue pendiente: invitaciones, cobro automático de licencias, perfil versionado del bot con simulador, separación del proceso de trabajos y reorganización general de navegación. Estos cambios no se presentan como implementados.

Este árbol contiene otros cambios de atención humana, comprobantes y reparto que ya estaban en curso. Se conservaron y se probaron conjuntamente; no se publicó ni se agrupó todo en un commit durante esta implementación.
