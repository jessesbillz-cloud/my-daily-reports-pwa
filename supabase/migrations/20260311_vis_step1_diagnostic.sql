SELECT name, bucket_id, created_at
FROM storage.objects
WHERE bucket_id = 'company-templates';
