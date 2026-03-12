-- Update template record to point to the actual file in storage
-- Replace the filename below if Step 1 showed a different name
UPDATE company_templates
SET
  storage_path = 'company-templates/DR_number_project_Feb 27_2026.pdf',
  field_config = NULL,
  original_filename = 'DR_number_project_Feb 27_2026.pdf',
  file_type = 'pdf'
WHERE id = 'b0000000-0000-0000-0000-000000000001';
