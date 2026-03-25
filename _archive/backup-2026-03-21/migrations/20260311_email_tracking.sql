-- ============================================================
-- 20260311_email_tracking.sql
-- Email event logging + bounce/complaint suppression list.
-- Supports Resend webhook integration.
-- ============================================================

-- 1. Email events log — every webhook event gets logged here
CREATE TABLE IF NOT EXISTS email_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  resend_email_id TEXT,
  event_type TEXT NOT NULL,
  to_email TEXT,
  from_email TEXT,
  subject TEXT,
  bounce_type TEXT,
  complaint_type TEXT,
  raw_payload JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_events_type ON email_events(event_type);
CREATE INDEX IF NOT EXISTS idx_email_events_to ON email_events(to_email);
CREATE INDEX IF NOT EXISTS idx_email_events_created ON email_events(created_at);

-- 2. Suppression list — bounced/complained addresses get flagged
CREATE TABLE IF NOT EXISTS email_suppressions (
  email TEXT PRIMARY KEY,
  reason TEXT NOT NULL,           -- 'bounce' or 'complaint'
  bounce_type TEXT,               -- 'hard', 'soft', etc.
  event_count INT DEFAULT 1,
  first_event_at TIMESTAMPTZ DEFAULT now(),
  last_event_at TIMESTAMPTZ DEFAULT now(),
  suppressed BOOLEAN DEFAULT true -- can be manually cleared
);

CREATE INDEX IF NOT EXISTS idx_email_supp_reason ON email_suppressions(reason);

-- 3. RLS — service role only (webhook uses service key)
ALTER TABLE email_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_suppressions ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (edge functions use service key)
-- No user-facing policies needed — users don't query these directly

-- 4. Admin read policy (so you can view in Supabase dashboard)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'Service role full access to email_events'
      AND tablename = 'email_events'
  ) THEN
    CREATE POLICY "Service role full access to email_events"
      ON email_events FOR ALL
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'Service role full access to email_suppressions'
      AND tablename = 'email_suppressions'
  ) THEN
    CREATE POLICY "Service role full access to email_suppressions"
      ON email_suppressions FOR ALL
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;
