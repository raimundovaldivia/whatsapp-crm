# Geocodificación de repartos

`backend/src/routes/delivery.js` conserva los endpoints, permisos y contratos existentes. Su función `geocodeMany` delega en `backend/src/services/delivery-geocoding.js`, que reutiliza `geocode_cache` y siempre limita sus lecturas y escrituras por `organization_id`. No necesita migraciones.

Antes, un rechazo por facturación o cuota se guardaba como `found=false` y se reutilizaba indefinidamente. Ahora:

- Las coordenadas válidas existentes se conservan, incluso durante la recuperación de negativos. Una corrección concurrente positiva tiene prioridad sobre la respuesta pendiente del proveedor.
- `ZERO_RESULTS` y resultados imprecisos o ambiguos se guardan durante una hora. Después se consulta de nuevo cuando se solicita esa dirección; no hay una tarea en segundo plano.
- Rechazos de acceso, cuota, errores del proveedor y fallos de red no se guardan como direcciones inexistentes. Una pausa de 30 segundos por organización limita las solicitudes repetidas durante un incidente. Los logs contienen códigos generales, sin claves, URLs, direcciones ni texto del proveedor.
- La consulta a Google elimina referencias reconocibles y unidades internas que siguen al número. La dirección original y las instrucciones para el repartidor permanecen intactas. No se altera automáticamente la comuna.
- Se exige una única coincidencia en Chile, con precisión `ROOFTOP` o `RANGE_INTERPOLATED`, comuna y número compatibles, y coincidencia del nombre de la calle anterior al número. Las parcelas conservan sus identificadores completos y rechazan coincidencias parciales. Las direcciones sin número o ambiguas quedan pendientes de revisión. `RANGE_INTERPOLATED` es una ubicación aproximada a lo largo de la calle, no prueba de la entrada exacta.
- Las solicitudes iguales en curso se comparten dentro de la organización y cada lote consulta como máximo cinco direcciones simultáneamente. El estado de pausa y las solicitudes compartidas son por proceso.

La opción interna `retryNegative` permite una recuperación operativa explícita sin omitir positivos. No se expone por un endpoint nuevo. Para una recuperación histórica: inventariar una sola organización, respaldar, consultar las direcciones autorizadas, revisar resultados y actualizar únicamente negativos que no hayan cambiado. No modificar pedidos, rutas, pagos ni mensajes para reparar esta caché.

## Verificación

Desde `backend`, ejecutar `node --test test/delivery-geocoding.test.cjs test/mobile-route-map.test.cjs test/route-optimization.test.cjs test/route-reoptimization.test.cjs`. Las pruebas usan Google simulado y PostgreSQL embebido: fallo de facturación/cuota/red y recuperación, caducidad, conservación de positivos, direcciones con referencias, resultados incorrectos, aislamiento entre organizaciones y correcciones concurrentes. Completar la suite del CRM y las verificaciones del proyecto antes de publicar.

La validación local no acredita el estado de la facturación de Google. El significado de los estados y tipos de ubicación está documentado en [Google Geocoding](https://developers.google.com/maps/documentation/geocoding/requests-geocoding).
