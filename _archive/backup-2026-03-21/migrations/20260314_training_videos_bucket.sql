-- Create a public storage bucket for training/marketing videos
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'training-videos',
  'training-videos',
  true,
  104857600,  -- 100MB max file size
  ARRAY['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v']
)
ON CONFLICT (id) DO NOTHING;

-- Allow public read access (anyone can view videos)
CREATE POLICY "Public video read access"
ON storage.objects FOR SELECT
USING (bucket_id = 'training-videos');

-- Allow authenticated users to upload (admin only in practice)
CREATE POLICY "Authenticated video upload"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'training-videos'
  AND auth.role() = 'authenticated'
);

-- Allow authenticated users to delete their uploads
CREATE POLICY "Authenticated video delete"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'training-videos'
  AND auth.role() = 'authenticated'
);
