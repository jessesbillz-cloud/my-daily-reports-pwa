-- Add ntfy_topic to profiles for push notifications on scheduling requests
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS ntfy_topic TEXT;

-- Auto-generate topic from slug for existing profiles
UPDATE profiles
SET ntfy_topic = 'mdr-' || slug
WHERE ntfy_topic IS NULL AND slug IS NOT NULL;
