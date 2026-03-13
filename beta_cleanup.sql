-- ============================================================
-- BETA CLEANUP: Delete all test users and old templates
-- Run this in the Supabase SQL Editor (MDR project)
-- ============================================================

-- Step 1: Delete all reports
DELETE FROM reports;

-- Step 2: Delete all saved_templates
DELETE FROM saved_templates;

-- Step 3: Delete all company_templates
DELETE FROM company_templates;

-- Step 4: Delete all scheduling_requests (if any test data)
DELETE FROM scheduling_requests;

-- Step 5: Delete all jobs
DELETE FROM jobs;

-- Step 6: Delete all contacts (scheduling contacts)
DELETE FROM contacts;

-- Step 7: Delete all profiles
DELETE FROM profiles;

-- Step 8: Delete all auth users (run this AFTER the table deletes above)
-- This uses the admin API — paste this in a separate SQL block:
-- SELECT auth.uid() to verify you're connected, then:
DELETE FROM auth.users;

-- ============================================================
-- VERIFY: These should all return 0
-- ============================================================
SELECT 'reports' as tbl, count(*) FROM reports
UNION ALL SELECT 'saved_templates', count(*) FROM saved_templates
UNION ALL SELECT 'company_templates', count(*) FROM company_templates
UNION ALL SELECT 'jobs', count(*) FROM jobs
UNION ALL SELECT 'profiles', count(*) FROM profiles;
