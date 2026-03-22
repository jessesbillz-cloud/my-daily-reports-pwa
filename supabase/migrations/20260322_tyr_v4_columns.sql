-- ============================================================
-- TYR Daily Report v4: Add general_statement and weather_enabled
-- ============================================================

-- 1. general_statement on jobs — reusable paragraph for the job
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS general_statement text;

-- 2. weather_enabled on jobs — allow template jobs to show weather
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS weather_enabled boolean DEFAULT false;

-- 3. Add hours_regular and hours_overtime to report_contractors
ALTER TABLE report_contractors ADD COLUMN IF NOT EXISTS hours_regular numeric(5,1) DEFAULT 0;
ALTER TABLE report_contractors ADD COLUMN IF NOT EXISTS hours_overtime numeric(5,1) DEFAULT 0;
