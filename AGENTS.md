# Guía operativa para agentes

Este repositorio se trabaja con tres principios: **minimum necessary context**, **minimum correct change** y **minimum sufficient verification**. El código actual es la fuente final de verdad; la documentación es su mapa.

## Inicio y contexto progresivo

1. Lee este archivo una vez.
2. Lee [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md).
3. Clasifica la tarea y abre solo el documento especializado relacionado.
4. Localiza símbolos, rutas, tablas o imports con búsquedas dirigidas.
5. Lee únicamente el código necesario; amplía el contexto solo ante una dependencia comprobada.

No recorras todo el repositorio ni repitas una auditoría general para resolver una tarea puntual.

## Antes de modificar código

1. Leer `PROJECT_CONTEXT.md`.
2. Clasificar el alcance y riesgo de la tarea.
3. Consultar solamente documentación relacionada.
4. Buscar primero si la funcionalidad ya existe.
5. Identificar implementación y dependencias actuales.
6. Revisar DB/migraciones únicamente si corresponde.
7. Evitar implementaciones paralelas y duplicaciones.
8. No inventar endpoints, tablas, servicios, funciones o infraestructura.
9. Mantener compatibilidad con producción y datos existentes.
10. Preferir el cambio correcto más pequeño.

No realizar refactors, reorganizaciones o actualizaciones generales que no sean necesarias para la tarea solicitada.

## Estructura esencial

- `backend/src/index.js`: composición HTTP, webhooks, Socket.IO y jobs.
- `backend/src/routes/`: borde HTTP; identidad y organización deben venir de la sesión o webhook verificado.
- `backend/src/services/`: reglas de negocio, bot, integraciones y procesos.
- `backend/src/db/`: acceso PostgreSQL y migraciones actuales.
- `backend/test/`: pruebas Node con PostgreSQL embebido cuando corresponde.
- `frontend/src/`: SPA React/Vite de administración.
- `mobile/`: app Expo de reparto.
- `mobile-admin/`: app Expo administrativa; evitar duplicar funciones web sin necesidad.

Mapa ampliado: [ARCHITECTURE.md](ARCHITECTURE.md). Datos: [DATABASE.md](DATABASE.md). Operación: [DEPLOYMENT.md](DEPLOYMENT.md).

## Comandos principales

Ejecutar desde el subproyecto correspondiente:

```bash
# backend
npm ci
npm run dev
npm test
node --test test/security.test.cjs

# frontend
npm ci
npm run dev
npm run build

# aplicaciones Expo
npm ci
npm run doctor
```

No existen scripts de lint, typecheck ni E2E. Consulta [HARNESS.md](HARNESS.md) para elegir la verificación mínima suficiente.

## Convenciones e invariantes

- Todo dato de negocio se limita por `organization_id`; no aceptes la organización desde texto del modelo ni parámetros cuando ya existe en sesión.
- Usa `normalizePhone()` de `backend/src/db/database.js` antes de guardar o comparar teléfonos.
- El modelo propone; servicios deterministas validan permisos, catálogo, precios, stock, pagos y escrituras.
- Un texto generado no demuestra que un pedido, pago, entrega o envío se completó.
- Webhooks deben conservar firma, deduplicación y persistencia durable.
- Cambios de autenticación, permisos, contratos, pagos, pedidos, migraciones e integraciones son de alto riesgo.
- Nunca registres ni documentes secretos. No uses producción ni APIs pagadas para probar una hipótesis.

## Verificación proporcional

- **Bajo riesgo:** documentación, copy o estilo aislado. Comprueba enlaces/sintaxis, diff y el artefacto afectado.
- **Riesgo medio:** lógica, endpoint, formulario o flujo. Ejecuta la prueba relacionada y build/typecheck si existe.
- **Alto riesgo:** auth, permisos, DB, pagos, pedidos, seguridad, infraestructura, almacenamiento o integración crítica. Añade una regresión razonable, ejecuta pruebas relacionadas y amplía a la suite completa cuando el cambio cruza subsistemas.

Para bugs: **REPRODUCIR → causa → regresión razonable → corregir → verificar**. Si varios intentos fallan, detente, obtén contexto adicional y formula una hipótesis antes de editar otra vez.

## Eficiencia de recursos

Usa el camino confiable más barato. Antes de leer más archivos, ampliar búsquedas, ejecutar toda la suite o llamar un servicio externo, comprueba si esa acción agrega confianza material. Conserva verificaciones necesarias para tareas críticas aunque cuesten más. No uses una llamada externa cuando un mock, una prueba local o una consulta dirigida resuelvan la misma duda.

## Componentes sensibles

- `middleware/auth.js`, `middleware/commercial-access.js` y `services/commercial.js`.
- `db/setup.js`, `db/database.js` y todos los archivos `db/*.sql`.
- `services/pipeline.js`, `services/order-pricing.js`, `services/order-confirmation.js` y `services/agents/`.
- webhooks, `webhook-inbox.js`, Shopify, comprobantes, conciliación, reparto y notificaciones.
- acciones masivas, fusiones y operaciones que envían mensajes o cambian estados financieros/logísticos.

Revisa [KNOWN_ISSUES.md](KNOWN_ISSUES.md) antes de tocar estas áreas. No asumas que el estado local está publicado.

## Evitar

- Refactors, nuevas dependencias, actualizaciones generales o infraestructura no solicitada.
- Duplicar una regla ya existente en otro canal o panel.
- Ejecutar toda la suite para un cambio aislado de bajo riesgo.
- Hacer deploy, enviar mensajes, crear pedidos o tocar datos reales sin instrucción explícita.
- Reescribir o descartar cambios ajenos en un worktree sucio.
- Tratar documentos históricos de auditoría como estado actual sin comprobar el código afectado.

## Documentación viva

La documentación forma parte del Definition of Done. Antes de terminar, evalúa si el cambio altera:

- `PROJECT_CONTEXT.md`: funcionalidad central o mapa del sistema.
- `ARCHITECTURE.md`: arquitectura, límites o nueva integración.
- `DATABASE.md`: esquema, migraciones o invariantes de datos.
- `DEPLOYMENT.md`: configuración, procesos o infraestructura.
- `HARNESS.md`: verificaciones disponibles o comandos.
- `KNOWN_ISSUES.md`: deuda relevante descubierta o resuelta.
- `AGENTS.md`: regla permanente para agentes.
- `README.md`: puerta de entrada o forma básica de ejecutar el proyecto.

Actualiza únicamente los documentos afectados. Una tarea no termina si deja documentación relevante contradiciendo el código actual. Si código y documentación difieren, verifica el comportamiento vigente y corrige el mapa; no cambies código correcto para satisfacer documentación antigua.

## Definition of Done

**UNDERSTAND → PLAN solo si lo exige la complejidad → IMPLEMENT → VERIFY → DOCUMENTATION IMPACT CHECK → DIFF REVIEW → DONE**

Antes de `DONE` confirma:

- se implementó exactamente lo solicitado;
- pasaron verificaciones proporcionales al riesgo;
- no hay cambios accidentales ni fuera de alcance;
- se revisó el diff;
- solo se actualizó documentación afectada;
- no se expusieron secretos;
- no se ejecutaron acciones reales innecesarias.

Informa siempre las verificaciones ejecutadas y su resultado. No afirmes “funciona” sin evidencia disponible.
