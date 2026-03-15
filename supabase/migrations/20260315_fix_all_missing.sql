-- ============================================
-- Fix all missing columns and policies
-- Run in Supabase SQL Editor
-- ============================================

-- 1. inspection_requests: add special_type column
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS special_type TEXT;

-- 2. inspection_requests: ensure all expected columns exist
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS requester_email TEXT;
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS requester_name TEXT;
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS requester_company TEXT;
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS inspection_identifier TEXT;
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS flexible_display TEXT;
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS email_recipients JSONB DEFAULT '[]';
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS requested_date DATE;
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS cancelled_by TEXT;
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS cancel_reason TEXT;

-- 3. profiles: add push_subscription column for Web Push notifications
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS push_subscription JSONB;

-- 4. profiles: ensure all expected columns exist
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS ntfy_topic TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS company_name TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS slug TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS company_id UUID;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'trialing';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS company_role TEXT;

-- 5. templates: add template_name so company template distribution works
ALTER TABLE templates ADD COLUMN IF NOT EXISTS template_name TEXT;

-- 6. RLS: ensure profiles are readable by authenticated users
-- (admin page needs to list all users)
DO $$
BEGIN
  -- Enable RLS if not already
  ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

  -- Drop and recreate to avoid conflicts
  DROP POLICY IF EXISTS "Profiles are viewable by authenticated users" ON profiles;
  CREATE POLICY "Profiles are viewable by authenticated users"
    ON profiles FOR SELECT
    USING (auth.role() = 'authenticated');

  -- Users can update their own profile
  DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
  CREATE POLICY "Users can update own profile"
    ON profiles FOR UPDATE
    USING (auth.uid() = id);

  -- Users can insert their own profile
  DROP POLICY IF EXISTS "Users can insert own profile" ON profiles;
  CREATE POLICY "Users can insert own profile"
    ON profiles FOR INSERT
    WITH CHECK (auth.uid() = id);
END $$;

-- 7. Verify: show what we created
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'inspection_requests'
  AND column_name IN ('special_type','requester_email','requester_name','requester_company','flexible_display','email_recipients','requested_date','cancelled_by','cancel_reason','inspection_identifier')
ORDER BY column_name;

SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'profiles'
  AND column_name IN ('push_subscription','ntfy_topic','company_name','slug','company_id','subscription_status','company_role')
ORDER BY column_name;

SELECT policyname, cmd FROM pg_policies WHERE tablename = 'profiles';
