BEGIN;
CREATE TABLE IF NOT EXISTS commercial_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS commercial_contracts (
  organization_id INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('legacy','trial','active','suspended','cancelled')),
  modules JSONB NOT NULL DEFAULT '[]', limits JSONB NOT NULL DEFAULT '{"bot_turns":500,"seats":3}',
  expires_at TIMESTAMPTZ, revision INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  CHECK (status <> 'trial' OR expires_at IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS commercial_usage (
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  metric TEXT NOT NULL CHECK (metric = 'bot_turns'), period DATE NOT NULL, quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0),
  PRIMARY KEY (organization_id, metric, period)
);
CREATE TABLE IF NOT EXISTS commercial_requests (
  id BIGSERIAL PRIMARY KEY, organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  module_key TEXT NOT NULL, requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined')),
  note TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), resolved_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS commercial_pending_request ON commercial_requests(organization_id,module_key) WHERE status='pending';
CREATE TABLE IF NOT EXISTS commercial_audit (
  id BIGSERIAL PRIMARY KEY, organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL, action TEXT NOT NULL,
  before_value JSONB, after_value JSONB, reason TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- One-time grandfathering only: subsequent restarts must not grant access to new signups.
INSERT INTO commercial_contracts(organization_id,status,modules,limits)
SELECT id,'legacy','["sales_ai","orders","marketing","payments","delivery","storefront","analytics"]','{"bot_turns":null,"seats":null}'
FROM organizations WHERE NOT EXISTS (SELECT 1 FROM commercial_migrations WHERE name='commercial-v1')
ON CONFLICT DO NOTHING;
INSERT INTO commercial_migrations(name) VALUES ('commercial-v1') ON CONFLICT DO NOTHING;
COMMIT;
