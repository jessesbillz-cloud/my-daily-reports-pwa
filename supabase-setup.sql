-- My Daily Reports PWA — Supabase Schema Setup
-- Safe to run multiple times — uses IF NOT EXISTS and DO blocks everywhere
-- Run this entire file in: Supabase Dashboard → SQL Editor → New Query → Run

-- ============================================================================
-- SECTION 1: CREATE TABLES (if they don't exist yet)
-- ============================================================================

CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT,
  slug TEXT UNIQUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inspection_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- SECTION 2: ADD ALL COLUMNS (safe — skips if column already exists)
-- ============================================================================

-- ── profiles ──
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS slug TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'UTC';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS setup_complete BOOLEAN DEFAULT FALSE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS wizard_completed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS team_emails TEXT[] DEFAULT '{}';

-- Add unique constraint on slug if not exists
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_slug_key') THEN
    ALTER TABLE profiles ADD CONSTRAINT profiles_slug_key UNIQUE (slug);
  END IF;
END $$;

-- ── jobs ──
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS site_address TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS report_filename_pattern TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS schedule TEXT DEFAULT 'as_needed';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS schedule_days TEXT[] DEFAULT '{}';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS reminder_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS reminder_time TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS reminder_hours_before INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS scheduling_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS field_config JSONB DEFAULT '{"editable": [], "locked": []}';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS team_emails TEXT[] DEFAULT '{}';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- ── templates ──
ALTER TABLE templates ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS job_id UUID REFERENCES jobs(id) ON DELETE CASCADE;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS original_filename TEXT;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS file_type TEXT;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS storage_path TEXT;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS field_config JSONB DEFAULT '[]';
ALTER TABLE templates ADD COLUMN IF NOT EXISTS structure_map JSONB;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- ── reports ──
ALTER TABLE reports ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS job_id UUID REFERENCES jobs(id) ON DELETE CASCADE;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS report_date DATE;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS report_number INTEGER;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'working_copy';
ALTER TABLE reports ADD COLUMN IF NOT EXISTS content JSONB DEFAULT '{}';
ALTER TABLE reports ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- ── inspection_requests ──
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS job_id UUID REFERENCES jobs(id) ON DELETE CASCADE;
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS requested_date DATE;
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS requester_name TEXT;
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS requester_email TEXT;
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS requester_company TEXT;
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS inspection_type TEXT;
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- ============================================================================
-- SECTION 3: INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS jobs_user_id_idx ON jobs(user_id);
CREATE INDEX IF NOT EXISTS jobs_scheduling_enabled_idx ON jobs(scheduling_enabled);
CREATE INDEX IF NOT EXISTS jobs_is_archived_idx ON jobs(is_archived);
CREATE INDEX IF NOT EXISTS templates_user_id_idx ON templates(user_id);
CREATE INDEX IF NOT EXISTS templates_job_id_idx ON templates(job_id);
CREATE INDEX IF NOT EXISTS reports_user_id_idx ON reports(user_id);
CREATE INDEX IF NOT EXISTS reports_job_id_idx ON reports(job_id);
CREATE INDEX IF NOT EXISTS reports_report_date_idx ON reports(report_date);
CREATE INDEX IF NOT EXISTS inspection_requests_user_id_idx ON inspection_requests(user_id);
CREATE INDEX IF NOT EXISTS inspection_requests_job_id_idx ON inspection_requests(job_id);
CREATE INDEX IF NOT EXISTS inspection_requests_requested_date_idx ON inspection_requests(requested_date);

-- ============================================================================
-- SECTION 4: ENABLE ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection_requests ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- SECTION 5: RLS POLICIES (uses DO blocks to skip if already exists)
-- ============================================================================

-- ── profiles ──
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Profiles are publicly readable' AND tablename = 'profiles') THEN
    CREATE POLICY "Profiles are publicly readable" ON profiles FOR SELECT USING (TRUE);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can update their own profile' AND tablename = 'profiles') THEN
    CREATE POLICY "Users can update their own profile" ON profiles FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can insert their own profile' AND tablename = 'profiles') THEN
    CREATE POLICY "Users can insert their own profile" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);
  END IF;
END $$;

-- ── jobs ──
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can select their own jobs' AND tablename = 'jobs') THEN
    CREATE POLICY "Users can select their own jobs" ON jobs FOR SELECT USING (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can insert their own jobs' AND tablename = 'jobs') THEN
    CREATE POLICY "Users can insert their own jobs" ON jobs FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can update their own jobs' AND tablename = 'jobs') THEN
    CREATE POLICY "Users can update their own jobs" ON jobs FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can delete their own jobs' AND tablename = 'jobs') THEN
    CREATE POLICY "Users can delete their own jobs" ON jobs FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Public can view scheduling-enabled jobs' AND tablename = 'jobs') THEN
    CREATE POLICY "Public can view scheduling-enabled jobs" ON jobs FOR SELECT USING (scheduling_enabled = TRUE AND is_archived = FALSE);
  END IF;
END $$;

-- ── templates ──
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can select their own templates' AND tablename = 'templates') THEN
    CREATE POLICY "Users can select their own templates" ON templates FOR SELECT USING (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can insert their own templates' AND tablename = 'templates') THEN
    CREATE POLICY "Users can insert their own templates" ON templates FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can update their own templates' AND tablename = 'templates') THEN
    CREATE POLICY "Users can update their own templates" ON templates FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can delete their own templates' AND tablename = 'templates') THEN
    CREATE POLICY "Users can delete their own templates" ON templates FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;

-- ── reports ──
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can select their own reports' AND tablename = 'reports') THEN
    CREATE POLICY "Users can select their own reports" ON reports FOR SELECT USING (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can insert their own reports' AND tablename = 'reports') THEN
    CREATE POLICY "Users can insert their own reports" ON reports FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can update their own reports' AND tablename = 'reports') THEN
    CREATE POLICY "Users can update their own reports" ON reports FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can delete their own reports' AND tablename = 'reports') THEN
    CREATE POLICY "Users can delete their own reports" ON reports FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;

-- ── inspection_requests ──
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can select their own inspection requests' AND tablename = 'inspection_requests') THEN
    CREATE POLICY "Users can select their own inspection requests" ON inspection_requests FOR SELECT USING (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can update their own inspection requests' AND tablename = 'inspection_requests') THEN
    CREATE POLICY "Users can update their own inspection requests" ON inspection_requests FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can delete their own inspection requests' AND tablename = 'inspection_requests') THEN
    CREATE POLICY "Users can delete their own inspection requests" ON inspection_requests FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Public can insert inspection requests' AND tablename = 'inspection_requests') THEN
    CREATE POLICY "Public can insert inspection requests" ON inspection_requests FOR INSERT WITH CHECK (TRUE);
  END IF;
END $$;

-- ============================================================================
-- SECTION 6: STORAGE BUCKET
-- ============================================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('report-source-docs', 'report-source-docs', false)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS policies
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can read their own storage objects' AND tablename = 'objects') THEN
    CREATE POLICY "Users can read their own storage objects" ON storage.objects
    FOR SELECT USING (bucket_id = 'report-source-docs' AND (storage.foldername(name))[1] = auth.uid()::text);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can upload to their own storage path' AND tablename = 'objects') THEN
    CREATE POLICY "Users can upload to their own storage path" ON storage.objects
    FOR INSERT WITH CHECK (bucket_id = 'report-source-docs' AND (storage.foldername(name))[1] = auth.uid()::text);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can update their own storage objects' AND tablename = 'objects') THEN
    CREATE POLICY "Users can update their own storage objects" ON storage.objects
    FOR UPDATE USING (bucket_id = 'report-source-docs' AND (storage.foldername(name))[1] = auth.uid()::text)
    WITH CHECK (bucket_id = 'report-source-docs' AND (storage.foldername(name))[1] = auth.uid()::text);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can delete their own storage objects' AND tablename = 'objects') THEN
    CREATE POLICY "Users can delete their own storage objects" ON storage.objects
    FOR DELETE USING (bucket_id = 'report-source-docs' AND (storage.foldername(name))[1] = auth.uid()::text);
  END IF;
END $$;

-- ============================================================================
-- SECTION 7: AUTO-UPDATE TIMESTAMPS
-- ============================================================================

CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jobs_update_timestamp ON jobs;
CREATE TRIGGER jobs_update_timestamp BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS templates_update_timestamp ON templates;
CREATE TRIGGER templates_update_timestamp BEFORE UPDATE ON templates FOR EACH ROW EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS reports_update_timestamp ON reports;
CREATE TRIGGER reports_update_timestamp BEFORE UPDATE ON reports FOR EACH ROW EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS inspection_requests_update_timestamp ON inspection_requests;
CREATE TRIGGER inspection_requests_update_timestamp BEFORE UPDATE ON inspection_requests FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- ============================================================================
-- SECTION 8: SAVED TEMPLATES (reusable parsed templates — avoids re-parsing)
-- ============================================================================

CREATE TABLE IF NOT EXISTS saved_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE saved_templates ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE saved_templates ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE saved_templates ADD COLUMN IF NOT EXISTS original_filename TEXT;
ALTER TABLE saved_templates ADD COLUMN IF NOT EXISTS file_type TEXT;
ALTER TABLE saved_templates ADD COLUMN IF NOT EXISTS field_config JSONB DEFAULT '[]';
ALTER TABLE saved_templates ADD COLUMN IF NOT EXISTS storage_path TEXT;
ALTER TABLE saved_templates ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

CREATE INDEX IF NOT EXISTS saved_templates_user_id_idx ON saved_templates(user_id);

ALTER TABLE saved_templates ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can select their own saved templates' AND tablename = 'saved_templates') THEN
    CREATE POLICY "Users can select their own saved templates" ON saved_templates FOR SELECT USING (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can insert their own saved templates' AND tablename = 'saved_templates') THEN
    CREATE POLICY "Users can insert their own saved templates" ON saved_templates FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can update their own saved templates' AND tablename = 'saved_templates') THEN
    CREATE POLICY "Users can update their own saved templates" ON saved_templates FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can delete their own saved templates' AND tablename = 'saved_templates') THEN
    CREATE POLICY "Users can delete their own saved templates" ON saved_templates FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;

DROP TRIGGER IF EXISTS saved_templates_update_timestamp ON saved_templates;
CREATE TRIGGER saved_templates_update_timestamp BEFORE UPDATE ON saved_templates FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- ============================================================================
-- DONE — All tables, columns, indexes, RLS, storage, and triggers are set up
-- ============================================================================
