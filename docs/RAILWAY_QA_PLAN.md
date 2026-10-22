# Plan de QA en Railway

Estado: propuesta técnica; NO desplegada. Revisión de solo lectura: 2026-10-22. El inventario de infraestructura se mantiene fuera del repositorio público.

## Topología propuesta

Crear QA vacío, sin duplicar production, con tres servicios:
- qa-web: frontend de rama exclusiva infra/railway-qa, banner QA y acceso protegido.
- qa-api: backend de esa misma rama, solo red privada, una réplica.
- qa-db: PostgreSQL 17 nuevo; usuario, contraseña y base exclusivos; volumen nuevo.

No crear Evolution ni Redis para este QA. No conectar dominios comerciales,
webhooks de proveedores, claves de IA/WhatsApp/Shopify ni volúmenes existentes.
No importar respaldos ni datos de production. Acceso del navegador mediante
proxy del frontend al backend privado; WebSocket y carga de archivos también
deben pasar por ese proxy. Exigir autenticación antes de servir la aplicación:
la URL Railway por sí sola no es un control de acceso.

## Trabajo requerido antes del primer despliegue

El PR #11 es un sandbox Compose, NO una configuración desplegable directamente
en Railway: valida un destino db:5432 fijo y depende de una red Docker internal.
No copiar sus credenciales de ejemplo a una URL pública.

1. Adaptar el runtime con un modo Railway explícito y validación estricta del
   proyecto/environment de QA, host privado aprobado y nombre de base exclusivo.
   Rechazar production y credenciales externas antes de abrir conexiones.
2. Conservar simuladores de WhatsApp/IA y trabajos automáticos desactivados.
   Añadir rechazo de conexiones TCP salientes salvo el destino PostgreSQL de QA,
   además de los bloqueos HTTP. Documentar que es defensa de aplicación,
   no equivalente a una política de red de la plataforma.
3. Crear secretos aleatorios para acceso QA y usuarios ficticios; no publicar
   contraseñas en GitHub. Restringir el ingreso público completo (incluye tienda,
   archivos, API, websocket y rutas públicas), no solamente el login del CRM.
4. Preparar Dockerfiles/configuración exclusivos, sin cambiar el arranque de
   production ni los paths de configuración que production utiliza.
5. Pruebas aisladas: arranque con PostgreSQL nuevo, rechazo de URL de production,
   dos tenants ficticios, bloqueo de HTTP/TCP externos, mensajes simulados,
   trabajos apagados, login privado y proxy WebSocket.
6. PR independiente con CI y revisión. No fusionar ni desplegar sin aprobación.

## Presupuesto ilustrativo, no cotización

Tarifas de contenedores consultadas en documentación oficial:
RAM USD10/GB-mes; CPU USD20/vCPU-mes; volumen USD0.15/GB-mes;
egress USD0.05/GB. Fuente: https://docs.railway.com/pricing/plans

Escenario pequeño encendido todo el mes, SUPUESTOS (no mediciones):
RAM total web+api+db 0.50–1.00GB; CPU promedio total 0.02–0.05vCPU;
volumen facturable 1GB y salida 1GB.
Cálculo: USD5.60–11.20/mes de consumo de recursos.
Reserva orientativa: USD15/mes para QA, sujeta a aprobación y medición real.
No es un tope técnico garantizado. No aplicar límites globales del workspace
que puedan detener production. No se confirmó plan, créditos disponibles,
impuestos, facturación ni proyección actual de la cuenta con estas herramientas.
El incremento efectivo de factura depende de créditos compartidos disponibles.
No crear Codespaces ni usar Railway Agent de pago para esta implementación.

## Puesta en marcha y salida

Después de aprobar costo y despliegue: crear recursos vacíos, configurar SOLO
secretos nuevos, desplegar commit exacto de la rama QA y verificar /ready,
autenticación, tenant isolation y simulación. Registrar consumo de QA separado.
Sin promoción automática a production. Para retirar QA: detener/eliminar
únicamente IDs de QA, preservando recursos y límites de production.
