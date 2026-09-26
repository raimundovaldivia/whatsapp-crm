# Resel — CRM de WhatsApp para ecommerce

Resel concentra conversaciones, ventas asistidas por IA, pedidos, pagos, catálogo, marketing y reparto para varias organizaciones. Se integra directamente con Shopify y proveedores de WhatsApp, con acceso modular por contrato.

## Empieza aquí

Para agentes de software:

1. [AGENTS.md](AGENTS.md)
2. [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md)
3. solo la documentación especializada de la tarea
4. código directamente relacionado

Para desarrollo u operación:

- [ARCHITECTURE.md](ARCHITECTURE.md): componentes, flujos y límites.
- [DATABASE.md](DATABASE.md): esquema, invariantes y migraciones.
- [DEPLOYMENT.md](DEPLOYMENT.md): entorno y publicación segura.
- [HARNESS.md](HARNESS.md): pruebas y verificación proporcional.
- [KNOWN_ISSUES.md](KNOWN_ISSUES.md): deuda vigente y problemas ya cerrados localmente.

## Repositorio

```text
backend/       API, webhooks, bot, integraciones, PostgreSQL y tests
frontend/      panel web React/Vite
mobile/        app Expo para reparto
mobile-admin/  app Expo administrativa
```

Documentos funcionales existentes:

- [COMMERCIAL.md](COMMERCIAL.md): módulos, contratos y cuotas.
- [ADMIN-HANDOFF.md](ADMIN-HANDOFF.md): atención humana por WhatsApp.
- [SHOPIFY-INTEGRATION.md](SHOPIFY-INTEGRATION.md): integración directa y componentes retirados.
- [SECURITY-CHANGES.md](SECURITY-CHANGES.md): cambios derivados de la auditoría original.

Las auditorías históricas están en `../audit-2026-09-23/` y `../audit-2026-09-24/`. No sustituyen al código actual ni deben releerse completas para cada tarea.

## Desarrollo rápido

Requisitos: Node.js `>=22.13` y PostgreSQL.

```bash
cd backend
npm ci
npm run dev

# otra terminal
cd frontend
npm ci
npm run dev
```

Configura `DATABASE_URL` y un `JWT_SECRET` aleatorio de al menos 32 caracteres. `FRONTEND_URL` tiene un valor local por defecto y debe definirse para otros orígenes. Las integraciones requieren variables adicionales descritas en [DEPLOYMENT.md](DEPLOYMENT.md); no todas son necesarias para desarrollo aislado.

## Verificación

```bash
cd backend
npm test

cd ../frontend
npm run build
```

Selecciona primero la prueba del área. La suite completa corresponde a cambios de alto riesgo o cruzados; consulta [HARNESS.md](HARNESS.md).

## Estado operativo

El árbol actual contiene cambios locales sin confirmar y algunos aún no desplegados. La contratación es asistida y la API ejecuta jobs en el mismo proceso web. Antes de publicar, revisa [KNOWN_ISSUES.md](KNOWN_ISSUES.md), el diff y la compatibilidad de migraciones.

No uses producción, envíes mensajes, crees pedidos ni llames servicios pagados solo para verificar una hipótesis.
