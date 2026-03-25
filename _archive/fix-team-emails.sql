-- ============================================================
-- 1. PREVIEW: See current duplicates before fixing
-- ============================================================

SELECT id, name,
  jsonb_array_length(team_emails) AS total_entries,
  team_emails
FROM jobs
WHERE team_emails IS NOT NULL
  AND jsonb_array_length(team_emails) > 0;

-- ============================================================
-- 2. DEDUPLICATE team_emails on ALL jobs
-- Keeps only the first occurrence of each email (case-insensitive)
-- ============================================================

UPDATE jobs
SET team_emails = deduped.clean_emails
FROM (
  SELECT j.id,
    (SELECT jsonb_agg(elem ORDER BY ordinality)
     FROM (
       SELECT DISTINCT ON (lower(elem->>'email'))
         elem, ordinality
       FROM jsonb_array_elements(j.team_emails) WITH ORDINALITY AS t(elem, ordinality)
       ORDER BY lower(elem->>'email'), ordinality
     ) uniq
    ) AS clean_emails
  FROM jobs j
  WHERE j.team_emails IS NOT NULL
    AND jsonb_array_length(j.team_emails) > 0
) deduped
WHERE jobs.id = deduped.id;

-- ============================================================
-- 3. VERIFY: Show team_emails after cleanup
-- ============================================================

SELECT id, name,
  jsonb_array_length(team_emails) AS team_count,
  team_emails
FROM jobs
WHERE team_emails IS NOT NULL
  AND jsonb_array_length(team_emails) > 0;

-- ============================================================
-- 4. CHECK email suppressions (bounced/complained emails)
-- If any team emails are suppressed, send-report will skip them
-- ============================================================

SELECT email, suppressed, bounce_type, complaint_type, event_count, created_at
FROM email_suppressions
WHERE suppressed = true
ORDER BY created_at DESC;

-- ============================================================
-- 5. If you need to UN-suppress a legitimate email:
-- (Uncomment and replace the email address)
-- ============================================================

-- UPDATE email_suppressions
-- SET suppressed = false
-- WHERE email = 'someone@example.com';
