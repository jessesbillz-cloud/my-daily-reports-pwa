#!/bin/bash
# Upload both TYR template files to Supabase
# Usage: bash upload-tyr-templates.sh YOUR_SERVICE_ROLE_KEY
#
# Get your service role key from:
#   https://supabase.com/dashboard/project/wluvkmpncafugdbunlkw/settings/api
#   (Under "Project API keys" → "service_role" → click to reveal)

if [ -z "$1" ]; then
  echo ""
  echo "Usage: bash upload-tyr-templates.sh YOUR_SERVICE_ROLE_KEY"
  echo ""
  echo "Get your service role key from:"
  echo "  https://supabase.com/dashboard/project/wluvkmpncafugdbunlkw/settings/api"
  echo ""
  exit 1
fi

SB_URL="https://wluvkmpncafugdbunlkw.supabase.co"
SB_KEY="$1"
TYR_COMPANY_ID="a0000000-0000-0000-0000-000000000002"
FOLDER="TYR_Inspection_Services"

echo ""
echo "=== Step 1: Delete ALL old TYR company_templates records ==="
curl -s "$SB_URL/rest/v1/company_templates?company_id=eq.$TYR_COMPANY_ID" \
  -X DELETE \
  -H "apikey: $SB_KEY" \
  -H "Authorization: Bearer $SB_KEY" \
  -H "Prefer: return=representation"
echo ""
echo "Old records deleted."

echo ""
echo "=== Step 2: Clean up old storage files ==="
for OLD_PATH in \
  "$TYR_COMPANY_ID/TYR_Daily_Report_Template.pdf" \
  "$FOLDER/TYR_Daily_Report_Template.pdf" \
  "$FOLDER/TYR_Daily_Report_v5_fixed.pdf" \
  "$FOLDER/TYR_Daily_Report_v5.pdf" \
  "$FOLDER/TYR_Daily_Report_v6.pdf" \
  "tyr-engineering/TYR_Daily_Report_Template.pdf"; do
  curl -s "$SB_URL/storage/v1/object/company-templates/$OLD_PATH" \
    -X DELETE \
    -H "apikey: $SB_KEY" \
    -H "Authorization: Bearer $SB_KEY" > /dev/null 2>&1
  echo "  Cleaned: $OLD_PATH"
done

# Also clean old saved_templates references
curl -s "$SB_URL/rest/v1/saved_templates?storage_path=like.*TYR*" \
  -X DELETE \
  -H "apikey: $SB_KEY" \
  -H "Authorization: Bearer $SB_KEY" > /dev/null 2>&1
echo "  Cleaned old saved_templates references"

echo ""
echo "=== Step 3: Upload files ==="

for FILE in "TYR_Daily_Report_Template.pdf" "TYR_Daily_Report_v5_fixed.pdf"; do
  if [ ! -f "$FILE" ]; then
    echo "  SKIPPING $FILE — not found in current directory"
    continue
  fi

  SIZE=$(wc -c < "$FILE" | tr -d ' ')
  if [ "$SIZE" -eq 0 ]; then
    echo "  SKIPPING $FILE — file is empty (0 bytes)"
    continue
  fi

  STORAGE_PATH="$FOLDER/$FILE"
  TEMPLATE_NAME=$(echo "$FILE" | sed 's/\.pdf$//' | sed 's/_/ /g')

  echo ""
  echo "  Uploading $FILE ($SIZE bytes)..."

  # Try POST first, then PUT
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    "$SB_URL/storage/v1/object/company-templates/$STORAGE_PATH" \
    -X POST \
    -H "apikey: $SB_KEY" \
    -H "Authorization: Bearer $SB_KEY" \
    -H "Content-Type: application/pdf" \
    --data-binary "@$FILE")

  if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "201" ]; then
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
      "$SB_URL/storage/v1/object/company-templates/$STORAGE_PATH" \
      -X PUT \
      -H "apikey: $SB_KEY" \
      -H "Authorization: Bearer $SB_KEY" \
      -H "Content-Type: application/pdf" \
      --data-binary "@$FILE")
  fi

  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
    echo "  ✓ Storage upload OK"
  else
    echo "  ✗ Storage upload FAILED ($HTTP_CODE)"
    continue
  fi

  # Create DB record
  REC_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    "$SB_URL/rest/v1/company_templates" \
    -X POST \
    -H "apikey: $SB_KEY" \
    -H "Authorization: Bearer $SB_KEY" \
    -H "Content-Type: application/json" \
    -H "Prefer: return=representation" \
    -d "{
      \"company_id\": \"$TYR_COMPANY_ID\",
      \"template_name\": \"$TEMPLATE_NAME\",
      \"file_name\": \"$FILE\",
      \"original_filename\": \"$FILE\",
      \"file_type\": \"pdf\",
      \"storage_path\": \"company-templates/$STORAGE_PATH\",
      \"mode\": \"template\"
    }")

  if [ "$REC_CODE" = "201" ] || [ "$REC_CODE" = "200" ]; then
    echo "  ✓ DB record created"
  else
    echo "  ✗ DB record FAILED ($REC_CODE)"
  fi
done

echo ""
echo "=== Step 4: Verify ==="
RESULT=$(curl -s "$SB_URL/rest/v1/company_templates?company_id=eq.$TYR_COMPANY_ID&select=template_name,storage_path" \
  -H "apikey: $SB_KEY" \
  -H "Authorization: Bearer $SB_KEY")
echo "TYR templates in database:"
echo "$RESULT" | python3 -c "
import sys,json
data=json.load(sys.stdin)
for t in data:
    print(f\"  ✓ {t['template_name']} → {t['storage_path']}\")
print(f'\nTotal: {len(data)} template(s)')
" 2>/dev/null || echo "$RESULT"

echo ""
echo "=== DONE ==="
echo ""
