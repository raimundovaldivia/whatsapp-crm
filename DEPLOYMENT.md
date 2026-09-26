# Desarrollo y despliegue

## Desarrollo local

Requiere Node.js `>=22.13` para el backend y PostgreSQL accesible mediante `DATABASE_URL`.

```bash
cd backend
npm ci
npm run dev

cd ../frontend
npm ci
npm run dev
```

El frontend usa `VITE_BACKEND_URL`; si no está definido, revisa `frontend/src/utils/api.js` antes de asumir el destino. Las aplicaciones móviles tienen configuración propia en `src/config.js`.

## Configuración del backend

Variables observadas en el código, agrupadas por función:

- Base: `DATABASE_URL`, `PORT`, `NODE_ENV`, `FRONTEND_URL`, `TRUST_PROXY_HOPS`, `JWT_SECRET`.
- URLs públicas: `BACKEND_URL`, `CRM_PUBLIC_URL`, `PUBLIC_URL`.
- IA: `ANTHROPIC_API_KEY`; `OPENAI_API_KEY` solo para funciones opcionales como transcripción.
- WhatsApp: `KAPSO_API_KEY`, `KAPSO_WABA_ID`, `KAPSO_WEBHOOK_SECRET`, `META_APP_SECRET`, `WEBHOOK_VERIFY_TOKEN`.
- Shopify: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_SCOPES`.
- Archivos: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL`.
- Opcionales: `GOOGLE_MAPS_API_KEY`, `PLATFORM_ADMIN_USER_IDS`.

No todas son obligatorias para todos los módulos; confirma el consumidor antes de configurar. Credenciales de tiendas también viven por organización en PostgreSQL. Nunca copies valores reales a documentación, logs o pruebas.

## Topología actual

Los archivos `railway.toml` y Dockerfiles describen dos servicios desde sus carpetas:

- backend Node: `node src/index.js`, healthcheck `/health`;
- frontend Vite compilado y servido por Nginx;
- PostgreSQL como servicio asociado.

El backend ejecuta migraciones y jobs en el mismo proceso. `/health` confirma proceso; `/ready` comprueba acceso a DB. Render y la app puente `raigentic` no son dependencias activas del CRM.

Las apps Expo se compilan/distribuyen por separado con EAS; un deploy web no actualiza móviles.

## Despliegue real y trazabilidad

Producción está conectada directamente desde GitHub a Railway. En el entorno `production`, Railway despliega el repositorio `raimundovaldivia/whatsapp-crm` desde la rama `main` en dos servicios independientes:

- `whatsapp-crm-api`, con directorio raíz `/backend`;
- `whatsapp-crm`, con directorio raíz `/frontend`.

Un push a `main` genera despliegues automáticos de ambos servicios mediante la integración GitHub de Railway. El workflow `.github/workflows/verify.yml` ejecuta verificaciones, pero no contiene pasos de deploy. `auto-push.js` solo actúa si alguien lo inicia manualmente: crea commits y hace push de la rama activa; no es una canalización de publicación controlada y no debe usarse como procedimiento normal de release.

Para comprobar qué commit está realmente en producción:

1. Abre Railway, proyecto `spectacular-grace`, entorno `production`.
2. Entra en cada servicio (`whatsapp-crm-api` y `whatsapp-crm`) y abre el despliegue marcado `Active`.
3. En `Details`, confirma `Deployed via GitHub`, repositorio, rama `main`, directorio raíz y estado `Deployment successful`.
4. Abre o copia el enlace del commit mostrado por Railway; su URL contiene el SHA completo desplegado.
5. Contrástalo con la punta remota de `main` mediante `git ls-remote origin refs/heads/main`. La coincidencia demuestra que ese servicio ejecuta el commit actual de `main`; si difieren, toma el SHA de Railway como versión desplegada y revisa el historial antes de publicar nada.

Haz la comprobación en ambos servicios: compartir mensaje y hora de despliegue no sustituye verificar el enlace de commit de cada uno. No guardes un SHA concreto en este documento porque cambia en cada publicación.

## Publicación segura

1. Revisa diff, estado del worktree y documentos afectados.
2. Ejecuta las verificaciones proporcionales de [HARNESS.md](HARNESS.md).
3. Para cambios DB, respalda y valida migración idempotente con datos ficticios.
4. Verifica que no haya secretos ni URLs antiguas añadidas.
5. Publica backend antes o junto con clientes solo si existe compatibilidad entre versiones.
6. Comprueba `/health` y `/ready`.
7. Haz smoke tests sin crear pedidos, pagos, campañas o mensajes reales salvo que la prueba haya sido autorizada y preparada.
8. Revisa logs por errores de migración/webhook sin imprimir payloads sensibles.

No hacer deploy forma parte del alcance por defecto. Publicar, cambiar variables, registrar webhooks o modificar datos de producción requiere una instrucción explícita.

## Webhooks

- Meta: `/webhook`.
- Twilio: `/twilio-webhook`.
- Kapso: `/kapso-webhook`.
- Shopify: `/shopify-webhook/:orgId`.

Conserva cuerpo crudo, firma y secreto correspondientes. Kapso debe entregar eventos de recepción y estados si se requiere distinguir aceptado, entregado, leído y fallido. No registres el mismo mensaje en dos proveedores.

## Recuperación

Hay evidencia histórica de respaldos, pero no una prueba automatizada de restauración ni respaldo externo documentado en este repositorio. Una restauración real, recuperación regional y separación API/worker siguen pendientes; consulta [KNOWN_ISSUES.md](KNOWN_ISSUES.md).
