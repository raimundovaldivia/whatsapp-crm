-- Formatos de caja para venta a clientes naturales.
-- Son productos separados de las referencias historicas y de las tarifas B2B.
-- La insercion es idempotente y no pisa futuros cambios manuales de precio o stock.
INSERT INTO products (
  organization_id,
  title,
  description,
  price,
  sku,
  stock,
  active,
  position,
  category,
  is_business,
  egg_size,
  egg_color,
  pack_units,
  catalog_version
)
SELECT
  o.id,
  v.title,
  v.description,
  v.price,
  v.sku,
  100,
  TRUE,
  v.position,
  'Huevos',
  FALSE,
  v.egg_size,
  NULL,
  v.pack_units,
  'eggs-v2-boxes'
FROM organizations o
CROSS JOIN (VALUES
  (
    'Huevos XL · Caja de 180',
    'Caja de 180 huevos de campo tamano XL. Precio promocional por volumen; el color de la cascara se prepara segun disponibilidad.',
    55000::numeric,
    'DR-EGG-BOX-XL-180',
    140,
    'XL',
    180
  ),
  (
    'Huevos Jumbo · Caja de 100',
    'Caja de 100 huevos de campo tamano Jumbo. Precio promocional por volumen; el color de la cascara se prepara segun disponibilidad.',
    37000::numeric,
    'DR-EGG-BOX-JUMBO-100',
    141,
    'Jumbo',
    100
  )
) AS v(title, description, price, sku, position, egg_size, pack_units)
WHERE o.slug = 'diez-rios-mrs96z69'
  AND NOT EXISTS (
    SELECT 1
    FROM products p
    WHERE p.organization_id = o.id
      AND p.sku = v.sku
  );
