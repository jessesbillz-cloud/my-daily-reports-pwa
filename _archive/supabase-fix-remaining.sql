-- ============================================================================
-- Remaining DB fixes from second audit
-- ============================================================================

-- 1. Add missing updated_at triggers
DROP TRIGGER IF EXISTS contacts_update_timestamp ON contacts;
CREATE TRIGGER contacts_update_timestamp BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS profiles_update_timestamp ON profiles;
CREATE TRIGGER profiles_update_timestamp BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- Add updated_at column to profiles if missing
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- Add updated_at column to contacts if missing
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- 2. Clean up contacts.project text column — migrate to job_id if needed
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'contacts' AND column_name = 'project' AND data_type = 'text'
  ) THEN
    -- If any rows use project text but not job_id, try to match them
    UPDATE contacts c
    SET job_id = j.id
    FROM jobs j
    WHERE c.project = j.name AND c.job_id IS NULL;

    -- Drop the text column
    ALTER TABLE contacts DROP COLUMN project;
  END IF;
END $$;

-- Drop redundant unique constraint on (project, name) if it exists
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_project_name_key') THEN
    ALTER TABLE contacts DROP CONSTRAINT contacts_project_name_key;
  END IF;
END $$;

-- 3. Drop redundant jobs_user_id_idx (covered by partial indexes)
DROP INDEX IF EXISTS jobs_user_id_idx;

-- Also drop other redundant single-column indexes covered by partials
DROP INDEX IF EXISTS jobs_scheduling_enabled_idx;
DROP INDEX IF EXISTS jobs_is_archived_idx;
