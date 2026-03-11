-- ─────────────────────────────────────────────────────────────
-- Save IVC Auto Tech work log template as a company template
-- Run in Supabase SQL Editor after confirming the company_id
-- ─────────────────────────────────────────────────────────────

-- Step 1: Find IVC Auto Tech company ID
-- SELECT id, name FROM companies WHERE name_lower LIKE '%ivc%';

-- Step 2: Insert company template for IVC Auto Tech
-- Uses the template already uploaded by Jesse for the IVC AUTO job
INSERT INTO company_templates (
  company_id,
  name,
  template_name,
  file_name,
  file_type,
  mode,
  notes_behavior
)
SELECT
  c.id,
  'IVC Auto Tech Daily Report',
  'IVC Auto Tech Daily Report',
  'ivc-auto-tech-daily-report.pdf',
  'pdf',
  'template',
  'append'
FROM companies c
WHERE c.name_lower LIKE '%ivc%'
ON CONFLICT DO NOTHING;
