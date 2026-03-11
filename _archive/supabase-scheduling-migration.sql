-- My Daily Reports — Scheduling Migration
-- Adds contacts table, new columns to inspection_requests, and RLS policies
-- Safe to run multiple times — uses IF NOT EXISTS and DO blocks everywhere
-- Run this in: Supabase Dashboard → SQL Editor → New Query → Run

-- ============================================================================
-- SECTION 1: CONTACTS TABLE (new — used by schedule.html)
-- ============================================================================

CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  company TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS project TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company TEXT;

-- Unique constraint: one contact per name+project combo (for upsert with Prefer: resolution=merge-duplicates)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_project_name_key') THEN
    ALTER TABLE contacts ADD CONSTRAINT contacts_project_name_key UNIQUE (project, name);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS contacts_project_idx ON contacts(project);

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;

-- Public can read contacts (schedule.html uses anon key)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Public can read contacts' AND tablename = 'contacts') THEN
    CREATE POLICY "Public can read contacts" ON contacts FOR SELECT USING (TRUE);
  END IF;
END $$;

-- Public can insert contacts (schedule.html saves new people with anon key)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Public can insert contacts' AND tablename = 'contacts') THEN
    CREATE POLICY "Public can insert contacts" ON contacts FOR INSERT WITH CHECK (TRUE);
  END IF;
END $$;

-- Public can update contacts (for upsert merge-duplicates)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Public can update contacts' AND tablename = 'contacts') THEN
    CREATE POLICY "Public can update contacts" ON contacts FOR UPDATE USING (TRUE) WITH CHECK (TRUE);
  END IF;
END $$;

-- ============================================================================
-- SECTION 2: NEW COLUMNS ON inspection_requests (schedule.html fields)
-- ============================================================================

ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS project TEXT;
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS inspection_date DATE;
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS inspection_time TIME;
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS inspection_types TEXT[] DEFAULT '{}';
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS submitted_by TEXT;
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS inspection_identifier TEXT;
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS duration INTEGER DEFAULT 60;
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS flexible_display TEXT;
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS subcontractor TEXT;
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS location_detail TEXT;
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS email_recipients JSONB DEFAULT '[]';
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS cancelled_by TEXT;
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS edit_history JSONB DEFAULT '[]';

-- Index for project-based queries (schedule.html filters by project)
CREATE INDEX IF NOT EXISTS inspection_requests_project_idx ON inspection_requests(project);
CREATE INDEX IF NOT EXISTS inspection_requests_inspection_date_idx ON inspection_requests(inspection_date);
CREATE INDEX IF NOT EXISTS inspection_requests_inspection_types_idx ON inspection_requests USING GIN(inspection_types);

-- ============================================================================
-- SECTION 3: RLS POLICY — Public/anon can READ inspection_requests
-- schedule.html queries with anon key filtered by project, no auth
-- ============================================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Public can read inspection requests' AND tablename = 'inspection_requests') THEN
    CREATE POLICY "Public can read inspection requests" ON inspection_requests FOR SELECT USING (TRUE);
  END IF;
END $$;

-- Public can also update inspection requests (for cancel/edit via anon key)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Public can update inspection requests' AND tablename = 'inspection_requests') THEN
    CREATE POLICY "Public can update inspection requests" ON inspection_requests FOR UPDATE USING (TRUE) WITH CHECK (TRUE);
  END IF;
END $$;

-- ============================================================================
-- SECTION 4: STORAGE BUCKET for scheduling attachments (photos/PDFs)
-- ============================================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('scheduling-attachments', 'scheduling-attachments', true)
ON CONFLICT (id) DO NOTHING;

-- Public can upload to scheduling-attachments (anon key from schedule.html)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Public can upload scheduling attachments' AND tablename = 'objects') THEN
    CREATE POLICY "Public can upload scheduling attachments" ON storage.objects
    FOR INSERT WITH CHECK (bucket_id = 'scheduling-attachments');
  END IF;
END $$;

-- Public can read scheduling attachments
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Public can read scheduling attachments' AND tablename = 'objects') THEN
    CREATE POLICY "Public can read scheduling attachments" ON storage.objects
    FOR SELECT USING (bucket_id = 'scheduling-attachments');
  END IF;
END $$;

-- ============================================================================
-- DONE — Run this SQL, then deploy submit-inspection and update-inspection
-- ============================================================================
