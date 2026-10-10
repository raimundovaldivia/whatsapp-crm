BEGIN;
SELECT pg_advisory_xact_lock(641309102026);
ALTER TABLE products ADD COLUMN IF NOT EXISTS deprecated_at TIMESTAMPTZ;
ALTER TABLE products ADD COLUMN IF NOT EXISTS replacement_product_id INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS egg_size TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS egg_color TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS pack_units INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS catalog_version TEXT;
CREATE TABLE IF NOT EXISTS product_catalog_archive (
 product_id INTEGER PRIMARY KEY, organization_id INTEGER NOT NULL, snapshot JSONB NOT NULL, archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE OR REPLACE FUNCTION protect_deprecated_product() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.deprecated_at IS NOT NULL THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Producto deprecado: se conserva para los pedidos existentes'; END IF;
  IF NEW.active=TRUE THEN RAISE EXCEPTION 'Producto deprecado: no se puede reactivar'; END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS protect_deprecated_product ON products;
CREATE TRIGGER protect_deprecated_product BEFORE DELETE OR UPDATE ON products FOR EACH ROW EXECUTE FUNCTION protect_deprecated_product();
DO $$
DECLARE org INTEGER;
BEGIN
 SELECT id INTO org FROM organizations WHERE slug='diez-rios-mrs96z69';
 IF org IS NOT NULL AND NOT EXISTS(SELECT 1 FROM settings WHERE organization_id=org AND key='eggs_catalog_v2_applied') THEN
  INSERT INTO product_catalog_archive(product_id,organization_id,snapshot)
  SELECT id,organization_id,to_jsonb(p) FROM products p WHERE organization_id=org AND COALESCE(is_business,FALSE)=FALSE AND title ILIKE '%huevo%'
  ON CONFLICT DO NOTHING;
  INSERT INTO products(organization_id,title,description,price,sku,stock,active,position,category,is_business,egg_size,egg_color,pack_units,catalog_version)
  SELECT org,'Huevos '||size||' '||color||' · Bandeja de '||units,
  'Bandeja de '||units||' huevos de campo tamaño '||size||', color '||color||'. El color identifica la cáscara. '||
  CASE WHEN size='M' THEN 'Sin descuento por cantidad.' ELSE 'Descuento automático por 2 o 3 bandejas del mismo producto. No acumulable con tarifas especiales.' END,
  price,'DR-EGG-V2-'||UPPER(size)||'-'||units||'-'||CASE color WHEN 'cafés' THEN 'CAFE' WHEN 'blancos' THEN 'BLANCO' ELSE 'MIXTO' END,
  100,TRUE,100+row_number() OVER(), 'Huevos',FALSE,size,color,units,'eggs-v2'
  FROM (VALUES
('M',30,'mixtos',8990),
('L',30,'blancos',9490),
('L',30,'mixtos',9990),
('L',30,'cafés',10990),
('XL',20,'blancos',8490),
('XL',20,'mixtos',8990),
('XL',20,'cafés',9990),
('XL',30,'blancos',10990),
('XL',30,'mixtos',11990),
('XL',30,'cafés',12990),
('Jumbo',20,'blancos',9490),
('Jumbo',20,'mixtos',9990),
('Jumbo',20,'cafés',10990),
('Jumbo',30,'blancos',13990),
('Jumbo',30,'mixtos',14990),
('Jumbo',30,'cafés',15990)
  ) AS v(size,units,color,price);
  UPDATE products old SET replacement_product_id=n.id
  FROM (VALUES (1,'M',30,'mixtos'),(2,'L',30,'mixtos'),(3,'XL',30,'mixtos'),(4,'Jumbo',20,'mixtos'),(5,'XL',20,'mixtos'),(28,'L',30,'cafés'),(31,'Jumbo',30,'mixtos'),(37,'XL',30,'blancos')) m(old_id,size,units,color)
  JOIN products n ON n.organization_id=org AND n.catalog_version='eggs-v2' AND n.egg_size=m.size AND n.pack_units=m.units AND n.egg_color=m.color
  WHERE old.id=m.old_id AND old.organization_id=org;
  -- Preserve agreed prices on equivalent new variants; originals remain untouched.
  INSERT INTO contact_price_overrides(organization_id,phone,product_id,product_title,custom_price)
  SELECT c.organization_id,c.phone,n.id::text,n.title,c.custom_price
  FROM contact_price_overrides c
  JOIN products old ON old.organization_id=c.organization_id AND (old.id::text=c.product_id OR old.title=c.product_title)
  JOIN (VALUES (1,'M',30,'mixtos'),(2,'L',30,'mixtos'),(3,'XL',30,'mixtos'),(4,'Jumbo',20,'mixtos'),(5,'XL',20,'mixtos'),(28,'L',30,'cafés'),(31,'Jumbo',30,'mixtos'),(37,'XL',30,'blancos')) m(old_id,size,units,color) ON old.id=m.old_id
  JOIN products n ON n.organization_id=org AND n.catalog_version='eggs-v2' AND n.egg_size=m.size AND n.pack_units=m.units AND n.egg_color=m.color
  WHERE c.organization_id=org ON CONFLICT DO NOTHING;
  UPDATE products SET active=FALSE,deprecated_at=NOW(),updated_at=NOW()
  WHERE organization_id=org AND id IN (SELECT product_id FROM product_catalog_archive WHERE organization_id=org);
  INSERT INTO settings(organization_id,key,value) VALUES(org,'eggs_catalog_v2_applied','true') ON CONFLICT DO NOTHING;
  INSERT INTO settings(organization_id,key,value) VALUES(org,'catalog_source','local') ON CONFLICT(organization_id,key) DO UPDATE SET value='local';
 END IF;
END $$;
COMMIT;
