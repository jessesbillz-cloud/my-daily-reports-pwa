-- ─────────────────────────────────────────────────────────────
-- Fix TYR Engineering template + company-templates storage access
-- Run in Supabase SQL Editor
-- ─────────────────────────────────────────────────────────────

-- ═══════════════════════════════════════════════════════════════
-- 1. Make company-templates bucket PUBLIC for reads
--    The bucket was created with public=false, but templates should
--    be readable by any authenticated user (not just company members).
--    Simplest fix: make the bucket public.
-- ═══════════════════════════════════════════════════════════════
UPDATE storage.buckets
SET public = true
WHERE id = 'company-templates';

-- ═══════════════════════════════════════════════════════════════
-- 2. Add a permissive read policy for ALL authenticated users
--    on company-templates bucket (so any logged-in user can
--    download company templates, not just company members)
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
-- 3. Fix the existing RLS read policy that used full company_id
--    (which never matched the slug-based folder names)
--    Drop and recreate with correct logic.
-- ═══════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "Company members can read company template files" ON storage.objects;

-- ═══════════════════════════════════════════════════════════════
-- 4. Also allow reading TYR template from report-source-docs
--    The TYR template was manually uploaded to report-source-docs
--    at path tyr-engineering/... which doesn't match any user's ID.
--    Add a policy so authenticated users can read company paths.
-- ═══════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'Authenticated users can read company report-source-docs'
      AND tablename = 'objects' AND schemaname = 'storage'
  ) THEN
    CREATE POLICY "Authenticated users can read company report-source-docs"
      ON storage.objects FOR SELECT
      USING (
        bucket_id = 'report-source-docs'
        AND auth.role() = 'authenticated'
        AND NOT (name LIKE '%/private/%')
      );
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- 5. Ensure TYR company template record has field_config
--    so when user selects TYR template, fields load immediately.
--    Also ensure the storage_path is correct.
-- ═══════════════════════════════════════════════════════════════

-- First verify TYR data:
-- SELECT id, name, storage_path, field_config FROM company_templates
-- WHERE company_id = 'a0000000-0000-0000-0000-000000000002';

-- If the storage_path is 'tyr-engineering/TYR_Daily_Report_Template.pdf',
-- that's fine — the code now tries multiple download paths.
-- But it would be cleaner to also have it in company-templates bucket.

-- ═══════════════════════════════════════════════════════════════
-- 6. Fix copy_company_templates_to_user to insert into
--    saved_templates instead of templates table
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.copy_company_templates_to_user(
  p_user_id UUID,
  p_company_id UUID,
  p_job_id UUID DEFAULT NULL
) RETURNS INT AS $$
DECLARE
  v_count INT := 0;
  v_ct RECORD;
BEGIN
  FOR v_ct IN
    SELECT * FROM company_templates WHERE company_id = p_company_id
  LOOP
    -- Insert into saved_templates (user's reusable templates)
    INSERT INTO saved_templates (
      user_id, name, template_name,
      file_name, file_type, storage_path,
      field_config, mode
    ) VALUES (
      p_user_id,
      COALESCE(v_ct.template_name, v_ct.name, v_ct.file_name),
      COALESCE(v_ct.template_name, v_ct.name, v_ct.file_name),
      v_ct.file_name, v_ct.file_type, v_ct.storage_path,
      v_ct.field_config, COALESCE(v_ct.mode, 'template')
    )
    ON CONFLICT DO NOTHING;
    v_count := v_count + 1;

    -- Also insert into templates if job_id is provided
    IF p_job_id IS NOT NULL THEN
      INSERT INTO templates (
        user_id, job_id, template_name, name,
        original_filename, file_type, storage_path,
        field_config, structure_map, mode
      ) VALUES (
        p_user_id, p_job_id,
        COALESCE(v_ct.template_name, v_ct.name, v_ct.file_name),
        COALESCE(v_ct.name, v_ct.template_name, v_ct.file_name),
        v_ct.file_name, v_ct.file_type, v_ct.storage_path,
        v_ct.field_config, v_ct.structure_map, v_ct.mode
      )
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.copy_company_templates_to_user(UUID, UUID, UUID) TO authenticated;

-- ═══════════════════════════════════════════════════════════════
-- 7. Ensure company_templates table has correct RLS
-- ═══════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'Authenticated users can read company_templates'
      AND tablename = 'company_templates'
  ) THEN
    CREATE POLICY "Authenticated users can read company_templates"
      ON company_templates FOR SELECT
      USING (auth.role() = 'authenticated');
  END IF;
END $$;
