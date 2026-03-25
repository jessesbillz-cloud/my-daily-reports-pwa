-- ─────────────────────────────────────────────────────────────
-- Assign all existing profiles to their companies
-- Run AFTER 20260310_full_audit_fix.sql (needs assign_company function)
-- ─────────────────────────────────────────────────────────────

-- Step 1: Fix seed data — populate template_name where NULL
UPDATE company_templates
SET template_name = name
WHERE template_name IS NULL AND name IS NOT NULL;

-- Step 2: Assign each profile to VIS
-- (All 4 current users belong to VIS - Vital Inspection Services)
-- This calls assign_company() which does lookup-or-create + links profile
DO $$
DECLARE
  v_profile RECORD;
  v_company_id UUID;
BEGIN
  FOR v_profile IN
    SELECT id, full_name FROM profiles WHERE company_id IS NULL
  LOOP
    v_company_id := assign_company(v_profile.id, 'VIS - Vital Inspection Services');
    RAISE NOTICE 'Assigned % (%) to company %', v_profile.full_name, v_profile.id, v_company_id;
  END LOOP;
END $$;

-- Step 3: Verify assignments
-- (Run this SELECT after to confirm — should show company_id and company_name for all profiles)
-- SELECT id, full_name, company_name, company_id FROM profiles;
