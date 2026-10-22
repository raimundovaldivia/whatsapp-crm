# Desarrollo cloud aislado

Esta rama prepara un entorno que corre en GitHub Codespaces, sin depender del computador personal. No crea ni modifica servicios de Railway, ni conecta con producción. Los cambios llegan a producción únicamente mediante PR revisado, aprobación explícita y despliegue autorizado por separado.

## Iniciar desde el navegador

1. En GitHub, selecciona la rama `infra/cloud-sandbox` (o la rama que contenga este PR después de una fusión aprobada).
2. Abre **Code → Codespaces → Create codespace on this branch**. La cuenta debe tener Codespaces habilitado y disponibilidad de cuota; no se crea un recurso de pago automáticamente desde este PR.
3. El devcontainer instala Node 24, Docker y dependencias de backend/frontend con lockfiles. No inicia la aplicación automáticamente.
4. En la terminal del Codespace ejecuta:

   ```bash
   docker compose -f compose.sandbox.yml up --build -d --wait --wait-timeout 180
   ```

5. Abre el puerto **8080** desde la pestaña Ports. Conserva su visibilidad **Private**. El panel utiliza el mismo dominio HTTPS del puerto reenviado, incluyendo Socket.IO; no necesita una URL productiva.

## Datos ficticios y simulación

| Organización | Usuario |
| --- | --- |
| Sandbox A | `owner-a@sandbox.invalid` |
| Sandbox B | `owner-b@sandbox.invalid` |

Contraseña de demostración para ambas: `Sandbox-Local-Only-2026!`. Es pública y sirve únicamente para este entorno privado. Nunca publiques este sandbox en Internet. Cada organización tiene un producto, conversación y pedido ficticios. No importa datos reales y no utiliza las identidades de los negocios productivos.

Los botones de envío de texto/archivos WhatsApp guardan resultados simulados con identificadores `sandbox-…`; los eventos se ven con `docker compose -f compose.sandbox.yml logs -f backend`. La IA devuelve una respuesta fija marcada SANDBOX, sin llamadas ni gasto. OAuth, sincronización Shopify, descargas multimedia externas, campañas de proveedor y push están bloqueados, no simulados funcionalmente. No uses datos personales ni números reales. No abras enlaces a WhatsApp externos del navegador: están fuera del simulador del servidor.

Los trabajos de seguimiento, workers de webhooks, atribución y campañas no arrancan en este modo. Las acciones manuales solo modifican la base ficticia. Se conserva el flujo productivo cuando `CRM_SANDBOX` no está activado.

## Límites de seguridad

- Compose tiene nombre `crm-sandbox`, volumen propio y red `internal: true` para backend/PostgreSQL. Ninguno publica puertos ni tiene otra red. Solo nginx (sin credenciales) tiene además una red de ingreso para publicar `127.0.0.1:8080` y reenviar al backend fijo; no actúa como proxy abierto.
- No se carga `backend/.env` desde el host, no se interpolan credenciales del host y los Dockerfiles excluyen archivos `.env`. El backend sandbox rechaza otra dirección de DB, credenciales externas y overrides de conexión antes de cargar routers o ejecutar la preparación del esquema.
- Hay bloqueo adicional de Axios, fetch y HTTP/HTTPS salientes. La red interna es la barrera para clientes nuevos o SDK que no usen esos adaptadores.
- La clave JWT se genera al iniciar: las sesiones se invalidan cuando reinicia el backend. Los datos ficticios persisten sin duplicarse.
- El editor Codespaces tiene Internet para instalar dependencias y trabajar con GitHub. Backend y DB solo tienen la red interna; nginx tiene la red adicional de ingreso. No agregues secretos productivos al Codespace, devcontainer ni Compose. No conectes el backend a otra red ni lo ejecutes fuera de Compose con credenciales reales.
- El esquema todavía se prepara al iniciar, pero solo sobre `db:5432/crm_sandbox`. Separar migraciones productivas corresponde a otro PR.

## Verificar y reiniciar

```bash
npm --prefix backend test
npm --prefix frontend test
VITE_BACKEND_URL=same-origin VITE_CRM_SANDBOX=1 npm --prefix frontend run build
node scripts/smoke-sandbox.cjs
docker compose -f compose.sandbox.yml down
```

Para borrar exclusivamente los datos ficticios del sandbox y comenzar de nuevo:

```bash
docker compose -f compose.sandbox.yml down --volumes
docker compose -f compose.sandbox.yml up --build -d --wait --wait-timeout 180
```

No uses `docker-compose.yml` para este propósito: es una configuración distinta que carga variables del host. Las apps móviles no se reconfiguran aquí; sus builds de producción quedan intactos. Si se prueban después, necesitarán una variante sandbox explícita.

## Trabajar con PRs

Crea una rama de trabajo por cambio; revisa `git status` y el diff antes de hacer commit. No ejecutes `auto-push.js` ni `auto-push.bat`. Abre un PR y espera los workflows **Verify application** y **Verify isolated sandbox**. La segunda comprobación levanta PostgreSQL efímero, prueba login/aislamiento con dos tenants, envío simulado, IA y WebSocket, y elimina su volumen al finalizar. No contiene secrets ni pasos de despliegue.

Este PR no corrige todavía Evolution/Kapso, no activa protección de main y no separa las migraciones productivas. Esos cambios se revisarán en PRs independientes. No fusionar ni desplegar sin aprobación de Raimundo.
