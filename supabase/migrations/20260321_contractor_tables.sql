-- ============================================================
-- TYR Daily Report v3: Contractor Management Tables
-- ============================================================

-- 1. job_contractors — master list of contractors assigned to a job
CREATE TABLE IF NOT EXISTS job_contractors (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_name text NOT NULL,
  trade text,
  sort_order int DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  UNIQUE(job_id, company_name)
);

-- RLS
ALTER TABLE job_contractors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own job contractors"
  ON job_contractors FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- 2. report_contractors — contractors selected for a specific daily report
CREATE TABLE IF NOT EXISTS report_contractors (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contractor_name text NOT NULL,
  manpower integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- RLS
ALTER TABLE report_contractors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own report contractors"
  ON report_contractors FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_job_contractors_job_id ON job_contractors(job_id);
CREATE INDEX IF NOT EXISTS idx_report_contractors_report_id ON report_contractors(report_id);
CREATE INDEX IF NOT EXISTS idx_report_contractors_job_id ON report_contractors(job_id);
