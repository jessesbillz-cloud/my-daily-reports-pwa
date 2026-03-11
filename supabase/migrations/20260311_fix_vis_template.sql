-- Fix VIS company template: clear bad field_config, set storage_path
-- The actual PDF file must be uploaded to company-templates bucket FIRST
-- Folder must match VIS company UUID for RLS policy to allow reads
-- Upload path: company-templates/a0000000-0000-0000-0000-000000000001/vis-daily-report.pdf

UPDATE company_templates
SET
  storage_path = 'company-templates/a0000000-0000-0000-0000-000000000001/vis-daily-report.pdf',
  field_config = NULL,
  original_filename = 'vis-daily-report.pdf',
  file_type = 'pdf'
WHERE id = 'b0000000-0000-0000-0000-000000000001';
