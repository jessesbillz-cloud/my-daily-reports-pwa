-- Email send counter — tracks monthly volume for Resend plan limit alerts
-- Option 2: self-contained counter, no external API dependency

CREATE TABLE IF NOT EXISTS email_send_counter (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  month TEXT NOT NULL,          -- e.g. '2026-03'
  send_count INTEGER DEFAULT 0,
  alert_sent BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(month)
);

-- RLS: authenticated users can read; only service role writes
ALTER TABLE email_send_counter ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view email counter"
  ON email_send_counter FOR SELECT
  TO authenticated
  USING (true);

-- Function to increment counter and return current count + alert status
CREATE OR REPLACE FUNCTION increment_email_counter()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  current_month TEXT;
  rec RECORD;
BEGIN
  current_month := to_char(now(), 'YYYY-MM');

  INSERT INTO email_send_counter (month, send_count)
  VALUES (current_month, 1)
  ON CONFLICT (month) DO UPDATE
    SET send_count = email_send_counter.send_count + 1,
        updated_at = now();

  SELECT send_count, alert_sent INTO rec
  FROM email_send_counter
  WHERE month = current_month;

  RETURN json_build_object(
    'month', current_month,
    'count', rec.send_count,
    'alert_sent', rec.alert_sent
  );
END;
$$;

-- Function to mark alert as sent for current month
CREATE OR REPLACE FUNCTION mark_email_alert_sent()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE email_send_counter
  SET alert_sent = TRUE, updated_at = now()
  WHERE month = to_char(now(), 'YYYY-MM');
END;
$$;
