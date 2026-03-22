-- ─────────────────────────────────────────────────────────────
-- Fix company-templates storage RLS to use COMPANY NAME folders
-- instead of UUID folders.
--
-- NAMING CONVENTION (enforced here and in db.js):
--   Bucket: company-templates
--   Folder: <Company Name>/   (e.g. "TYR Engineering/")
--   Path:   TYR Engineering/TYR_Daily_Report_v5.pdf
--
-- The old policies matched (storage.foldername(name))[1] against
-- companies.id::text (UUID).  Since we use company names as folder
-- names for human-readability and searchability, we now match
-- against companies.name instead.
--
-- Also allows "jobs/" prefix for job-level logos (which don't use
-- company name folders).
-- ─────────────────────────────────────────────────────────────

-- ═══════════════════════════════════════════════════════════════
-- 1. DROP old UUID-based write policies
-- ═══════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "Company creator can manage company template files" ON storage.objects;
DROP POLICY IF EXISTS "Company creator can update company template files" ON storage.objects;
DROP POLICY IF EXISTS "Company creator can delete company template files" ON storage.objects;

-- ═══════════════════════════════════════════════════════════════
-- 2. CREATE new INSERT policy — match folder to company NAME
--    Company creator can upload to their company's name folder
--    OR to the jobs/ folder (for job-level logos).
-- ═══════════════════════════════════════════════════════════════
CREATE POLICY "Company creator can insert company template files"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'company-templates'
    AND (
      -- Folder matches a company name owned by this user
      (storage.foldername(name))[1] IN (
        SELECT name FROM companies WHERE created_by = auth.uid()
      )
      -- OR it's a job-level asset (jobs/<jobId>/...)
      OR (storage.foldername(name))[1] = 'jobs'
    )
  );

-- ═══════════════════════════════════════════════════════════════
-- 3. CREATE new UPDATE policy
-- ═══════════════════════════════════════════════════════════════
CREATE POLICY "Company creator can update company template files"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'company-templates'
    AND (
      (storage.foldername(name))[1] IN (
        SELECT name FROM companies WHERE created_by = auth.uid()
      )
      OR (storage.foldername(name))[1] = 'jobs'
    )
  );

-- ═══════════════════════════════════════════════════════════════
-- 4. CREATE new DELETE policy
-- ═══════════════════════════════════════════════════════════════
CREATE POLICY "Company creator can delete company template files"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'company-templates'
    AND (
      (storage.foldername(name))[1] IN (
        SELECT name FROM companies WHERE created_by = auth.uid()
      )
      OR (storage.foldername(name))[1] = 'jobs'
    )
  );

-- ═══════════════════════════════════════════════════════════════
-- 5. Ensure the read policy for authenticated users still exists
--    (created in 20260321 migration — just a safety check)
-- ═══════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'Authenticated users can read company templates'
      AND tablename = 'objects' AND schemaname = 'storage'
  ) THEN
    CREATE POLICY "Authenticated users can read company templates"
      ON storage.objects FOR SELECT
      USING (
        bucket_id = 'company-templates'
        AND auth.role() = 'authenticated'
      );
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- DONE.  Storage paths now use company names, not UUIDs.
--
-- To verify after running:
--   SELECT policyname, cmd FROM pg_policies
--   WHERE tablename = 'objects' AND schemaname = 'storage'
--     AND policyname LIKE '%company%';
-- ═══════════════════════════════════════════════════════════════
