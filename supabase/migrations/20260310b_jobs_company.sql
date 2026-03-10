-- Add company_id to jobs table so each job can link to the company
-- whose template it uses (separate from the user's profile company)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
