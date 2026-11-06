# Precios por cantidad en el catálogo

`catalog_quantity_prices` es una configuración de `settings` aislada por organización. Cada clave es un SKU propio; `totals` contiene precios totales para cantidades consecutivas desde uno. `box_size` indica bandejas por caja y `units_per_tray`, huevos por bandeja. No requiere migración de esquema ni activa descuentos en otras tiendas.

La escala solo se utiliza si el precio de una unidad coincide con el precio base del producto. Los totales deben ser enteros positivos, no decrecer en valor total y no aumentar por unidad. Para cantidades superiores al último tramo se conserva el valor por unidad de ese tramo, redondeando el total a pesos.

El catálogo público y `loadBotCatalog` cargan la misma configuración. El bot calcula después de agrupar líneas repetidas. La cotización pública y `createStoreOrder` vuelven a calcular en servidor; el checkout rechaza un total esperado obsoleto y conserva la transacción de stock. Los calibres distintos no se suman para determinar el tramo. Los acuerdos especiales existentes conservan su prioridad.

La landing de Justo Casero permite seleccionar desde una bandeja hasta una caja y envía por WhatsApp el calibre, bandejas, huevos, subtotal, despacho y total. Los importes provienen del catálogo publicado, no de constantes en la web.

`store_shipping_rule` configura `{ "fee": 1500, "freeFrom": 15000 }` exclusivamente para Justo Casero. El umbral se calcula sobre productos después del descuento y antes del despacho: dos bandejas Súper Extra cuestan $13.900 + $1.500 = $15.400, mientras dos Extra cuestan $17.900 con despacho gratis. Desde $15.000 inclusive es gratuito. La cobertura autorizada es La Serena y Coquimbo. La cotización, el simulador, el bot y el checkout aplican la misma función; los pedidos conservan el desglose en `shipping_address.delivery_fee` y `products_total`.

## Configuración aprobada el 6 de noviembre de 2026

```json
{
  "JC-EXTRA-30": {"totals":[9900,17900,24900,31900,38900,44900],"box_size":6,"units_per_tray":30},
  "JC-SUPER-EXTRA-20": {"totals":[7900,13900,19900,24900,29900],"box_size":5,"units_per_tray":20}
}
```

Al convertir el catálogo operativo a bandejas, crear SKU nuevos, desactivar las cajas y transferir sus existencias multiplicadas por 6 o 5 en una transacción. Conservar los productos originales para los pedidos históricos. Actualizar `store_context` y `store_how_to_buy` de la misma organización para eliminar la prohibición anterior de vender bandejas. El bot convierte solicitudes explícitas de caja a la cantidad equivalente del SKU de bandeja.

Verificación focalizada: `node --test test/quantity-pricing.test.cjs test/store-order.test.cjs test/bot-settings.test.cjs`. Cubre los once totales, combinación de líneas, productos mezclados, equivalencias de caja, aislamiento, entradas inválidas, cambios de precio y rollback de inventario con PostgreSQL embebido. No envía mensajes ni crea pedidos de prueba en producción.
