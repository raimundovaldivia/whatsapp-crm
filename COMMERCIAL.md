# Resel: operación comercial asistida

Esta versión permite vender módulos y administrar su acceso por tienda. La contratación y el cobro se acuerdan fuera de la app; no procesa suscripciones, emite facturas ni verifica pagos de la suscripción.

## Catálogo

La cuenta base incluye conversaciones, clientes, equipo e integraciones. Los siete módulos son Ventas con IA, Pedidos, Marketing, Pagos y cobranza, Logística, Tienda y catálogo, y Analítica. Ventas con IA, Pagos y Logística requieren Pedidos.

El catálogo canónico está en `backend/src/services/solution-catalog.js`. Los ajustes de cada tienda pueden ocultar funcionalidades contratadas, pero no conceder acceso a módulos sin contrato. La API aplica el control, independientemente del menú o del cliente móvil.

## Operación

1. El comercio crea su cuenta base y solicita módulos desde **Mis soluciones**.
2. El operador acuerda precio, condiciones, consumo y pago con el comercio.
3. Desde **Administración comercial**, selecciona la tienda y registra módulos, estado, límites y motivo. Una prueba requiere vencimiento.
4. Guardar un contrato activo aprueba las solicitudes pendientes correspondientes. Rechazar una solicitud requiere un motivo.
5. Suspender, cancelar o vencer el contrato bloquea los módulos; conserva conversaciones y datos. No revoca el acceso a la cuenta base.

Los cambios registran actor, fecha, motivo y valores anteriores y posteriores. Las actualizaciones simultáneas de contrato se rechazan si la revisión cambió.

## Administrador de plataforma

Configurar `PLATFORM_ADMIN_USER_IDS` en el backend de Railway con los identificadores de usuarios expresamente designados por el propietario. Verificar su identidad por correo antes de configurar. Vacío significa que nadie tiene administración global. Ser administrador de una tienda no concede este permiso. No usar automáticamente el usuario 1.

## Límites y costes

- `seats`: todos los usuarios de la organización, incluidos propietario y repartidores. No elimina usuarios existentes al reducir el límite; bloquea nuevas altas.
- `bot_turns`: turnos del agente de ventas iniciados por mes calendario UTC. Incluye intentos que luego fallen en el proveedor. El incremento y el límite son atómicos entre instancias.
- `null` significa sin límite. La cuenta base admite tres usuarios.
- El medidor de turnos **no representa todo el consumo de IA**: análisis de imágenes, transcripciones, asistente y evaluaciones no se facturan por este contador. Los costes de WhatsApp, proveedores y otros servicios se deben contemplar en el acuerdo comercial.

## Migración y publicación

Respaldar PostgreSQL antes de desplegar. `commercial.sql` crea tablas y conserva una sola vez el acceso de las organizaciones existentes como `legacy`, con los siete módulos y sin límites. Los registros posteriores no reciben este acceso. Los reinicios no repiten la concesión.

Verificar `/ready`, catálogo público, denegación de administración sin autorización y contratos existentes. Probar altas y cambios con datos ficticios fuera de producción. No bajar a una versión anterior a estos controles después de vender contratos: volvería a permitir funciones sin comprobación comercial.

## Alcance pendiente para autoservicio

Definir precios, moneda, condiciones comerciales, política de privacidad y soporte; elegir e integrar proveedor de suscripciones; conciliar cobros y facturación; ampliar medición de costes y observabilidad. La versión actual es un MVP para venta asistida, no una tienda de suscripciones automáticas.

## Validación

Las pruebas del backend cubren migración única, vencimiento, dependencias, permisos entre tiendas, cuotas simultáneas, revisiones y auditoría. Se verificó el flujo visual con cuentas ficticias en escritorio y móvil. La compilación web no distribuye nuevas versiones de las aplicaciones móviles.
