-- Additive: existing accounts retain access; suspending preserves attribution.
ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
CREATE INDEX IF NOT EXISTS users_active_org_idx ON users(organization_id) WHERE active;
