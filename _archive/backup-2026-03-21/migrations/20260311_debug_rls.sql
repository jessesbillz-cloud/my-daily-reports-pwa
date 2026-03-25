-- Run this to see if RLS would pass for your user
SELECT
  p.id AS your_user_id,
  p.company_id AS your_profile_company_id,
  c.id AS vis_company_id,
  c.created_by AS vis_created_by,
  (p.company_id::text = 'a0000000-0000-0000-0000-000000000001') AS profile_matches_folder,
  (c.created_by = p.id) AS you_are_creator
FROM profiles p
CROSS JOIN companies c
WHERE p.email = 'jessesbillz@gmail.com'
  AND c.id = 'a0000000-0000-0000-0000-000000000001';
