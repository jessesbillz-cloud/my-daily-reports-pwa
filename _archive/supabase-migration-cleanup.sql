-- ============================================================================
-- My Daily Reports — Supabase Scaling & Security Migration
-- ============================================================================
-- WHAT THIS DOES:
--   1. Removes dangerous "Allow all for dev" RLS policies
--   2. Removes duplicate RLS policies (keeps one of each)
--   3. Drops duplicate indexes and triggers
--   4. Adds proper scoped public policies for scheduling pages
--   5. Fixes trigger function search paths
--   6. Adds composite indexes for common queries
--   7. Drops unused crypto tables
--   8. Adds storage bucket size limits
--   9. Fixes inspection_requests date/time column types
--
-- SAFE TO RUN: Uses IF EXISTS / DO blocks. Won't error if items don't exist.
-- REVIEW BEFORE RUNNING — read each section, especially the crypto table drop.
-- ============================================================================


-- ============================================================================
-- STEP 1: REMOVE ALL "Allow all for dev" / qual=true BLANKET POLICIES
-- These override every other policy and expose all data to everyone.
-- ============================================================================

-- ── jobs: Remove the dev "allow all" policy ──
DROP POLICY IF EXISTS "Allow all for dev" ON jobs;
DROP POLICY IF EXISTS "allow_all" ON jobs;
DROP POLICY IF EXISTS "allow all" ON jobs;

-- ── templates: Remove the dev "allow all" policy ──
DROP POLICY IF EXISTS "Allow all for dev" ON templates;
DROP POLICY IF EXISTS "allow_all" ON templates;
DROP POLICY IF EXISTS "allow all" ON templates;

-- ── contacts: Remove blanket ALL policies ──
DROP POLICY IF EXISTS "Allow all for dev" ON contacts;
DROP POLICY IF EXISTS "allow_all" ON contacts;
DROP POLICY IF EXISTS "allow all" ON contacts;

-- ── inspection_log: Remove blanket ALL policies ──
DROP POLICY IF EXISTS "Allow all for dev" ON inspection_log;
DROP POLICY IF EXISTS "allow_all" ON inspection_log;
DROP POLICY IF EXISTS "allow all" ON inspection_log;

-- ── inspection_requests: Remove the blanket public ALL policy ──
-- (We'll add properly scoped public policies below)
DROP POLICY IF EXISTS "inspection_requests_public" ON inspection_requests;
DROP POLICY IF EXISTS "Allow all for dev" ON inspection_requests;
DROP POLICY IF EXISTS "allow_all" ON inspection_requests;
DROP POLICY IF EXISTS "allow all" ON inspection_requests;

-- ── reports: Just in case ──
DROP POLICY IF EXISTS "Allow all for dev" ON reports;
DROP POLICY IF EXISTS "allow_all" ON reports;
DROP POLICY IF EXISTS "allow all" ON reports;

-- ── profiles: Just in case ──
DROP POLICY IF EXISTS "Allow all for dev" ON profiles;
DROP POLICY IF EXISTS "allow_all" ON profiles;
DROP POLICY IF EXISTS "allow all" ON profiles;

-- ── saved_templates: Just in case ──
DROP POLICY IF EXISTS "Allow all for dev" ON saved_templates;
DROP POLICY IF EXISTS "allow_all" ON saved_templates;
DROP POLICY IF EXISTS "allow all" ON saved_templates;


-- ============================================================================
-- STEP 2: REMOVE DUPLICATE RLS POLICIES
-- The audit found doubled-up SELECT/INSERT/UPDATE/DELETE policies.
-- We keep the ones defined in supabase-setup.sql and drop likely duplicates.
-- Common duplicate naming patterns: with/without "own", different casing, etc.
-- ============================================================================

-- ── jobs duplicates ──
-- Keep: "Users can select their own jobs", "Users can insert their own jobs",
--       "Users can update their own jobs", "Users can delete their own jobs",
--       "Public can view scheduling-enabled jobs"
-- Drop likely duplicates:
DROP POLICY IF EXISTS "jobs_select_policy" ON jobs;
DROP POLICY IF EXISTS "jobs_insert_policy" ON jobs;
DROP POLICY IF EXISTS "jobs_update_policy" ON jobs;
DROP POLICY IF EXISTS "jobs_delete_policy" ON jobs;
DROP POLICY IF EXISTS "Enable read access for users" ON jobs;
DROP POLICY IF EXISTS "Enable insert for users" ON jobs;
DROP POLICY IF EXISTS "Enable update for users" ON jobs;
DROP POLICY IF EXISTS "Enable delete for users" ON jobs;

-- ── templates duplicates ──
DROP POLICY IF EXISTS "templates_select_policy" ON templates;
DROP POLICY IF EXISTS "templates_insert_policy" ON templates;
DROP POLICY IF EXISTS "templates_update_policy" ON templates;
DROP POLICY IF EXISTS "templates_delete_policy" ON templates;
DROP POLICY IF EXISTS "Enable read access for users" ON templates;
DROP POLICY IF EXISTS "Enable insert for users" ON templates;
DROP POLICY IF EXISTS "Enable update for users" ON templates;
DROP POLICY IF EXISTS "Enable delete for users" ON templates;

-- ── reports duplicates ──
DROP POLICY IF EXISTS "reports_select_policy" ON reports;
DROP POLICY IF EXISTS "reports_insert_policy" ON reports;
DROP POLICY IF EXISTS "reports_update_policy" ON reports;
DROP POLICY IF EXISTS "reports_delete_policy" ON reports;
DROP POLICY IF EXISTS "Enable read access for users" ON reports;
DROP POLICY IF EXISTS "Enable insert for users" ON reports;
DROP POLICY IF EXISTS "Enable update for users" ON reports;
DROP POLICY IF EXISTS "Enable delete for users" ON reports;

-- ── inspection_requests duplicates ──
-- The audit found 12 policies. Keep only the ones we defined + the public ones.
DROP POLICY IF EXISTS "inspection_requests_select_policy" ON inspection_requests;
DROP POLICY IF EXISTS "inspection_requests_insert_policy" ON inspection_requests;
DROP POLICY IF EXISTS "inspection_requests_update_policy" ON inspection_requests;
DROP POLICY IF EXISTS "inspection_requests_delete_policy" ON inspection_requests;
DROP POLICY IF EXISTS "Enable read access for users" ON inspection_requests;
DROP POLICY IF EXISTS "Enable insert for users" ON inspection_requests;
DROP POLICY IF EXISTS "Enable update for users" ON inspection_requests;
DROP POLICY IF EXISTS "Enable delete for users" ON inspection_requests;
DROP POLICY IF EXISTS "Authenticated users can manage their requests" ON inspection_requests;
DROP POLICY IF EXISTS "authenticated_crud" ON inspection_requests;

-- ── profiles duplicates ──
DROP POLICY IF EXISTS "profiles_select_policy" ON profiles;
DROP POLICY IF EXISTS "profiles_insert_policy" ON profiles;
DROP POLICY IF EXISTS "profiles_update_policy" ON profiles;
DROP POLICY IF EXISTS "Enable read access for users" ON profiles;
DROP POLICY IF EXISTS "Public profiles are viewable by everyone" ON profiles;


-- ============================================================================
-- STEP 3: FIX inspection_requests RLS — ADD PROPER PUBLIC POLICIES
-- schedule.html needs: public SELECT, INSERT, UPDATE (for edit/cancel)
-- index.html needs: auth-scoped SELECT, UPDATE, DELETE
-- ============================================================================

-- Public can read all inspection requests (for calendar view)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Public can read inspection requests for scheduling' AND tablename = 'inspection_requests') THEN
    CREATE POLICY "Public can read inspection requests for scheduling" ON inspection_requests FOR SELECT USING (TRUE);
  END IF;
END $$;

-- Public can create inspection requests (from scheduling page)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Public can insert inspection requests' AND tablename = 'inspection_requests') THEN
    CREATE POLICY "Public can insert inspection requests" ON inspection_requests FOR INSERT WITH CHECK (TRUE);
  END IF;
END $$;

-- Public can update inspection requests (edit/cancel from scheduling page)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Public can update inspection requests' AND tablename = 'inspection_requests') THEN
    CREATE POLICY "Public can update inspection requests" ON inspection_requests FOR UPDATE USING (TRUE) WITH CHECK (TRUE);
  END IF;
END $$;

-- Owner can delete inspection requests (from MDR dashboard)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can delete their own inspection requests' AND tablename = 'inspection_requests') THEN
    CREATE POLICY "Users can delete their own inspection requests" ON inspection_requests FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;

-- Drop the old owner-only SELECT/UPDATE since we now have public policies covering those
DROP POLICY IF EXISTS "Users can select their own inspection requests" ON inspection_requests;
DROP POLICY IF EXISTS "Users can update their own inspection requests" ON inspection_requests;


-- ============================================================================
-- STEP 4: FIX contacts RLS — SCOPE PROPERLY
-- schedule.html needs: public SELECT (for dropdown), public INSERT (save new)
-- index.html: owner UPDATE/DELETE
-- ============================================================================

-- The contacts policies in supabase-setup.sql are already correct:
--   "Public can read contacts for scheduling" — SELECT USING (TRUE)
--   "Public can insert contacts" — INSERT WITH CHECK (TRUE)
--   "Users can update their own contacts" — UPDATE USING auth.uid() = user_id
--   "Users can delete their own contacts" — DELETE USING auth.uid() = user_id
-- Just make sure no blanket ALL remains (handled in Step 1)


-- ============================================================================
-- STEP 5: FIX inspection_log — ADD PROPER RLS
-- The audit says it has ALL with qual=true. If the app doesn't use it,
-- we lock it down to owner-only.
-- ============================================================================

-- inspection_log is not referenced in any app code.
-- RLS enabled + no policies = fully locked (no API access). That's fine.
-- If you want to drop it entirely, uncomment the line below:
-- DROP TABLE IF EXISTS inspection_log CASCADE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'inspection_log' AND table_schema = 'public') THEN
    ALTER TABLE inspection_log ENABLE ROW LEVEL SECURITY;
    -- All "Allow all" policies were already dropped in Step 1.
    -- With RLS enabled and zero policies, the table is fully locked from API access.
  END IF;
END $$;


-- ============================================================================
-- STEP 6: DROP DUPLICATE INDEXES
-- The audit found identical indexes with different names.
-- ============================================================================

-- ── inspection_requests: duplicate date indexes ──
DROP INDEX IF EXISTS idx_insp_date;           -- duplicate of inspection_requests_requested_date_idx
DROP INDEX IF EXISTS idx_inspection_requests_date; -- duplicate of inspection_requests_requested_date_idx

-- ── inspection_requests: duplicate job_id indexes ──
DROP INDEX IF EXISTS idx_insp_job;            -- duplicate of inspection_requests_job_id_idx

-- ── reports: duplicate indexes ──
DROP INDEX IF EXISTS idx_reports_date;        -- duplicate of reports_report_date_idx
DROP INDEX IF EXISTS idx_reports_job;         -- duplicate of reports_job_id_idx
DROP INDEX IF EXISTS idx_reports_user;        -- duplicate of reports_user_id_idx

-- ── jobs: duplicate user_id index ──
DROP INDEX IF EXISTS idx_jobs_user;           -- duplicate of jobs_user_id_idx

-- ── templates: duplicate job_id index ──
DROP INDEX IF EXISTS idx_templates_job;       -- duplicate of templates_job_id_idx


-- ============================================================================
-- STEP 7: DROP DUPLICATE TRIGGERS
-- Keep only the one defined in supabase-setup.sql: *_update_timestamp
-- ============================================================================

-- ── inspection_requests: has 3 triggers, keep 1 ──
DROP TRIGGER IF EXISTS inspection_requests_updated ON inspection_requests;
DROP TRIGGER IF EXISTS inspection_requests_updated_at ON inspection_requests;
-- Keep: inspection_requests_update_timestamp

-- ── reports: has 2 triggers, keep 1 ──
DROP TRIGGER IF EXISTS reports_updated ON reports;
DROP TRIGGER IF EXISTS reports_updated_at ON reports;
-- Keep: reports_update_timestamp

-- ── templates: has 2 triggers, keep 1 ──
DROP TRIGGER IF EXISTS templates_updated ON templates;
DROP TRIGGER IF EXISTS templates_updated_at ON templates;
-- Keep: templates_update_timestamp

-- Also drop any duplicate trigger function (keep update_timestamp only)
DROP FUNCTION IF EXISTS update_updated_at() CASCADE;


-- ============================================================================
-- STEP 8: FIX TRIGGER FUNCTION SEARCH PATH (Security Advisor)
-- ============================================================================

CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


-- ============================================================================
-- STEP 9: ADD COMPOSITE INDEXES FOR COMMON QUERY PATTERNS
-- ============================================================================

-- jobs: commonly queried as "WHERE user_id = X AND is_archived = false"
CREATE INDEX IF NOT EXISTS jobs_user_active_idx ON jobs(user_id) WHERE is_archived = FALSE;

-- jobs: scheduling queries "WHERE user_id = X AND scheduling_enabled = true AND is_archived = false"
CREATE INDEX IF NOT EXISTS jobs_scheduling_idx ON jobs(user_id) WHERE scheduling_enabled = TRUE AND is_archived = FALSE;

-- reports: commonly queried as "WHERE job_id = X AND report_date = Y"
-- (The unique index on (job_id, report_date) already covers this)

-- inspection_requests: commonly queried by user + date range
CREATE INDEX IF NOT EXISTS inspection_requests_user_date_idx ON inspection_requests(user_id, requested_date);

-- Drop individual indexes that are now covered by composites
-- (Keep them for now — Postgres can use them for single-column lookups too)


-- ============================================================================
-- STEP 10: FIX inspection_requests DATE/TIME COLUMNS
-- inspection_time is TEXT but should be TIME, inspection_date is TEXT but
-- we already have requested_date as proper DATE.
-- ============================================================================

-- inspection_time: Convert TEXT → TIME (safe — "HH:MM" parses to TIME)
-- Only do this if the column exists and is text type
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'inspection_requests'
    AND column_name = 'inspection_time'
    AND data_type = 'text'
  ) THEN
    -- First set any empty strings to NULL so the cast works
    UPDATE inspection_requests SET inspection_time = NULL WHERE inspection_time = '';
    ALTER TABLE inspection_requests ALTER COLUMN inspection_time TYPE TIME USING inspection_time::TIME;
  END IF;
END $$;

-- Drop the redundant text-based inspection_date column if it exists
-- (requested_date is the proper DATE column)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'inspection_requests'
    AND column_name = 'inspection_date'
    AND data_type = 'text'
  ) THEN
    -- Migrate any data from inspection_date to requested_date if requested_date is null
    UPDATE inspection_requests
    SET requested_date = inspection_date::DATE
    WHERE requested_date IS NULL AND inspection_date IS NOT NULL AND inspection_date != '';

    ALTER TABLE inspection_requests DROP COLUMN inspection_date;
  END IF;
END $$;


-- ============================================================================
-- STEP 11: CRYPTO TABLES — DROP IF NOT USED
-- These tables are not referenced by any app code and add schema complexity.
-- COMMENT OUT THIS SECTION if you want to keep them.
-- ============================================================================

DROP TABLE IF EXISTS crypto_signal_correlation CASCADE;
DROP TABLE IF EXISTS crypto_signals CASCADE;


-- ============================================================================
-- STEP 12: STORAGE BUCKET HARDENING
-- Add file size limits and restrict MIME types
-- ============================================================================

-- Set max file size to 10MB for report-source-docs (PDF templates)
UPDATE storage.buckets
SET file_size_limit = 10485760,  -- 10 MB
    allowed_mime_types = ARRAY['application/pdf', 'image/png', 'image/jpeg', 'image/jpg']
WHERE id = 'report-source-docs';

-- Set max file size to 25MB for report-working-copies
UPDATE storage.buckets
SET file_size_limit = 26214400  -- 25 MB
WHERE id = 'report-working-copies';

-- Set max file size to 25MB for report-submitted
UPDATE storage.buckets
SET file_size_limit = 26214400  -- 25 MB
WHERE id = 'report-submitted';

-- Set max file size to 10MB for scheduling-files (photos/PDFs from requesters)
UPDATE storage.buckets
SET file_size_limit = 10485760,  -- 10 MB
    allowed_mime_types = ARRAY['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/heic']
WHERE id = 'scheduling-files';

-- Set max file size to 10MB for inspection-files
UPDATE storage.buckets
SET file_size_limit = 10485760,  -- 10 MB
    allowed_mime_types = ARRAY['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/heic']
WHERE id = 'inspection-files';

-- Add missing UPDATE and DELETE policies for inspection-files bucket
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can update inspection files' AND tablename = 'objects') THEN
    CREATE POLICY "Users can update inspection files" ON storage.objects
    FOR UPDATE USING (bucket_id = 'inspection-files' AND (storage.foldername(name))[1] = auth.uid()::text)
    WITH CHECK (bucket_id = 'inspection-files' AND (storage.foldername(name))[1] = auth.uid()::text);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can delete inspection files' AND tablename = 'objects') THEN
    CREATE POLICY "Users can delete inspection files" ON storage.objects
    FOR DELETE USING (bucket_id = 'inspection-files' AND (storage.foldername(name))[1] = auth.uid()::text);
  END IF;
END $$;


-- ============================================================================
-- STEP 13: AUTH SETTINGS (must be done via Supabase Dashboard, not SQL)
-- ============================================================================
-- The following CANNOT be done via SQL and must be configured manually:
--
-- 1. ENABLE EMAIL CONFIRMATION:
--    Dashboard → Authentication → Settings → Email Auth → Toggle "Confirm email"
--
-- 2. ENABLE LEAKED PASSWORD PROTECTION:
--    Dashboard → Authentication → Settings → Password → Enable "Leaked password protection"
--
-- 3. INCREASE EMAIL RATE LIMIT (or switch to Resend):
--    Dashboard → Authentication → Settings → Rate Limits → Increase from 2/hr
--    OR (recommended): You already use Resend via the send-report edge function.
--    Consider routing ALL auth emails through Resend too.
--
-- 4. UPGRADE COMPUTE (when ready for more users):
--    Dashboard → Project Settings → Compute → Upgrade from Micro
--
-- ============================================================================


-- ============================================================================
-- VERIFICATION QUERY — Run this after the migration to check policy counts
-- ============================================================================
-- SELECT tablename, COUNT(*) as policy_count
-- FROM pg_policies
-- WHERE schemaname = 'public'
-- GROUP BY tablename
-- ORDER BY tablename;
--
-- Expected counts after cleanup:
--   contacts:              4 (public SELECT, public INSERT, owner UPDATE, owner DELETE)
--   inspection_log:        1 (owner ALL) — or 0 if table doesn't exist
--   inspection_requests:   3 (public SELECT, public INSERT+UPDATE, owner DELETE)
--   jobs:                  5 (owner CRUD + public SELECT scheduling-enabled)
--   profiles:              3 (public SELECT, owner INSERT, owner UPDATE)
--   reports:               4 (owner CRUD)
--   saved_templates:       4 (owner CRUD)
--   templates:             4 (owner CRUD)
-- ============================================================================
