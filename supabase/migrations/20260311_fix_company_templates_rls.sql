-- Fix: company-templates bucket SELECT policy
-- The old policy only lets company MEMBERS read files.
-- Company CREATORS (who uploaded the files) also need read access.
-- This caused a 400 error when downloading company template PDFs.

DROP POLICY IF EXISTS "Company members can read company template files" ON storage.objects;

CREATE POLICY "Company members can read company template files"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'company-templates'
    AND (storage.foldername(name))[1] IN (
      SELECT company_id::text FROM profiles WHERE id = auth.uid() AND company_id IS NOT NULL
      UNION
      SELECT id::text FROM companies WHERE created_by = auth.uid()
    )
  );
