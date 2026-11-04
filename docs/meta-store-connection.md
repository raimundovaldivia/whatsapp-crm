# Facebook e Instagram por tienda

La tienda requiere Marketing habilitado y un usuario owner/admin. La conexión usa el inicio de sesión de Meta de una persona administradora de la página de Facebook y su Instagram profesional vinculado.

Autorizar Meta concede acceso a los activos permitidos, pero no determina cuáles pertenecen a la tienda activa. En una conexión nueva, la página, Instagram y cuenta publicitaria quedan sin seleccionar. El operador debe elegir la página correcta en **Facebook e Instagram → Conexión → Guardar selección**. Hasta entonces no se suscriben sus eventos ni se enrutan mensajes a esa tienda.

Al reconectar se conserva exclusivamente la selección previa de esa organización si Meta todavía permite acceder a ella. Si falta la página anterior, se muestra una advertencia y no se reemplaza por la primera página disponible. La cuenta publicitaria también se conserva solo si sigue disponible; nunca se elige otra automáticamente.

La selección explícita valida los activos contra los autorizados por Meta y guarda la conexión por `organization_id`. El nombre mostrado en el módulo proviene de la tienda activa. Antes de activar respuestas automáticas, comprobar que la página y el usuario de Instagram corresponden a esa tienda.

Verificación local: `node --test test/meta-comment-connection.test.cjs test/social-events.test.cjs test/social-orders.test.cjs test/social-bot.test.cjs` desde `backend`. Comprueba autorización sin selección implícita, conservación al reconectar, rechazo de páginas no autorizadas, selección explícita, errores de permisos/suscripción y aislamiento del puente de pedidos. No conecta cuentas reales ni envía mensajes.

## Publicar en ambas redes

En Contenido, selecciona **Facebook e Instagram**, carga una imagen y escribe el texto una sola vez. **Publicar en ambas redes** envía el mismo contenido a la página y al Instagram profesional de la tienda activa, mediante las dos llamadas autenticadas existentes. También se puede elegir una red por separado. Instagram exige una imagen o video; sin ella no se envía a ninguna de las dos.

El resultado se muestra por red. Si una rechaza la solicitud, **Reintentar solo …** conserva el texto y archivo y omite las publicaciones confirmadas. Si se pierde la respuesta o el servidor no puede confirmar el resultado, no se reintenta esa red: revisa su perfil antes de crear otra publicación. **Nueva publicación** limpia el borrador y sus resultados. Los resultados permanecen mientras esta vista esté abierta; no constituyen un historial persistente.

La autorización, el aislamiento por tienda y la espera de preparación de Instagram siguen en el backend existente. No cambia conexiones ni permisos y no replica publicaciones anteriores. Verificación local sin Meta: `cd frontend && npm test && npm run build`; `social-publish.test.mjs` cubre envío concurrente, doble pulsación, validación previa, éxito parcial y ausencia de reintentos ante incertidumbre.
