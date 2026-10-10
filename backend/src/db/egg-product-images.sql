-- Completa únicamente las imágenes faltantes del catálogo de huevos v2.
-- Una imagen editada manualmente nunca se reemplaza.
UPDATE products
SET image_url = CASE egg_color
  WHEN 'blancos' THEN CASE WHEN pack_units = 20
    THEN '/store-assets/diez-rios/huevos-blancos-20-hogar-v4.jpg'
    ELSE '/store-assets/diez-rios/huevos-blancos-hogar-v3.jpg' END
  WHEN 'cafés' THEN CASE WHEN pack_units = 20
    THEN '/store-assets/diez-rios/huevos-cafe-20-hogar-v4.jpg'
    ELSE '/store-assets/diez-rios/huevos-cafe-30-hogar-v4.jpg' END
  WHEN 'mixtos' THEN CASE WHEN pack_units = 20
    THEN '/store-assets/diez-rios/huevos-mixtos-20-hogar-v4.jpg'
    ELSE '/store-assets/diez-rios/huevos-mixtos-hogar-v3.jpg' END
  ELSE image_url
END,
updated_at = NOW()
WHERE catalog_version = 'eggs-v2'
  AND (image_url IS NULL OR btrim(image_url) = '')
  AND egg_color IN ('blancos', 'cafés', 'mixtos');
