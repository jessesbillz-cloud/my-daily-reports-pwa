-- STEP 2: Fix RLS policy so company creators can read ANY file in company-templates bucket
-- This is broader than folder-only matching so root-level files also work
DROP POLICY IF EXISTS "Company members can read company template files" ON storage.objects;

CREATE POLICY "Company members can read company template files"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'company-templates'
    AND (
      (storage.foldername(name))[1] IN (
        SELECT company_id::text FROM profiles WHERE id = auth.uid() AND company_id IS NOT NULL
        UNION
        SELECT id::text FROM companies WHERE created_by = auth.uid()
      )
      OR
      EXISTS (SELECT 1 FROM companies WHERE created_by = auth.uid())
    )
  );
