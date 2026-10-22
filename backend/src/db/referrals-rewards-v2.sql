BEGIN;

-- Incremental extension: keep the original referral records and their codes.
ALTER TABLE referral_program_settings ADD COLUMN IF NOT EXISTS rules JSONB;
ALTER TABLE referral_codes ADD COLUMN IF NOT EXISTS rules_snapshot JSONB;
ALTER TABLE referral_codes ADD COLUMN IF NOT EXISTS rules_adopted_at TIMESTAMPTZ;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS qualifying_source TEXT;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS qualifying_order_id TEXT;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS rules_snapshot JSONB;
CREATE UNIQUE INDEX IF NOT EXISTS referral_qualifying_order_unique
  ON referrals(organization_id, qualifying_source, qualifying_order_id)
  WHERE qualifying_order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS referral_products_org_id ON products(organization_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS referral_orders_org_id ON orders(organization_id,id);

CREATE TABLE IF NOT EXISTS referral_rewards (
  id BIGSERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  referral_code_id BIGINT NOT NULL,
  referral_id BIGINT,
  beneficiary_phone TEXT NOT NULL,
  benefit_key TEXT NOT NULL,
  token TEXT NOT NULL CHECK(token ~ '^BONO-[A-F0-9]{16}$'),
  kind TEXT NOT NULL CHECK(kind IN ('discount','gift')),
  amount INTEGER NOT NULL DEFAULT 0 CHECK(amount >= 0),
  product_id INTEGER,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity BETWEEN 1 AND 10),
  minimum_purchase INTEGER NOT NULL DEFAULT 0 CHECK(minimum_purchase >= 0),
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','redeemed','void')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  redeemed_at TIMESTAMPTZ,
  redeemed_order_id INTEGER,
  redeemed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(organization_id, token),
  UNIQUE(organization_id, beneficiary_phone, benefit_key),
  UNIQUE(organization_id, id),
  FOREIGN KEY (organization_id, referral_code_id) REFERENCES referral_codes(organization_id, id),
  FOREIGN KEY (organization_id, referral_id) REFERENCES referrals(organization_id, id),
  FOREIGN KEY (organization_id, product_id) REFERENCES products(organization_id, id),
  FOREIGN KEY (organization_id, redeemed_order_id) REFERENCES orders(organization_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS referral_one_discount_per_order
  ON referral_rewards(organization_id, redeemed_order_id) WHERE kind = 'discount' AND status = 'redeemed';
CREATE UNIQUE INDEX IF NOT EXISTS referral_one_gift_per_order
  ON referral_rewards(organization_id, redeemed_order_id) WHERE kind = 'gift' AND status = 'redeemed';
CREATE INDEX IF NOT EXISTS referral_rewards_phone ON referral_rewards(organization_id, beneficiary_phone, status);

-- Domain outbox. Sending uses the existing WhatsApp delivery adapter.
CREATE TABLE IF NOT EXISTS referral_messages (
  id BIGSERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  referral_code_id BIGINT NOT NULL,
  reward_id BIGINT,
  dedupe_key TEXT NOT NULL,
  phone TEXT NOT NULL,
  customer_name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','queued','sending','sent','blocked','uncertain','cancelled')),
  due_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  last_error TEXT,
  approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, dedupe_key),
  FOREIGN KEY (organization_id, referral_code_id) REFERENCES referral_codes(organization_id, id),
  FOREIGN KEY (organization_id, reward_id) REFERENCES referral_rewards(organization_id, id)
);
CREATE INDEX IF NOT EXISTS referral_messages_due ON referral_messages(organization_id, status, due_at);

CREATE TABLE IF NOT EXISTS referral_program_audit (
  id BIGSERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Existing order editors must preserve the consumed benefit. In particular an
-- item replacement cannot silently erase a customer's discount or free tray.
CREATE OR REPLACE FUNCTION protect_redeemed_referral_items() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reward RECORD; matching_count INTEGER;
BEGIN
  IF NEW.items IS NOT DISTINCT FROM OLD.items AND NEW.total_price IS NOT DISTINCT FROM OLD.total_price THEN RETURN NEW; END IF;
  FOR reward IN SELECT * FROM referral_rewards WHERE organization_id=NEW.organization_id
    AND redeemed_order_id=NEW.id AND status='redeemed'
  LOOP
    SELECT COUNT(*) INTO matching_count FROM jsonb_array_elements(NEW.items::jsonb) item
      WHERE item->>'referral_reward_id'=reward.id::text
        AND (item->>'quantity')::numeric=CASE WHEN reward.kind='gift' THEN reward.quantity ELSE 1 END
        AND (item->>'price')::numeric=CASE WHEN reward.kind='discount' THEN -reward.amount ELSE 0 END
        AND (reward.kind='discount' OR item->>'id'=reward.product_id::text);
    IF matching_count<>1 OR (SELECT COUNT(*) FROM jsonb_array_elements(NEW.items::jsonb) item
      WHERE item->>'referral_reward_id'=reward.id::text)<>1 THEN
      RAISE EXCEPTION 'Conserva el bono o regalo ya canjeado al editar el pedido' USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS preserve_referral_items ON orders;
CREATE TRIGGER preserve_referral_items BEFORE UPDATE OF items,total_price ON orders
  FOR EACH ROW EXECUTE FUNCTION protect_redeemed_referral_items();
COMMIT;
