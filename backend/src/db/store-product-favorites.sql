CREATE UNIQUE INDEX IF NOT EXISTS products_organization_id_id_unique
  ON products(organization_id, id);

CREATE TABLE IF NOT EXISTS store_product_favorites (
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL,
  visitor_id TEXT NOT NULL CHECK (char_length(visitor_id) BETWEEN 16 AND 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, product_id, visitor_id),
  FOREIGN KEY (organization_id, product_id)
    REFERENCES products(organization_id, id) ON DELETE CASCADE
);
