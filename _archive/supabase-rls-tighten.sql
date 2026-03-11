-- RLS Tightening Migration
-- Run in: Supabase Dashboard → SQL Editor → New Query → paste → Run
--
-- Goals:
-- 1. Profiles: public can only read id, full_name, slug (RLS can't column-restrict,
--    but the select queries in schedule.html already specify columns — acceptable risk)
-- 2. Jobs: public can only see scheduling-enabled non-archived jobs (already correct)
-- 3. Inspection requests: public can INSERT and SELECT confirmed requests for calendar dots,
--    but only the inspector (auth user) can update/delete
-- 4. Contacts: tighten from fully public to auth-only
-- 5. inspection_log: add basic owner policy so it's usable

-- ============================================================================
-- STEP 1: Fix inspection_requests — allow public to read confirmed dates
--         (needed for green calendar dots on schedule.html)
-- ============================================================================

-- First check what public-facing SELECT policies exist and drop them
DO $$ BEGIN
  -- Drop any overly broad public select policy
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename='inspection_requests' AND policyname='Public can read inspection requests') THEN
    DROP POLICY "Public can read inspection requests" ON inspection_requests;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename='inspection_requests' AND policyname='insp_select') THEN
    DROP POLICY "insp_select" ON inspection_requests;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename='inspection_requests' AND policyname='Public can select inspection requests') THEN
    DROP POLICY "Public can select inspection requests" ON inspection_requests;
  END IF;
END $$;

-- Scoped public SELECT: anon users can only see confirmed requests (for calendar dots)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='inspection_requests' AND policyname='Public can view confirmed requests') THEN
    CREATE POLICY "Public can view confirmed requests" ON inspection_requests
      FOR SELECT USING (status = 'confirmed');
  END IF;
END $$;

-- Owner SELECT stays (users see all their own requests regardless of status)
-- Already exists: "Users can select their own inspection requests"

-- ============================================================================
-- STEP 2: Tighten inspection_requests INSERT — require valid user_id reference
-- ============================================================================

-- Drop overly broad insert
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename='inspection_requests' AND policyname='Public can insert inspection requests') THEN
    DROP POLICY "Public can insert inspection requests" ON inspection_requests;
  END IF;
END $$;

-- New INSERT: require that the user_id in the request matches an actual profile
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='inspection_requests' AND policyname='Public can submit requests to real users') THEN
    CREATE POLICY "Public can submit requests to real users" ON inspection_requests
      FOR INSERT WITH CHECK (
        user_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM profiles WHERE profiles.id = user_id)
      );
  END IF;
END $$;

-- ============================================================================
-- STEP 3: Tighten contacts table
-- ============================================================================

-- Drop any fully public select/insert
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename='contacts' AND policyname='contacts_public') THEN
    DROP POLICY "contacts_public" ON contacts;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename='contacts' AND policyname='contacts_public_select') THEN
    DROP POLICY "contacts_public_select" ON contacts;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename='contacts' AND policyname='contacts_public_insert') THEN
    DROP POLICY "contacts_public_insert" ON contacts;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename='contacts' AND policyname='Public can read contacts') THEN
    DROP POLICY "Public can read contacts" ON contacts;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename='contacts' AND policyname='Public can insert contacts') THEN
    DROP POLICY "Public can insert contacts" ON contacts;
  END IF;
END $$;

-- Contacts should only be accessible by the job owner
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='contacts' AND policyname='Users can manage their own contacts') THEN
    CREATE POLICY "Users can manage their own contacts" ON contacts
      FOR ALL USING (
        auth.uid() = user_id
        OR (job_id IS NOT NULL AND EXISTS (SELECT 1 FROM jobs WHERE jobs.id = job_id AND jobs.user_id = auth.uid()))
      );
  END IF;
END $$;

-- ============================================================================
-- STEP 4: Restrict profiles SELECT — only expose needed fields via app queries
-- (RLS can't column-restrict, but we limit what the public schedule page queries)
-- Keep as-is since schedule.html needs to look up by slug
-- ============================================================================

-- No changes needed — profiles SELECT USING (TRUE) is required for slug lookup
-- The app already only queries: id, full_name, slug

-- ============================================================================
-- STEP 5: Verify inspection_requests UPDATE is owner-only
-- ============================================================================

-- Drop any public update policy
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename='inspection_requests' AND policyname='Public can update inspection requests') THEN
    DROP POLICY "Public can update inspection requests" ON inspection_requests;
  END IF;
END $$;

-- Owner UPDATE should already exist. Verify:
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='inspection_requests' AND policyname='Users can update their own inspection requests') THEN
    CREATE POLICY "Users can update their own inspection requests" ON inspection_requests
      FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

-- ============================================================================
-- DONE — Verify with:
-- SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual
-- FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, cmd;
-- ============================================================================
