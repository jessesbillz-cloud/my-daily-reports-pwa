ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_path text;

CREATE POLICY "Anyone can read company logos"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'company-logos');

INSERT INTO storage.buckets (id, name, public)
VALUES ('company-logos', 'company-logos', true)
ON CONFLICT (id) DO UPDATE SET public = true;
