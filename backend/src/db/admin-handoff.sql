CREATE TABLE IF NOT EXISTS admin_assignments (
  organization_id INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  admin_phone TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS admin_notification_deliveries (
  id BIGSERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  recipient TEXT,
  message_id TEXT,
  status TEXT NOT NULL DEFAULT 'sending',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_admin_delivery_message ON admin_notification_deliveries(organization_id, message_id);
-- Keep receipts even if a webhook arrives before the send request returns.
CREATE TABLE IF NOT EXISTS admin_delivery_receipts (
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, message_id)
);
-- One active customer per staff phone, and one staff owner per customer.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='admin_assignments_pkey'
    AND conrelid='admin_assignments'::regclass AND array_length(conkey,1)=1) THEN
    ALTER TABLE admin_assignments DROP CONSTRAINT admin_assignments_pkey;
    ALTER TABLE admin_assignments ADD PRIMARY KEY(organization_id,admin_phone);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_assignment_customer ON admin_assignments(organization_id,conversation_id);
CREATE TABLE IF NOT EXISTS staff_secretary_sessions (
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  history JSONB NOT NULL DEFAULT '[]',
  pending_action JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(organization_id,phone)
);
CREATE TABLE IF NOT EXISTS staff_secretary_actions (
  id BIGSERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  role TEXT NOT NULL,
  conversation_id INTEGER,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE staff_secretary_sessions ADD COLUMN IF NOT EXISTS identity TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS human_closed_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS human_attention_reminders (
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  stage INTEGER NOT NULL CHECK(stage IN (10,30)),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY(organization_id,conversation_id,message_id,stage)
);
