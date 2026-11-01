# Facebook e Instagram por tienda

La tienda requiere Marketing habilitado y un usuario owner/admin. La conexión usa el inicio de sesión de Meta de una persona administradora de la página de Facebook y su Instagram profesional vinculado.

Autorizar Meta concede acceso a los activos permitidos, pero no determina cuáles pertenecen a la tienda activa. En una conexión nueva, la página, Instagram y cuenta publicitaria quedan sin seleccionar. El operador debe elegir la página correcta en **Facebook e Instagram → Conexión → Guardar selección**. Hasta entonces no se suscriben sus eventos ni se enrutan mensajes a esa tienda.

Al reconectar se conserva exclusivamente la selección previa de esa organización si Meta todavía permite acceder a ella. Si falta la página anterior, se muestra una advertencia y no se reemplaza por la primera página disponible. La cuenta publicitaria también se conserva solo si sigue disponible; nunca se elige otra automáticamente.

La selección explícita valida los activos contra los autorizados por Meta y guarda la conexión por `organization_id`. El nombre mostrado en el módulo proviene de la tienda activa. Antes de activar respuestas automáticas, comprobar que la página y el usuario de Instagram corresponden a esa tienda.

Verificación local: `node --test test/meta-comment-connection.test.cjs test/social-events.test.cjs test/social-orders.test.cjs test/social-bot.test.cjs` desde `backend`. Comprueba autorización sin selección implícita, conservación al reconectar, rechazo de páginas no autorizadas, selección explícita, errores de permisos/suscripción y aislamiento del puente de pedidos. No conecta cuentas reales ni envía mensajes.
