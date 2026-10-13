const { normalizePhone } = require('../db/database');

function phoneVariants(rawPhone) {
  const input = String(rawPhone || '').trim();
  if (!input) return [];

  const digits = input.replace(/\D/g, '');
  if (!/^[+\d\s().-]+$/.test(input) || digits.length < 9 || digits.length > 15) {
    const error = new Error('Teléfono de cliente inválido');
    error.status = 400;
    throw error;
  }

  const normalized = normalizePhone(input);
  return [...new Set([
    normalized,
    normalized.startsWith('569') ? normalized.slice(2) : null,
    normalized.startsWith('569') ? `+${normalized}` : null,
  ].filter(Boolean))];
}

/**
 * Catálogo permitido al crear un pedido manual.
 *
 * La selección se resuelve en SQL para que organización, tipo de cliente,
 * precios especiales y productos vigentes formen un único contrato.
 */
async function getOrderProductCatalog(pool, orgId, rawPhone) {
  const phones = phoneVariants(rawPhone);
  const preferredPhone = phones[0] || '';
  const { rows } = await pool.query(
    `WITH customer_context AS (
       SELECT COALESCE((
         SELECT client_type
           FROM contacts
          WHERE organization_id = $1
            AND phone = ANY($2::text[])
          ORDER BY CASE WHEN phone = $3 THEN 0 ELSE 1 END, updated_at DESC NULLS LAST
          LIMIT 1
       ), 'personal') AS client_type
     ), catalog_context AS (
       SELECT customer_context.client_type,
              EXISTS (
                SELECT 1
                  FROM contact_price_overrides override
                  JOIN products overridden_product
                    ON overridden_product.organization_id = override.organization_id
                   AND overridden_product.id::text = override.product_id
                   AND overridden_product.active = TRUE
                   AND overridden_product.deprecated_at IS NULL
                 WHERE override.organization_id = $1
                   AND override.phone = ANY($2::text[])
              ) AS has_overrides,
              EXISTS (
                SELECT 1
                  FROM products
                 WHERE organization_id = $1
                   AND active = TRUE
                   AND deprecated_at IS NULL
                   AND is_business = TRUE
              ) AS has_business_products
         FROM customer_context
     )
     SELECT p.*,
            COALESCE(price_override.custom_price, p.price) AS effective_price,
            (price_override.custom_price IS NOT NULL) AS special_price
       FROM products p
       CROSS JOIN catalog_context context
       LEFT JOIN LATERAL (
         SELECT custom_price
           FROM contact_price_overrides
          WHERE organization_id = $1
            AND phone = ANY($2::text[])
            AND product_id = p.id::text
          ORDER BY CASE WHEN phone = $3 THEN 0 ELSE 1 END, updated_at DESC NULLS LAST
          LIMIT 1
       ) price_override ON TRUE
      WHERE p.organization_id = $1
        AND p.active = TRUE
        AND p.deprecated_at IS NULL
        AND (
          (
            context.client_type = 'empresa'
            AND (
              (context.has_overrides AND price_override.custom_price IS NOT NULL)
              OR (
                NOT context.has_overrides
                AND (p.is_business = TRUE OR NOT context.has_business_products)
              )
            )
          )
          OR (
            context.client_type <> 'empresa'
            AND COALESCE(p.is_business, FALSE) = FALSE
          )
        )
      ORDER BY p.position ASC, p.id ASC`,
    [orgId, phones, preferredPhone]
  );

  return rows.map(({ effective_price: effectivePrice, special_price: specialPrice, ...product }) => ({
    ...product,
    price: effectivePrice,
    special_price: specialPrice,
  }));
}

module.exports = { getOrderProductCatalog, phoneVariants };
