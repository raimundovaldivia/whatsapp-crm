-- Historias de Instagram programadas con revisión previa y auditoría.
-- Migración aditiva: se puede ejecutar varias veces sin efectos.

CREATE TABLE IF NOT EXISTS social_scheduled_posts (
  id              BIGSERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  platform        TEXT NOT NULL DEFAULT 'instagram_story' CHECK (platform = 'instagram_story'),
  title           TEXT NOT NULL DEFAULT '',
  image_url       TEXT NOT NULL,
  scheduled_for   TIMESTAMPTZ NOT NULL,
  -- draft: falta corregir chequeos · review: chequeos OK, espera aprobación
  -- approved: programada · publishing: en curso · published · failed · cancelled
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','review','approved','publishing','published','failed','cancelled')),
  checks          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by      TEXT,
  approved_by     TEXT,
  approved_at     TIMESTAMPTZ,
  published_at    TIMESTAMPTZ,
  external_id     TEXT,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_social_posts_org_schedule
  ON social_scheduled_posts(organization_id, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_social_posts_due
  ON social_scheduled_posts(status, scheduled_for);

CREATE TABLE IF NOT EXISTS social_post_events (
  id              BIGSERIAL PRIMARY KEY,
  post_id         BIGINT NOT NULL REFERENCES social_scheduled_posts(id) ON DELETE CASCADE,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  action          TEXT NOT NULL,
  actor           TEXT,
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_social_post_events_post
  ON social_post_events(post_id, created_at);
