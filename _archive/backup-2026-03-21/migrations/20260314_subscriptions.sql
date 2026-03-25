-- Subscription system with Stripe integration and trial tracking

-- Add Stripe customer ID to profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'trialing';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS subscription_plan TEXT DEFAULT 'trial';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS subscription_ends_at TIMESTAMPTZ;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;

-- Set trial_ends_at for existing users (14 days from now — grandfather them in)
UPDATE profiles
SET trial_ends_at = now() + INTERVAL '14 days',
    subscription_status = 'trialing'
WHERE trial_ends_at IS NULL;

-- Subscriptions ledger — full history of subscription events
CREATE TABLE IF NOT EXISTS subscription_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_event_id TEXT UNIQUE,
  event_type TEXT NOT NULL,
  plan TEXT,
  status TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_se_user ON subscription_events(user_id);

-- RLS
ALTER TABLE subscription_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own events" ON subscription_events
  FOR SELECT USING (user_id = auth.uid());

-- Trial abuse prevention: track card fingerprints
-- Stripe provides payment_method fingerprint — store it to prevent re-use
CREATE TABLE IF NOT EXISTS trial_fingerprints (
  fingerprint TEXT PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Function to check if a card fingerprint has been used for a trial before
CREATE OR REPLACE FUNCTION check_trial_fingerprint(p_fingerprint TEXT, p_user_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_existing UUID;
BEGIN
  SELECT user_id INTO v_existing FROM trial_fingerprints WHERE fingerprint = p_fingerprint;
  IF v_existing IS NOT NULL AND v_existing != p_user_id THEN
    RETURN FALSE; -- card already used by different user
  END IF;
  -- Record the fingerprint
  INSERT INTO trial_fingerprints (fingerprint, user_id)
  VALUES (p_fingerprint, p_user_id)
  ON CONFLICT (fingerprint) DO NOTHING;
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
