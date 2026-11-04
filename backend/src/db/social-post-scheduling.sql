-- Extiende la cola existente; conserva historias, estados y aprobaciones anteriores.
BEGIN;
ALTER TABLE social_scheduled_posts DROP CONSTRAINT IF EXISTS social_scheduled_posts_platform_check;
ALTER TABLE social_scheduled_posts ADD CONSTRAINT social_scheduled_posts_platform_check
  CHECK (platform IN ('instagram_story', 'instagram', 'facebook'));
ALTER TABLE social_scheduled_posts ADD COLUMN IF NOT EXISTS media_type TEXT NOT NULL DEFAULT 'image';
ALTER TABLE social_scheduled_posts ADD COLUMN IF NOT EXISTS message TEXT NOT NULL DEFAULT '';
ALTER TABLE social_scheduled_posts ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE social_scheduled_posts ADD COLUMN IF NOT EXISTS target_id TEXT;
ALTER TABLE social_scheduled_posts ALTER COLUMN image_url SET DEFAULT '';
ALTER TABLE social_scheduled_posts DROP CONSTRAINT IF EXISTS social_posts_format_check;
ALTER TABLE social_scheduled_posts ADD CONSTRAINT social_posts_format_check CHECK (
  (platform = 'instagram_story' AND media_type = 'image') OR
  (platform = 'instagram' AND media_type IN ('image','video','reel')) OR
  (platform = 'facebook' AND media_type IN ('text','image','video','reel'))
);
COMMIT;
