-- Add company_role to profiles
-- Values: 'admin' (can manage company templates/settings), 'member' (default, can only use company templates)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS company_role text NOT NULL DEFAULT 'member';

-- Restrict company_templates INSERT/UPDATE/DELETE to company admins only
-- (Users with company_role = 'admin' and matching company_id)
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

-- All authenticated users in the company can SELECT (read) company templates
CREATE POLICY "Company members can read company_templates"
  ON company_templates FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.company_id = company_templates.company_id
    )
  );
