#!/bin/bash
# ─── Setup Enhanced TYR Report company + migrate V5 template ───
# Run this from your project directory:
#   chmod +x setup-enhanced-tyr.sh && ./setup-enhanced-tyr.sh
#
# What this does:
# 1. Creates a new company "Enhanced TYR Report" with a fixed UUID
# 2. Uploads TYR_Daily_Report_v5_fixed.pdf to its company templates
# 3. Ensures TYR_Daily_Report_Template.pdf stays with the original TYR company
# 4. Cleans up duplicate template records

set -e

SB_URL="https://wluvkmpncafugdbunlkw.supabase.co"
TYR_COMPANY_ID="a0000000-0000-0000-0000-000000000002"
ENHANCED_TYR_ID="1f200562-c19b-4806-b3f4-9de88fd1b260"

# Prompt for service role key
echo "Enter your Supabase SERVICE_ROLE key (Dashboard → Settings → API → service_role):"
read -s SERVICE_ROLE_KEY
echo ""

if [ -z "$SERVICE_ROLE_KEY" ]; then
  echo "ERROR: Service role key is required."
  exit 1
fi

H_AUTH="Authorization: Bearer $SERVICE_ROLE_KEY"
H_KEY="apikey: $SERVICE_ROLE_KEY"
H_JSON="Content-Type: application/json"
H_PREF="Prefer: return=representation"

echo "=== Step 1: Create 'Enhanced TYR Report' company ==="
# Check if it already exists
EXISTING=$(curl -s -H "$H_AUTH" -H "$H_KEY" \
  "$SB_URL/rest/v1/companies?id=eq.$ENHANCED_TYR_ID&select=id,name")

if echo "$EXISTING" | grep -q "$ENHANCED_TYR_ID"; then
  echo "  Company already exists, skipping creation."
else
  RESULT=$(curl -s -X POST \
    -H "$H_AUTH" -H "$H_KEY" -H "$H_JSON" -H "$H_PREF" \
    -d "{\"id\":\"$ENHANCED_TYR_ID\",\"name\":\"Enhanced TYR Report\"}" \
    "$SB_URL/rest/v1/companies")
  echo "  Created: $RESULT"
fi

echo ""
echo "=== Step 2: Upload TYR_Daily_Report_v5_fixed.pdf to Enhanced TYR Report ==="
V5_FILE="TYR_Daily_Report_v5_fixed.pdf"
if [ ! -f "$V5_FILE" ]; then
  echo "  ERROR: $V5_FILE not found in current directory."
  echo "  Make sure the file exists in your project root."
  exit 1
fi

STORAGE_PATH="Enhanced_TYR_Report/$V5_FILE"
# Upload to storage (try POST first, then PUT for upsert)
echo "  Uploading to storage: company-templates/$STORAGE_PATH"
UP_RESULT=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "$H_AUTH" -H "$H_KEY" -H "Content-Type: application/pdf" \
  --data-binary @"$V5_FILE" \
  "$SB_URL/storage/v1/object/company-templates/$STORAGE_PATH")

if [ "$UP_RESULT" != "200" ]; then
  UP_RESULT=$(curl -s -o /dev/null -w "%{http_code}" -X PUT \
    -H "$H_AUTH" -H "$H_KEY" -H "Content-Type: application/pdf" \
    --data-binary @"$V5_FILE" \
    "$SB_URL/storage/v1/object/company-templates/$STORAGE_PATH")
fi
echo "  Storage upload: HTTP $UP_RESULT"

# Delete any existing Enhanced TYR templates
echo "  Cleaning old Enhanced TYR template records..."
curl -s -X DELETE -H "$H_AUTH" -H "$H_KEY" \
  "$SB_URL/rest/v1/company_templates?company_id=eq.$ENHANCED_TYR_ID" > /dev/null

# Create template record
echo "  Creating template record..."
TPL_RESULT=$(curl -s -X POST \
  -H "$H_AUTH" -H "$H_KEY" -H "$H_JSON" -H "$H_PREF" \
  -d "{\"company_id\":\"$ENHANCED_TYR_ID\",\"template_name\":\"TYR Daily Report v5 Fixed\",\"file_name\":\"$V5_FILE\",\"file_type\":\"pdf\",\"storage_path\":\"company-templates/$STORAGE_PATH\",\"mode\":\"template\"}" \
  "$SB_URL/rest/v1/company_templates")
echo "  Template record: $TPL_RESULT"

echo ""
echo "=== Step 3: Ensure original template stays with TYR Engineering ==="
ORIG_FILE="TYR_Daily_Report_Template.pdf"
if [ -f "$ORIG_FILE" ]; then
  ORIG_STORAGE="TYR_Inspection_Services/$ORIG_FILE"
  echo "  Uploading to storage: company-templates/$ORIG_STORAGE"
  UP2=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    -H "$H_AUTH" -H "$H_KEY" -H "Content-Type: application/pdf" \
    --data-binary @"$ORIG_FILE" \
    "$SB_URL/storage/v1/object/company-templates/$ORIG_STORAGE")
  if [ "$UP2" != "200" ]; then
    UP2=$(curl -s -o /dev/null -w "%{http_code}" -X PUT \
      -H "$H_AUTH" -H "$H_KEY" -H "Content-Type: application/pdf" \
      --data-binary @"$ORIG_FILE" \
      "$SB_URL/storage/v1/object/company-templates/$ORIG_STORAGE")
  fi
  echo "  Storage upload: HTTP $UP2"

  # Check if original TYR already has a template record for this file
  EXISTING_ORIG=$(curl -s -H "$H_AUTH" -H "$H_KEY" \
    "$SB_URL/rest/v1/company_templates?company_id=eq.$TYR_COMPANY_ID&file_name=eq.$ORIG_FILE&select=id")

  if echo "$EXISTING_ORIG" | grep -q "id"; then
    echo "  Original TYR template record already exists."
  else
    TPL2=$(curl -s -X POST \
      -H "$H_AUTH" -H "$H_KEY" -H "$H_JSON" -H "$H_PREF" \
      -d "{\"company_id\":\"$TYR_COMPANY_ID\",\"template_name\":\"TYR Daily Report Template\",\"file_name\":\"$ORIG_FILE\",\"file_type\":\"pdf\",\"storage_path\":\"company-templates/$ORIG_STORAGE\",\"mode\":\"template\"}" \
      "$SB_URL/rest/v1/company_templates")
    echo "  Created: $TPL2"
  fi
else
  echo "  $ORIG_FILE not found — skipping (may already be in storage)."
fi

echo ""
echo "=== Step 4: Clean up V5 templates from original TYR company ==="
# Remove any v5_fixed records from the ORIGINAL TYR company (they belong to Enhanced now)
echo "  Removing v5_fixed template records from original TYR..."
curl -s -X DELETE -H "$H_AUTH" -H "$H_KEY" \
  "$SB_URL/rest/v1/company_templates?company_id=eq.$TYR_COMPANY_ID&file_name=like.*v5*" > /dev/null
echo "  Done."

echo ""
echo "=== Summary ==="
echo "Original TYR (company_id: $TYR_COMPANY_ID)"
echo "  → Template: TYR_Daily_Report_Template.pdf"
echo ""
echo "Enhanced TYR Report (company_id: $ENHANCED_TYR_ID)"
echo "  → Template: TYR_Daily_Report_v5_fixed.pdf"
echo ""
echo "Now update your code constant and redeploy!"
echo "ENHANCED_TYR_ID = \"$ENHANCED_TYR_ID\""
