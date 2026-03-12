-- =====================================================
-- COMPANY ROLE SYSTEM — Run in Supabase SQL Editor
-- =====================================================

-- 1. Add company_role column to profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS company_role text NOT NULL DEFAULT 'member';

-- 2. Block users from changing their own company_role via REST API
--    Drop existing update policy first if any, then create restrictive one
DROP POLICY IF EXISTS "Users can update own profile" ON profiles;

CREATE POLICY "Users can update own profile except role"
  ON profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (
    auth.uid() = id
    AND (
      company_role = (SELECT company_role FROM profiles WHERE id = auth.uid())
    )
  );

-- 3. Update assign_company to set role: creator = admin, joiner = member
CREATE OR REPLACE FUNCTION assign_company(p_user_id uuid, p_company_name text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_company_id uuid;
  v_is_new boolean := false;
BEGIN
  -- Try exact match first
  SELECT id INTO v_company_id
  FROM companies
  WHERE lower(trim(name)) = lower(trim(p_company_name))
  LIMIT 1;

  -- If no exact match, try fuzzy match
  IF v_company_id IS NULL THEN
    SELECT id INTO v_company_id
    FROM companies
    WHERE lower(trim(name)) ILIKE '%' || lower(trim(p_company_name)) || '%'
       OR lower(trim(p_company_name)) ILIKE '%' || lower(trim(name)) || '%'
    LIMIT 1;
  END IF;

  -- If still no match, create new company — this user is the creator/admin
  IF v_company_id IS NULL THEN
    INSERT INTO companies (name, created_by)
    VALUES (trim(p_company_name), p_user_id)
    RETURNING id INTO v_company_id;
    v_is_new := true;
  END IF;

  -- Update profile: set company_id and role
  -- Creator gets admin, everyone else gets member
  UPDATE profiles
  SET company_id = v_company_id,
      company_name = trim(p_company_name),
      company_role = CASE
        WHEN v_is_new THEN 'admin'
        WHEN (SELECT created_by FROM companies WHERE id = v_company_id) = p_user_id THEN 'admin'
        ELSE 'member'
      END
  WHERE id = p_user_id;

  RETURN v_company_id;
END;
$$;

-- 4. Company template RLS — admin-only write, any member can read
DROP POLICY IF EXISTS "Company admins can insert company_templates" ON company_templates;
DROP POLICY IF EXISTS "Company admins can update company_templates" ON company_templates;
DROP POLICY IF EXISTS "Company admins can delete company_templates" ON company_templates;
DROP POLICY IF EXISTS "Company members can read company_templates" ON company_templates;

CREATE POLICY "Company admins can insert company_templates"
  ON company_templates FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.company_id = company_templates.company_id
        AND profiles.company_role = 'admin'
    )
  );

CREATE POLICY "Company admins can update company_templates"
  ON company_templates FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.company_id = company_templates.company_id
        AND profiles.company_role = 'admin'
    )
  );

CREATE POLICY "Company admins can delete company_templates"
  ON company_templates FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.company_id = company_templates.company_id
        AND profiles.company_role = 'admin'
    )
  );

CREATE POLICY "Company members can read company_templates"
  ON company_templates FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.company_id = company_templates.company_id
    )
  );
