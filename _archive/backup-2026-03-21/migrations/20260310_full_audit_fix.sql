-- ============================================================
-- 20260310_full_audit_fix.sql
-- Consolidated migration addressing ALL remaining audit gaps.
-- Safe to run even if parts already exist (idempotent).
-- Paste this entire block into Supabase SQL Editor and run.
-- ============================================================


-- ─────────────────────────────────────────────────────────────
-- 1. handle_new_user trigger on auth.users  [CRITICAL]
--    Auto-creates a profiles row when someone signs up.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, slug, setup_complete)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    NEW.id::text,
    false
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ─────────────────────────────────────────────────────────────
-- 2. assign_company function  [CRITICAL]
--    Exact match → fuzzy match → create new → link to profile.
--    Uses the name_lower generated column on companies.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.assign_company(
  p_user_id UUID,
  p_company_name TEXT
) RETURNS UUID AS $$
DECLARE
  v_company_id UUID;
BEGIN
  -- Exact match first
  SELECT id INTO v_company_id FROM companies
    WHERE name_lower = lower(trim(p_company_name)) LIMIT 1;

  -- Fuzzy match if no exact
  IF v_company_id IS NULL THEN
    SELECT id INTO v_company_id FROM companies
      WHERE name_lower ILIKE '%' || lower(trim(p_company_name)) || '%' LIMIT 1;
  END IF;

  -- Create new if not found
  IF v_company_id IS NULL THEN
    INSERT INTO companies (name, created_by)
      VALUES (trim(p_company_name), p_user_id)
      RETURNING id INTO v_company_id;
  END IF;

  -- Update profile
  UPDATE profiles
    SET company_id = v_company_id, company_name = trim(p_company_name)
    WHERE id = p_user_id;

  RETURN v_company_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.assign_company(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO postgres;


-- ─────────────────────────────────────────────────────────────
-- 3. Drop legacy duplicate "company" column from profiles
--    Keep company_name (user's business name) + company_id (FK)
-- ─────────────────────────────────────────────────────────────
ALTER TABLE profiles DROP COLUMN IF EXISTS company;


-- ─────────────────────────────────────────────────────────────
-- 4. Enrich company_templates schema
--    Actual table has: id, company_id, original_filename, storage_path,
--    field_config, created_at. Add everything else it needs.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE company_templates ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE company_templates ADD COLUMN IF NOT EXISTS template_name TEXT;
ALTER TABLE company_templates ADD COLUMN IF NOT EXISTS file_name TEXT;
ALTER TABLE company_templates ADD COLUMN IF NOT EXISTS file_type TEXT;
ALTER TABLE company_templates ADD COLUMN IF NOT EXISTS mode TEXT DEFAULT 'template';
ALTER TABLE company_templates ADD COLUMN IF NOT EXISTS structure_map JSONB;
ALTER TABLE company_templates ADD COLUMN IF NOT EXISTS date_format TEXT;
ALTER TABLE company_templates ADD COLUMN IF NOT EXISTS notes_behavior TEXT;


-- ─────────────────────────────────────────────────────────────
-- 5. Seed one test company_template for VIS
--    Uses the fixed VIS UUID from seed-companies.sql.
--    Only uses columns guaranteed to exist after section 4.
-- ─────────────────────────────────────────────────────────────
INSERT INTO company_templates (
  id, company_id, original_filename, name, file_type, mode, field_config
) VALUES (
  'b0000000-0000-0000-0000-000000000001',
  'a0000000-0000-0000-0000-000000000001',  -- VIS
  'vis-daily-report.pdf',
  'VIS Standard Daily Report',
  'pdf',
  'template',
  '[
    {"label":"Project Name","type":"text","key":"project_name"},
    {"label":"Date","type":"date","key":"date"},
    {"label":"Inspector","type":"text","key":"inspector"},
    {"label":"Weather","type":"text","key":"weather"},
    {"label":"Temperature","type":"text","key":"temperature"},
    {"label":"Work Performed","type":"textarea","key":"work_performed"},
    {"label":"Materials Used","type":"textarea","key":"materials_used"},
    {"label":"Visitors on Site","type":"textarea","key":"visitors"},
    {"label":"Safety Notes","type":"textarea","key":"safety_notes"},
    {"label":"Comments","type":"textarea","key":"comments"}
  ]'::jsonb
) ON CONFLICT (id) DO NOTHING;


-- ─────────────────────────────────────────────────────────────
-- 6. copy_company_templates_to_user function  [GLUE LOGIC]
--    DB-level function to copy all templates from a company
--    into a user's personal templates table for a given job.
-- ─────────────────────────────────────────────────────────────
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
    INSERT INTO templates (
      user_id, job_id, template_name, name,
      original_filename, file_type, storage_path,
      field_config, structure_map, mode
    ) VALUES (
      p_user_id, p_job_id,
      COALESCE(v_ct.template_name, v_ct.name, v_ct.original_filename),
      COALESCE(v_ct.name, v_ct.template_name, v_ct.original_filename),
      v_ct.original_filename, v_ct.file_type, v_ct.storage_path,
      v_ct.field_config, v_ct.structure_map, v_ct.mode
    )
    ON CONFLICT DO NOTHING;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.copy_company_templates_to_user(UUID, UUID, UUID) TO authenticated;


-- ─────────────────────────────────────────────────────────────
-- 7. company-templates storage bucket + RLS
-- ─────────────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('company-templates', 'company-templates', false)
ON CONFLICT (id) DO NOTHING;

-- Read: company members can read files in their company folder
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'Company members can read company template files'
      AND tablename = 'objects' AND schemaname = 'storage'
  ) THEN
    CREATE POLICY "Company members can read company template files"
      ON storage.objects FOR SELECT
      USING (
        bucket_id = 'company-templates'
        AND (storage.foldername(name))[1] IN (
          SELECT company_id::text FROM profiles WHERE id = auth.uid() AND company_id IS NOT NULL
        )
      );
  END IF;
END $$;

-- Insert: company creator can upload files
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'Company creator can manage company template files'
      AND tablename = 'objects' AND schemaname = 'storage'
  ) THEN
    CREATE POLICY "Company creator can manage company template files"
      ON storage.objects FOR INSERT
      WITH CHECK (
        bucket_id = 'company-templates'
        AND (storage.foldername(name))[1] IN (
          SELECT id::text FROM companies WHERE created_by = auth.uid()
        )
      );
  END IF;
END $$;

-- Update: company creator can update files
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'Company creator can update company template files'
      AND tablename = 'objects' AND schemaname = 'storage'
  ) THEN
    CREATE POLICY "Company creator can update company template files"
      ON storage.objects FOR UPDATE
      USING (
        bucket_id = 'company-templates'
        AND (storage.foldername(name))[1] IN (
          SELECT id::text FROM companies WHERE created_by = auth.uid()
        )
      );
  END IF;
END $$;

-- Delete: company creator can delete files
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'Company creator can delete company template files'
      AND tablename = 'objects' AND schemaname = 'storage'
  ) THEN
    CREATE POLICY "Company creator can delete company template files"
      ON storage.objects FOR DELETE
      USING (
        bucket_id = 'company-templates'
        AND (storage.foldername(name))[1] IN (
          SELECT id::text FROM companies WHERE created_by = auth.uid()
        )
      );
  END IF;
END $$;


-- ─────────────────────────────────────────────────────────────
-- 8. company_id on jobs (if not already added)
-- ─────────────────────────────────────────────────────────────
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);


-- ─────────────────────────────────────────────────────────────
-- Done. Summary of what this migration does:
-- ─────────────────────────────────────────────────────────────
-- ✅ 1. handle_new_user trigger on auth.users
-- ✅ 2. assign_company(user_id, company_name) function
-- ✅ 3. Dropped legacy "company" column from profiles
-- ✅ 4. Enriched company_templates with name, structure_map, date_format, notes_behavior
-- ✅ 5. Seeded 1 test company_template (VIS Standard Daily Report)
-- ✅ 6. copy_company_templates_to_user() DB function (glue logic)
-- ✅ 7. company-templates storage bucket + 4 RLS policies
-- ✅ 8. company_id on jobs table
