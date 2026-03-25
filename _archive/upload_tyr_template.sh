#!/bin/bash
# Upload TYR Daily Report Template to Supabase
# Run from the my-daily-reports-pwa folder:
#   bash upload_tyr_template.sh YOUR_SERVICE_ROLE_KEY
#
# Get your service role key from:
#   https://supabase.com/dashboard/project/wluvkmpncafugdbunlkw/settings/api
#   (Under "Project API keys" → "service_role" → click to reveal)

if [ -z "$1" ]; then
  echo "Usage: bash upload_tyr_template.sh YOUR_SERVICE_ROLE_KEY"
  echo ""
  echo "Get your service role key from Supabase Dashboard → Settings → API"
  exit 1
fi

SB_URL="https://wluvkmpncafugdbunlkw.supabase.co"
SB_KEY="$1"
FILE="TYR_Daily_Report_Template.pdf"
TYR_COMPANY_ID="a0000000-0000-0000-0000-000000000002"

if [ ! -f "$FILE" ]; then
  echo "ERROR: $FILE not found in current directory"
  exit 1
fi

echo "=== Step 1: Find TYR company ==="
COMPANIES=$(curl -s "$SB_URL/rest/v1/companies?name=ilike.*tyr*&select=id,name" \
  -H "apikey: $SB_KEY" \
  -H "Authorization: Bearer $SB_KEY")
echo "Companies found: $COMPANIES"

# Try to extract company ID from response
FOUND_ID=$(echo "$COMPANIES" | python3 -c "import sys,json; data=json.load(sys.stdin); print(data[0]['id'] if data else '')" 2>/dev/null)
if [ -n "$FOUND_ID" ]; then
  TYR_COMPANY_ID="$FOUND_ID"
  echo "Using company ID: $TYR_COMPANY_ID"
else
  echo "Using default company ID: $TYR_COMPANY_ID"
fi

echo ""
echo "=== Step 2: Delete old company_templates records for TYR ==="
curl -s "$SB_URL/rest/v1/company_templates?company_id=eq.$TYR_COMPANY_ID" \
  -X DELETE \
  -H "apikey: $SB_KEY" \
  -H "Authorization: Bearer $SB_KEY" \
  -H "Prefer: return=representation"
echo ""
echo "Old records deleted."

echo ""
echo "=== Step 3: Delete old files from storage ==="
# Delete from report-source-docs (old path)
curl -s "$SB_URL/storage/v1/object/report-source-docs/tyr-engineering/TYR_Daily_Report_Template.pdf" \
  -X DELETE \
  -H "apikey: $SB_KEY" \
  -H "Authorization: Bearer $SB_KEY"
echo " (report-source-docs cleanup done)"

# Delete from company-templates (old path if exists)
curl -s "$SB_URL/storage/v1/object/company-templates/$TYR_COMPANY_ID/TYR_Daily_Report_Template.pdf" \
  -X DELETE \
  -H "apikey: $SB_KEY" \
  -H "Authorization: Bearer $SB_KEY"
echo " (company-templates cleanup done)"

echo ""
echo "=== Step 4: Upload new template to company-templates bucket ==="
STORAGE_PATH="$TYR_COMPANY_ID/$(date +%s)_TYR_Daily_Report_Template.pdf"

UPLOAD=$(curl -s -w "\n%{http_code}" \
  "$SB_URL/storage/v1/object/company-templates/$STORAGE_PATH" \
  -X POST \
  -H "apikey: $SB_KEY" \
  -H "Authorization: Bearer $SB_KEY" \
  -H "Content-Type: application/pdf" \
  --data-binary "@$FILE")

HTTP_CODE=$(echo "$UPLOAD" | tail -1)
BODY=$(echo "$UPLOAD" | head -1)

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
  echo "Upload SUCCESS: company-templates/$STORAGE_PATH"
else
  echo "POST failed ($HTTP_CODE), trying PUT..."
  UPLOAD2=$(curl -s -w "\n%{http_code}" \
    "$SB_URL/storage/v1/object/company-templates/$STORAGE_PATH" \
    -X PUT \
    -H "apikey: $SB_KEY" \
    -H "Authorization: Bearer $SB_KEY" \
    -H "Content-Type: application/pdf" \
    --data-binary "@$FILE")
  HTTP_CODE2=$(echo "$UPLOAD2" | tail -1)
  if [ "$HTTP_CODE2" = "200" ] || [ "$HTTP_CODE2" = "201" ]; then
    echo "Upload SUCCESS (PUT): company-templates/$STORAGE_PATH"
  else
    echo "Upload FAILED: $HTTP_CODE2 - $(echo "$UPLOAD2" | head -1)"
    echo "You may need to run the SQL migration first to fix bucket permissions."
    exit 1
  fi
fi

echo ""
echo "=== Step 5: Create company_templates DB record ==="
RECORD=$(curl -s -w "\n%{http_code}" \
  "$SB_URL/rest/v1/company_templates" \
  -X POST \
  -H "apikey: $SB_KEY" \
  -H "Authorization: Bearer $SB_KEY" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d "{
    \"company_id\": \"$TYR_COMPANY_ID\",
    \"template_name\": \"TYR Daily Report\",
    \"name\": \"TYR Daily Report\",
    \"file_name\": \"TYR_Daily_Report_Template.pdf\",
    \"file_type\": \"pdf\",
    \"storage_path\": \"company-templates/$STORAGE_PATH\",
    \"mode\": \"template\"
  }")

REC_CODE=$(echo "$RECORD" | tail -1)
REC_BODY=$(echo "$RECORD" | head -1)

if [ "$REC_CODE" = "201" ] || [ "$REC_CODE" = "200" ]; then
  echo "DB record created!"
  echo "$REC_BODY"
else
  echo "DB insert failed ($REC_CODE): $REC_BODY"
fi

echo ""
echo "=== Step 6: Also delete old saved_templates referencing old path ==="
curl -s "$SB_URL/rest/v1/saved_templates?storage_path=eq.tyr-engineering/TYR_Daily_Report_Template.pdf" \
  -X DELETE \
  -H "apikey: $SB_KEY" \
  -H "Authorization: Bearer $SB_KEY"
echo "Old saved_templates cleaned up."

echo ""
echo "=== DONE ==="
echo "Storage path: company-templates/$STORAGE_PATH"
echo "Now deploy the frontend: npm run build && npx wrangler pages deploy dist"
