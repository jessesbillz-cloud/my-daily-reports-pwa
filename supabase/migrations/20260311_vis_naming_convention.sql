-- Add VIS naming convention to company template
-- Pattern: DR_45_Woodland_Park_2026-03-07
-- {report_number} = auto-increment, {project} = job name, {date} = YYYY-MM-DD

UPDATE company_templates
SET field_config = '[{"_type":"filenameConvention","pattern":"DR_{report_number}_{project}_{date}","dateFormat":"YYYY-MM-DD","numberPadding":0}]'::jsonb
WHERE id = 'b0000000-0000-0000-0000-000000000001';
