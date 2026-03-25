-- Migration: Audit fixes (March 17, 2026)
-- 1. Add last_reminder_sent_at to jobs for duplicate notification prevention
-- 2. Add increment_suppression_count RPC for atomic suppression count updates

-- 1. Duplicate notification prevention column
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS last_reminder_sent_at timestamptz;

-- 2. Atomic suppression count increment (prevents race conditions on concurrent webhooks)
CREATE OR REPLACE FUNCTION increment_suppression_count(
  p_email text,
  p_reason text,
  p_bounce_type text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE email_suppressions
  SET
    event_count = event_count + 1,
    last_event_at = now(),
    reason = p_reason,
    bounce_type = p_bounce_type
  WHERE email = p_email;
END;
$$;
