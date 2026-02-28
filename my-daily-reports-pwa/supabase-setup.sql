-- ============================================================
--  My Daily Reports PWA — Full Backend Setup
--  Run this ONCE in Supabase SQL Editor (SQL → New Query)
-- ============================================================

-- =========================
--  1. JOBS TABLE
-- =========================
CREATE TABLE jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  site_address  TEXT,
  hours_budget  INTEGER,
  report_filename_pattern TEXT,
  export_destination      TEXT,
  template_path           TEXT,
  is_archived   BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "jobs_select" ON jobs FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "jobs_insert" ON jobs FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "jobs_update" ON jobs FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "jobs_delete" ON jobs FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX idx_jobs_user ON jobs(user_id);


-- =========================
--  2. REPORTS TABLE
-- =========================
CREATE TABLE reports (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  job_id              UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  job_name            TEXT,
  report_number       INTEGER,
  report_date         TEXT,
  output_file_name    TEXT,
  status              TEXT NOT NULL DEFAULT 'draft',
  report_data         JSONB,
  working_copy_path   TEXT,
  source_doc_path     TEXT,
  submitted_pdf_path  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "reports_select" ON reports FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "reports_insert" ON reports FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "reports_update" ON reports FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "reports_delete" ON reports FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX idx_reports_user   ON reports(user_id);
CREATE INDEX idx_reports_job    ON reports(job_id);
CREATE INDEX idx_reports_date   ON reports(report_date);
CREATE INDEX idx_reports_lookup ON reports(user_id, job_id, report_date);


-- =========================
--  3. INSPECTION REQUESTS TABLE
-- =========================
CREATE TABLE inspection_requests (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  job_id                UUID REFERENCES jobs(id) ON DELETE CASCADE,
  project               TEXT,
  gc                    TEXT,
  inspection_date       TEXT NOT NULL,
  inspection_time       TEXT NOT NULL,
  flexible_display      TEXT,
  inspection_types      TEXT[] DEFAULT '{}',
  duration              INTEGER,
  submitted_by          TEXT,
  notes                 TEXT,
  inspection_identifier TEXT,
  status                TEXT NOT NULL DEFAULT 'submitted',
  email_recipients      TEXT[] DEFAULT '{}',
  file_urls             TEXT[] DEFAULT '{}',
  action_history        JSONB DEFAULT '[]',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE inspection_requests ENABLE ROW LEVEL SECURITY;

-- Inspection requests: anyone authenticated can read (team visibility)
-- Only creator can update/delete
CREATE POLICY "insp_select" ON inspection_requests FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "insp_insert" ON inspection_requests FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "insp_update" ON inspection_requests FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "insp_delete" ON inspection_requests FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX idx_insp_job    ON inspection_requests(job_id);
CREATE INDEX idx_insp_date   ON inspection_requests(inspection_date);
CREATE INDEX idx_insp_status ON inspection_requests(status);


-- =========================
--  4. TEAM MEMBERS TABLE
--  (per-job configurable — no hardcoded names/emails)
-- =========================
CREATE TABLE team_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  job_id      UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  email       TEXT,
  role        TEXT,
  company     TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "team_select" ON team_members FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "team_insert" ON team_members FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "team_update" ON team_members FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "team_delete" ON team_members FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX idx_team_job ON team_members(job_id);
-- Prevent duplicate names per job
CREATE UNIQUE INDEX idx_team_unique ON team_members(job_id, name, email);


-- =========================
--  5. JOB DEFAULTS TABLE
--  (replaces localStorage JobPDFDefaultsStore — scales across devices)
-- =========================
CREATE TABLE job_defaults (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  default_key     TEXT NOT NULL,
  default_value   TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE job_defaults ENABLE ROW LEVEL SECURITY;

CREATE POLICY "defaults_select" ON job_defaults FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "defaults_insert" ON job_defaults FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "defaults_update" ON job_defaults FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "defaults_delete" ON job_defaults FOR DELETE USING (auth.uid() = user_id);

CREATE UNIQUE INDEX idx_defaults_unique ON job_defaults(user_id, job_id, default_key);


-- =========================
--  6. STORAGE BUCKETS
-- =========================
INSERT INTO storage.buckets (id, name, public) VALUES ('report-working-copies', 'report-working-copies', false);
INSERT INTO storage.buckets (id, name, public) VALUES ('report-source-docs', 'report-source-docs', false);
INSERT INTO storage.buckets (id, name, public) VALUES ('report-submitted', 'report-submitted', false);
INSERT INTO storage.buckets (id, name, public) VALUES ('inspection-files', 'inspection-files', false);

-- Storage RLS: users can only access their own folder
CREATE POLICY "storage_wc_select" ON storage.objects FOR SELECT
  USING (bucket_id = 'report-working-copies' AND (storage.foldername(name))[1] = 'working-copies' AND (storage.foldername(name))[2] = auth.uid()::text);
CREATE POLICY "storage_wc_insert" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'report-working-copies' AND (storage.foldername(name))[1] = 'working-copies' AND (storage.foldername(name))[2] = auth.uid()::text);
CREATE POLICY "storage_wc_update" ON storage.objects FOR UPDATE
  USING (bucket_id = 'report-working-copies' AND (storage.foldername(name))[1] = 'working-copies' AND (storage.foldername(name))[2] = auth.uid()::text);
CREATE POLICY "storage_wc_delete" ON storage.objects FOR DELETE
  USING (bucket_id = 'report-working-copies' AND (storage.foldername(name))[1] = 'working-copies' AND (storage.foldername(name))[2] = auth.uid()::text);

CREATE POLICY "storage_src_select" ON storage.objects FOR SELECT
  USING (bucket_id = 'report-source-docs' AND (storage.foldername(name))[1] = 'source-docs' AND (storage.foldername(name))[2] = auth.uid()::text);
CREATE POLICY "storage_src_insert" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'report-source-docs' AND (storage.foldername(name))[1] = 'source-docs' AND (storage.foldername(name))[2] = auth.uid()::text);
CREATE POLICY "storage_src_update" ON storage.objects FOR UPDATE
  USING (bucket_id = 'report-source-docs' AND (storage.foldername(name))[1] = 'source-docs' AND (storage.foldername(name))[2] = auth.uid()::text);
CREATE POLICY "storage_src_delete" ON storage.objects FOR DELETE
  USING (bucket_id = 'report-source-docs' AND (storage.foldername(name))[1] = 'source-docs' AND (storage.foldername(name))[2] = auth.uid()::text);

CREATE POLICY "storage_sub_select" ON storage.objects FOR SELECT
  USING (bucket_id = 'report-submitted' AND (storage.foldername(name))[1] = 'submitted' AND (storage.foldername(name))[2] = auth.uid()::text);
CREATE POLICY "storage_sub_insert" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'report-submitted' AND (storage.foldername(name))[1] = 'submitted' AND (storage.foldername(name))[2] = auth.uid()::text);
CREATE POLICY "storage_sub_update" ON storage.objects FOR UPDATE
  USING (bucket_id = 'report-submitted' AND (storage.foldername(name))[1] = 'submitted' AND (storage.foldername(name))[2] = auth.uid()::text);
CREATE POLICY "storage_sub_delete" ON storage.objects FOR DELETE
  USING (bucket_id = 'report-submitted' AND (storage.foldername(name))[1] = 'submitted' AND (storage.foldername(name))[2] = auth.uid()::text);

CREATE POLICY "storage_insp_select" ON storage.objects FOR SELECT
  USING (bucket_id = 'inspection-files' AND auth.role() = 'authenticated');
CREATE POLICY "storage_insp_insert" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'inspection-files' AND auth.role() = 'authenticated');


-- =========================
--  7. AUTO-UPDATE TIMESTAMPS
-- =========================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER jobs_updated_at BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER reports_updated_at BEFORE UPDATE ON reports
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER inspection_requests_updated_at BEFORE UPDATE ON inspection_requests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER job_defaults_updated_at BEFORE UPDATE ON job_defaults
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ============================================================
--  DONE. Tables: jobs, reports, inspection_requests,
--        team_members, job_defaults
--  Storage: report-working-copies, report-source-docs,
--           report-submitted, inspection-files
-- ============================================================
