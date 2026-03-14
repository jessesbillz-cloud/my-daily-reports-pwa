-- Bump storage bucket file size limits for scale (250+ users, high-res phone photos)
-- inspection-files: 10MB → 25MB (phone photos can be 5-15MB)
-- report-source-docs: 10MB → 50MB (large PDF/DOCX templates)
-- report-working-copies: 25MB → 50MB (reports with embedded photos)

UPDATE storage.buckets SET file_size_limit = 26214400   -- 25 MB
WHERE id = 'inspection-files' AND file_size_limit < 26214400;

UPDATE storage.buckets SET file_size_limit = 52428800   -- 50 MB
WHERE id = 'report-source-docs' AND file_size_limit < 52428800;

UPDATE storage.buckets SET file_size_limit = 52428800   -- 50 MB
WHERE id = 'report-working-copies' AND file_size_limit < 52428800;
