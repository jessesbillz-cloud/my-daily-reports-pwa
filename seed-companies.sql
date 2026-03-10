-- ============================================================
-- seed-companies.sql
-- Seed 3 test companies for template system testing
-- Run after 20260310_company_automation.sql migration
-- ============================================================

-- VIS (Verified Inspection Services)
INSERT INTO companies (id, name, created_by)
VALUES (
  'a0000000-0000-0000-0000-000000000001',
  'VIS - Verified Inspection Services',
  NULL
)
ON CONFLICT (id) DO NOTHING;

-- TYR (TYR Engineering)
INSERT INTO companies (id, name, created_by)
VALUES (
  'a0000000-0000-0000-0000-000000000002',
  'TYR Engineering',
  NULL
)
ON CONFLICT (id) DO NOTHING;

-- IVC Auto Tech (from the uploaded Raken template)
INSERT INTO companies (id, name, created_by)
VALUES (
  'a0000000-0000-0000-0000-000000000003',
  'IVC Auto Tech',
  NULL
)
ON CONFLICT (id) DO NOTHING;

-- Note: Company templates will be added via admin.html once PDFs are uploaded.
-- Each company_templates row links to a parsed field_config and a storage_path
-- in the company-templates bucket under {company_id}/{filename}.
