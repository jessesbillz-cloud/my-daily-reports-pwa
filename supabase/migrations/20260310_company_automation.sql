-- ============================================================
-- 20260310_company_automation.sql
-- Company template system automation: profile trigger,
-- enriched company_templates, storage bucket, assign_company fn
-- ============================================================

-- (a) Auto-create profile on signup
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


-- (b) Enrich company_templates with missing fields
ALTER TABLE company_templates ADD COLUMN IF NOT EXISTS structure_map JSONB;
ALTER TABLE company_templates ADD COLUMN IF NOT EXISTS date_format TEXT;
ALTER TABLE company_templates ADD COLUMN IF NOT EXISTS notes_behavior TEXT;
ALTER TABLE company_templates ADD COLUMN IF NOT EXISTS name TEXT;
-- file_type already exists from 20260309 migration


-- (c) Drop legacy duplicate "company" column from profiles
-- (keep company_name + company_id which are the real ones)
ALTER TABLE profiles DROP COLUMN IF EXISTS company;


-- (d) Company-templates storage bucket
INSERT INTO storage.buckets (id, name, public)
VALUES ('company-templates', 'company-templates', false)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS: company members can read files in their company folder
CREATE POLICY "Company members can read company template files"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'company-templates'
    AND (storage.foldername(name))[1] IN (
      SELECT company_id::text FROM profiles WHERE id = auth.uid() AND company_id IS NOT NULL
    )
  );

-- Storage RLS: company creator can upload/manage files
CREATE POLICY "Company creator can manage company template files"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'company-templates'
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM companies WHERE created_by = auth.uid()
    )
  );

CREATE POLICY "Company creator can update company template files"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'company-templates'
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM companies WHERE created_by = auth.uid()
    )
  );

CREATE POLICY "Company creator can delete company template files"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'company-templates'
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM companies WHERE created_by = auth.uid()
    )
  );


-- (e) assign_company: fuzzy match or create, then link profile
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


-- (f) Allow service role / RPC to call assign_company
-- (already SECURITY DEFINER so it runs with owner privileges)

-- (g) Let authenticated users call company-related functions via RPC
GRANT EXECUTE ON FUNCTION public.assign_company(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO postgres;
