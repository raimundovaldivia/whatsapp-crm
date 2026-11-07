// Un pedido importado sin decisión logística local no vuelve a reparto si
// Shopify ya lo completó/anuló o pertenece al historial ampliado sin gestión
// local. FULFILLED no acredita entrega al cliente:
// esto filtra elegibilidad, sin reescribir crm_status ni delivered_at.
// Los reintentos/reprogramaciones explícitos del CRM siguen siendo válidos.
const importedShopifyClosed = `(COALESCE(crm_status, 'nuevo') IN ('', 'nuevo') AND (
  UPPER(COALESCE(fulfillment_status, '')) = 'FULFILLED'
  OR UPPER(COALESCE(financial_status, '')) IN ('VOIDED', 'REFUNDED')
  OR NULLIF(raw_json->>'cancelledAt', '') IS NOT NULL
  OR (
    COALESCE(shopify_created_at < (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '60 days', FALSE)
    AND delivery_date IS NULL
    AND COALESCE(dispatch_count, 0) = 0
    AND last_attempt_at IS NULL
    AND last_attempt_status IS NULL
    AND NULLIF(delivery_note, '') IS NULL
  )
))`;

module.exports = { importedShopifyClosed };
