# Verificación mínima suficiente

## Qué existe

| Superficie | Verificación real | Comando |
|---|---|---|
| Backend | Tests Node; varios usan PGlite/PostgreSQL embebido | `cd backend && npm test` |
| Backend puntual | Un archivo o patrón de pruebas | `cd backend && node --test test/security.test.cjs` |
| Frontend | Compilación Vite de producción | `cd frontend && npm run build` |
| Apps Expo | Diagnóstico de compatibilidad, puede consultar servicios externos | `cd mobile && npm run doctor` / `cd mobile-admin && npm run doctor` |
| DB | Migración ejecutada por tests PGlite | tests `database`, `commercial` o `admin-handoff` |
| Salud desplegada | Proceso y DB | `GET /health`, `GET /ready` |

No hay scripts de lint, typecheck, tests de componentes web ni E2E. No los inventes dentro de una tarea no relacionada; registra la necesidad en [KNOWN_ISSUES.md](KNOWN_ISSUES.md).

## Selección por área

| Cambio | Prueba mínima recomendada |
|---|---|
| Auth, roles, webhooks, media | `node --test test/security.test.cjs` |
| Contratos, módulos, usuarios/cupos | `node --test test/commercial.test.cjs` |
| Bot, intención, contexto | `node --test test/conversation.test.cjs` |
| Precio, stock, confirmación | `node --test test/order-confirmation.test.cjs` |
| Atención humana y avisos | `node --test test/admin-handoff.test.cjs` |
| Comprobantes/abonos | `node --test test/payment-abonos.test.cjs` |
| DB, pagos y migraciones base | `node --test test/database.test.cjs` |
| Cola móvil de gastos | `node --test test/mobile-queue.test.cjs` |
| Reparto, inbox y regresiones cruzadas | `node --test test/regressions.test.cjs` |
| UI web | `npm run build` y revisión manual de la pantalla afectada |

## Proporción al riesgo

- Bajo: comprueba solo el artefacto, enlaces y diff. Para documentación no ejecutes builds ni tests de aplicación.
- Medio: prueba del área; agrega build web si cambió JSX/CSS o contrato API consumido por web.
- Alto: regresión del fallo, pruebas de áreas cruzadas y suite backend completa si toca más de un límite crítico. Para DB, ejecuta además la prueba de migración. Para frontend afectado, build.

Ejecuta la suite completa una vez cuando el cambio de alto riesgo cruce auth, tenencia, datos, pagos, pedidos o webhooks. No la repitas si nada relevante cambió después.

## Práctica para bugs

1. Reproduce con un test pequeño o evidencia determinista.
2. Identifica la causa y el punto de autoridad.
3. Añade regresión cuando protege una regla o evita recurrencia costosa.
4. Aplica el cambio mínimo.
5. Ejecuta primero la regresión y luego el conjunto proporcional.

Mocks y PGlite son preferibles a APIs reales. No envíes WhatsApp, campañas, pushes, pedidos Shopify ni llamadas de IA pagadas para verificar una hipótesis.

## Evidencia al terminar

Informa comando y resultado, por ejemplo: `node --test test/commercial.test.cjs` — 7/7 aprobadas. Si una verificación no existe o no se ejecutó, dilo. No uses el build como evidencia de reglas de negocio.
