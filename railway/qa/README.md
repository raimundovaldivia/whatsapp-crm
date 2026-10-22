# QA aislado en Railway

Estos archivos se usan exclusivamente en el proyecto privado `whatsapp-crm-qa`,
environment `qa`, con tres servicios nuevos: `qa-web`, `qa-api` y `qa-db`.
No duplicar el entorno de producción ni copiar variables, respaldos o volúmenes.

La API exige CRM_SANDBOX=1, CRM_SANDBOX_PLATFORM=railway, NODE_ENV=development,
los nombres de proyecto/environment anteriores y DATABASE_URL con destino exacto
`qa-db.railway.internal:5432/crm_sandbox`, usuario `crm_sandbox` y contraseña
aleatoria hexadecimal de 64 caracteres. Solo ese destino TCP está permitido por
el runtime; HTTP/fetch/axios están bloqueados. Esta defensa de aplicación no es
una política de red del proveedor. No instalar secretos de integraciones reales.
Los trabajos automáticos están apagados; WhatsApp e IA son simulados.

Cada despliegue usa un commit fijo de una rama QA; no sigue main. Configurar raíz
del repositorio y archivos Railway `railway/qa/api.json` y `railway/qa/web.json`.
La base usa imagen pública postgres:17-alpine, volumen nuevo de 1000 MB,
POSTGRES_DB=crm_sandbox, POSTGRES_USER=crm_sandbox, POSTGRES_PASSWORD aleatoria
y PGDATA=/var/lib/postgresql/data/pgdata. La API no tiene dominio público.

El único dominio público pertenece a qa-web. Todas las rutas y upgrades exigen
acceso QA. Usuario de acceso: `qa`; contraseña: variable QA_ACCESS_PASSWORD en
ese servicio. Basic auth inicial crea cookie HttpOnly/Secure/SameSite=Lax para
conservar el acceso cuando el CRM usa Authorization Bearer. /qa-health es público
y solo devuelve un marcador fijo, sin consultar datos. La API privada escucha
3001. El proxy mantiene el frontend y la API en el mismo origen.

Después aparece el login propio del CRM: owner-a@sandbox.invalid o
owner-b@sandbox.invalid y contraseña SANDBOX_OWNER_PASSWORD en qa-api.
Las contraseñas se generan para este QA y no se guardan en GitHub.
El banner SANDBOX identifica esta instancia. Las sesiones del CRM vencen al
reiniciar la API. La base y sus datos ficticios persisten en su volumen exclusivo.

Validación: backend/test/sandbox.test.cjs cubre rechazo de destinos y credenciales,
bloqueo TCP/HTTP, simuladores y semillas con dos organizaciones. gateway.test.cjs
cubre restricción de páginas/API/upgrades, cookie y preservación del Bearer.
Tras desplegar, comprobar login, aislamiento entre organizaciones, simulación y
WebSocket antes de considerar el QA operativo. No apuntar pruebas a production.

Para promover cambios a producción se requiere otro PR y aprobación explícita.
