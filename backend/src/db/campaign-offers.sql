-- Ofertas personales enviadas por texto libre (Evolution y futuros canales).
-- Migración aditiva e idempotente: la tabla ya existe en producción; estas
-- sentencias solo agregan columnas nuevas y no modifican datos existentes.

CREATE TABLE IF NOT EXISTS personal_offers (
  id BIGSERIAL PRIMARY KEY,
  organization_id INTEGER REFERENCES organizations(id),
  conversation_id INTEGER REFERENCES conversations(id),
  inbound_anchor TIMESTAMPTZ,
  discount_amount INTEGER,
  discount_tiers JSONB,
  min_trays INTEGER,
  unit_cost INTEGER,
  min_margin_pct NUMERIC,
  price_reason_source TEXT,
  price_reason_confidence NUMERIC,
  status TEXT,
  expires_at TIMESTAMPTZ,
  message_id INTEGER REFERENCES messages(id),
  redeemed_order_id INTEGER REFERENCES orders(id),
  redeemed_discount_amount INTEGER,
  redeemed_trays INTEGER,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  redeemed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ
);

ALTER TABLE personal_offers ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id);
ALTER TABLE personal_offers ADD COLUMN IF NOT EXISTS conversation_id INTEGER REFERENCES conversations(id);
ALTER TABLE personal_offers ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE personal_offers ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE personal_offers ADD COLUMN IF NOT EXISTS message_id INTEGER REFERENCES messages(id);
ALTER TABLE personal_offers ADD COLUMN IF NOT EXISTS redeemed_order_id INTEGER REFERENCES orders(id);
ALTER TABLE personal_offers ADD COLUMN IF NOT EXISTS redeemed_at TIMESTAMPTZ;
ALTER TABLE personal_offers ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;
ALTER TABLE personal_offers ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
ALTER TABLE personal_offers ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE personal_offers ADD COLUMN IF NOT EXISTS error TEXT;
ALTER TABLE personal_offers ADD COLUMN IF NOT EXISTS redeemed_discount_amount INTEGER;
ALTER TABLE personal_offers ADD COLUMN IF NOT EXISTS redeemed_trays INTEGER;
ALTER TABLE personal_offers ADD COLUMN IF NOT EXISTS product_id TEXT;
ALTER TABLE personal_offers ADD COLUMN IF NOT EXISTS offer_price INTEGER;
ALTER TABLE personal_offers ADD COLUMN IF NOT EXISTS scope JSONB;
ALTER TABLE personal_offers ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;
ALTER TABLE personal_offers ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS personal_offers_conversation_latest
  ON personal_offers (organization_id, conversation_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS personal_offers_redeemed_order
  ON personal_offers (redeemed_order_id);

-- Costo y margen mínimo por producto para validar ofertas personales.
ALTER TABLE products ADD COLUMN IF NOT EXISTS unit_cost INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS min_margin_pct NUMERIC;
