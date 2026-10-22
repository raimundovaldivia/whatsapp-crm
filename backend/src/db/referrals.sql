BEGIN;

-- Programa de referidos por organización. Los premios se describen aquí,
-- pero su entrega es manual para no emitir descuentos o dinero sin revisión.
CREATE TABLE IF NOT EXISTS referral_program_settings (
  organization_id INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  reward_referrer TEXT NOT NULL DEFAULT '',
  reward_referred TEXT NOT NULL DEFAULT '',
  terms TEXT NOT NULL DEFAULT '',
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Estos índices permiten claves foráneas compuestas que hacen imposible
-- enlazar un contacto o código perteneciente a otra organización.
CREATE UNIQUE INDEX IF NOT EXISTS contacts_org_id_unique
  ON contacts(organization_id, id);

CREATE TABLE IF NOT EXISTS referral_codes (
  id BIGSERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  referrer_contact_id INTEGER NOT NULL,
  code TEXT NOT NULL CHECK(code ~ '^REF-[A-Z0-9]{8}$'),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  click_count INTEGER NOT NULL DEFAULT 0 CHECK(click_count >= 0),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, referrer_contact_id),
  UNIQUE(organization_id, code),
  UNIQUE(organization_id, id),
  FOREIGN KEY (organization_id, referrer_contact_id)
    REFERENCES contacts(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS referral_codes_org_active
  ON referral_codes(organization_id, active, created_at DESC);

CREATE TABLE IF NOT EXISTS referrals (
  id BIGSERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  referral_code_id BIGINT NOT NULL,
  referred_contact_id INTEGER,
  referred_phone TEXT NOT NULL,
  referred_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','qualified','rewarded','rejected')),
  source TEXT NOT NULL DEFAULT 'manual'
    CHECK(source IN ('manual','whatsapp','link')),
  notes TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  qualified_at TIMESTAMPTZ,
  rewarded_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, referred_phone),
  UNIQUE(organization_id, id),
  FOREIGN KEY (organization_id, referral_code_id)
    REFERENCES referral_codes(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, referred_contact_id)
    REFERENCES contacts(organization_id, id) ON DELETE SET NULL (referred_contact_id)
);
CREATE INDEX IF NOT EXISTS referrals_org_status
  ON referrals(organization_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS referral_events (
  id BIGSERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  referral_id BIGINT NOT NULL,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('created','status_changed')),
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (organization_id, referral_id)
    REFERENCES referrals(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS referral_events_org_referral
  ON referral_events(organization_id, referral_id, created_at DESC);

COMMIT;
