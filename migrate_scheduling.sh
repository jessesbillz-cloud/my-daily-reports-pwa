#!/bin/bash
# ============================================================
# Migrate Scheduling Data: Old Supabase → MDR Supabase
# ============================================================
# Run this from your Mac terminal (NOT the Supabase SQL editor).
# Requires: curl, jq (brew install jq if needed)
#
# This script:
# 1. Exports inspection_requests from old Supabase
# 2. Converts IOR type labels (already correct, no change needed)
# 3. Imports into MDR Supabase inspection_requests table
# 4. Seeds contacts for each project
# ============================================================

# OLD Supabase (saltzman-scheduling)
OLD_SB="https://esxeusjjeuyhwwrtwpcv.supabase.co"
OLD_AK="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVzeGV1c2pqZXV5aHd3cnR3cGN2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3Mzg0MDYsImV4cCI6MjA4NjMxNDQwNn0.dBEhvcxnscwk1gmb3FGYexmLlrzbd60NFzkt4771IvE"

# NEW MDR Supabase
NEW_SB="https://wluvkmpncafugdbunlkw.supabase.co"
NEW_AK="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndsdXZrbXBuY2FmdWdkYnVubGt3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIzMDU1MTUsImV4cCI6MjA4Nzg4MTUxNX0.HZpQ2xVGpf4EQ0BVDmIEuPqW5T_eNG5OqBNAqT03rH8"

echo "================================================"
echo "  Scheduling Migration: Old → MDR Supabase"
echo "================================================"
echo ""

# ── Step 1: Export old inspection requests ──
echo "Step 1: Fetching inspection requests from old Supabase..."
OLD_DATA=$(curl -s "${OLD_SB}/rest/v1/inspection_requests?select=*&order=created_at.asc&limit=1000" \
  -H "apikey: ${OLD_AK}" \
  -H "Authorization: Bearer ${OLD_AK}")

COUNT=$(echo "$OLD_DATA" | jq 'length')
echo "  Found ${COUNT} records"

if [ "$COUNT" = "0" ] || [ "$COUNT" = "null" ]; then
  echo "  No records to migrate. Skipping data migration."
else
  # ── Step 2: Transform and insert into MDR ──
  echo ""
  echo "Step 2: Inserting into MDR Supabase..."

  # Strip old IDs and let MDR Supabase generate new ones
  # Keep all fields except id, created_at (auto-generated)
  CLEAN_DATA=$(echo "$OLD_DATA" | jq '[.[] | del(.id, .created_at) | . + {requested_date: .inspection_date}]')

  RESULT=$(curl -s -w "\n%{http_code}" "${NEW_SB}/rest/v1/inspection_requests" \
    -X POST \
    -H "apikey: ${NEW_AK}" \
    -H "Authorization: Bearer ${NEW_AK}" \
    -H "Content-Type: application/json" \
    -H "Prefer: resolution=merge-duplicates" \
    -d "$CLEAN_DATA")

  HTTP_CODE=$(echo "$RESULT" | tail -1)
  BODY=$(echo "$RESULT" | sed '$d')

  if [ "$HTTP_CODE" = "201" ] || [ "$HTTP_CODE" = "200" ]; then
    echo "  ✅ Migrated ${COUNT} inspection requests"
  else
    echo "  ⚠️  HTTP ${HTTP_CODE} — some records may have failed"
    echo "  Response: ${BODY}"
  fi
fi

# ── Step 3: Seed contacts for each project ──
echo ""
echo "Step 3: Seeding contacts for each project..."

# Oceanside DO team (from oceanside-index.html)
OCEANSIDE_CONTACTS='[
  {"name":"Jesse Saltzman","email":"saltzman.jesse@gmail.com","company":"SOCOTEC","project":"Oceanside-DO"},
  {"name":"Ferris Adjan","email":"FAdjan@bernards.com","company":"Bernards","project":"Oceanside-DO"},
  {"name":"Eric DeHart","email":"EDeHart@bernards.com","company":"Bernards","project":"Oceanside-DO"},
  {"name":"Dave Harris","email":"dharris@bernards.com","company":"Bernards","project":"Oceanside-DO"},
  {"name":"Christian Lechuga","email":"Clechuga@bernards.com","company":"Bernards","project":"Oceanside-DO"}
]'

# Woodland Park MS team (from wpms.html — same team, different project)
WPMS_CONTACTS='[
  {"name":"Jesse Saltzman","email":"saltzman.jesse@gmail.com","company":"SOCOTEC","project":"Woodland-Park-MS"},
  {"name":"Ferris Adjan","email":"FAdjan@bernards.com","company":"Lusardi","project":"Woodland-Park-MS"},
  {"name":"Eric DeHart","email":"EDeHart@bernards.com","company":"Lusardi","project":"Woodland-Park-MS"},
  {"name":"Dave Harris","email":"dharris@bernards.com","company":"Lusardi","project":"Woodland-Park-MS"},
  {"name":"Christian Lechuga","email":"Clechuga@bernards.com","company":"Lusardi","project":"Woodland-Park-MS"}
]'

# CSUSM ISE Building team (from csusm.html)
CSUSM_CONTACTS='[
  {"name":"Jesse Saltzman","email":"saltzman.jesse@gmail.com","company":"SOCOTEC","project":"CSUSM-ISE-Building"},
  {"name":"Ferris Adjan","email":"FAdjan@bernards.com","company":"Bernards","project":"CSUSM-ISE-Building"},
  {"name":"Eric DeHart","email":"EDeHart@bernards.com","company":"Bernards","project":"CSUSM-ISE-Building"},
  {"name":"Dave Harris","email":"dharris@bernards.com","company":"Bernards","project":"CSUSM-ISE-Building"},
  {"name":"Christian Lechuga","email":"Clechuga@bernards.com","company":"Bernards","project":"CSUSM-ISE-Building"}
]'

for CONTACTS_JSON in "$OCEANSIDE_CONTACTS" "$WPMS_CONTACTS" "$CSUSM_CONTACTS"; do
  PROJECT=$(echo "$CONTACTS_JSON" | jq -r '.[0].project')
  RESULT=$(curl -s -w "\n%{http_code}" "${NEW_SB}/rest/v1/contacts" \
    -X POST \
    -H "apikey: ${NEW_AK}" \
    -H "Authorization: Bearer ${NEW_AK}" \
    -H "Content-Type: application/json" \
    -H "Prefer: resolution=merge-duplicates" \
    -d "$CONTACTS_JSON")
  HTTP_CODE=$(echo "$RESULT" | tail -1)
  if [ "$HTTP_CODE" = "201" ] || [ "$HTTP_CODE" = "200" ]; then
    echo "  ✅ ${PROJECT}: contacts seeded"
  else
    echo "  ⚠️  ${PROJECT}: HTTP ${HTTP_CODE}"
  fi
done

echo ""
echo "================================================"
echo "  Migration complete!"
echo ""
echo "  Next steps:"
echo "  1. In MDR app, enable scheduling on your jobs"
echo "     (Job Settings → toggle Scheduling)"
echo "  2. Share your new hub URL:"
echo "     hub.html?i=YOUR_SLUG"
echo "     (replace YOUR_SLUG with your profile slug)"
echo "  3. Old GitHub Pages URLs can be retired"
echo "================================================"
