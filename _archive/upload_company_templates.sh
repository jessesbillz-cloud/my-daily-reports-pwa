#!/bin/bash
# Upload VIS and TYR company templates to Supabase
# Run this from the my-daily-reports-pwa directory on your Mac
#
# REQUIRES: Your Supabase SERVICE ROLE key (not the anon key)
# Find it at: https://supabase.com/dashboard/project/wluvkmpncafugdbunlkw/settings/api
# Look for "service_role" under "Project API keys"

SB_URL="https://wluvkmpncafugdbunlkw.supabase.co"

# Check if service role key is provided
if [ -z "$1" ]; then
  echo "Usage: bash upload_company_templates.sh YOUR_SERVICE_ROLE_KEY"
  echo ""
  echo "Get your service role key from:"
  echo "  https://supabase.com/dashboard/project/wluvkmpncafugdbunlkw/settings/api"
  echo "  (Under 'Project API keys' → 'service_role' → click to reveal)"
  exit 1
fi

SB_KEY="$1"

echo "=== Step 0: Create storage bucket (if needed) ==="
curl -s "$SB_URL/storage/v1/bucket" \
  -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"company-templates","name":"company-templates","public":true}' | python3 -m json.tool 2>/dev/null || echo "Bucket may already exist"
echo ""

echo "=== Step 1: Get or create companies ==="

# Look up VIS company
VIS_ID=$(curl -s "$SB_URL/rest/v1/companies?name=ilike.%25Vital%20Inspection%25&select=id&limit=1" \
  -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d[0]['id'] if d else '')" 2>/dev/null)

if [ -z "$VIS_ID" ]; then
  echo "Creating VIS company..."
  VIS_ID=$(curl -s "$SB_URL/rest/v1/companies" \
    -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" \
    -H "Content-Type: application/json" -H "Prefer: return=representation" \
    -d '{"name":"Vital Inspection Services"}' | python3 -c "import sys,json;d=json.load(sys.stdin);print(d[0]['id'] if isinstance(d,list) else d.get('id',''))" 2>/dev/null)
fi
echo "VIS company ID: $VIS_ID"

# Look up TYR company
TYR_ID=$(curl -s "$SB_URL/rest/v1/companies?name=ilike.%25TYR%25&select=id&limit=1" \
  -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d[0]['id'] if d else '')" 2>/dev/null)

if [ -z "$TYR_ID" ]; then
  echo "Creating TYR company..."
  TYR_ID=$(curl -s "$SB_URL/rest/v1/companies" \
    -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" \
    -H "Content-Type: application/json" -H "Prefer: return=representation" \
    -d '{"name":"TYR Engineering"}' | python3 -c "import sys,json;d=json.load(sys.stdin);print(d[0]['id'] if isinstance(d,list) else d.get('id',''))" 2>/dev/null)
fi
echo "TYR company ID: $TYR_ID"

echo ""
echo "=== Step 2: Upload template PDFs to storage ==="

# VIS template
VIS_FILE="DR_00_Woodland_Park_MS Mod_Mar 11_2026.pdf"
VIS_STORAGE_PATH="vis/daily_report_template.pdf"
if [ -f "$VIS_FILE" ]; then
  echo "Uploading VIS template..."
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$SB_URL/storage/v1/object/company-templates/$VIS_STORAGE_PATH" \
    -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" \
    -H "Content-Type: application/pdf" \
    --data-binary "@$VIS_FILE" -X POST)
  echo "  POST: $STATUS"
  if [ "$STATUS" != "200" ]; then
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$SB_URL/storage/v1/object/company-templates/$VIS_STORAGE_PATH" \
      -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" \
      -H "Content-Type: application/pdf" \
      --data-binary "@$VIS_FILE" -X PUT)
    echo "  PUT: $STATUS"
  fi
else
  echo "WARNING: VIS template file not found: $VIS_FILE"
fi

# TYR template
TYR_FILE="DR_353__Oceanside_District_Office_Jan_31_2026.pdf"
TYR_STORAGE_PATH="tyr/daily_report_template.pdf"
if [ -f "$TYR_FILE" ]; then
  echo "Uploading TYR template..."
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$SB_URL/storage/v1/object/company-templates/$TYR_STORAGE_PATH" \
    -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" \
    -H "Content-Type: application/pdf" \
    --data-binary "@$TYR_FILE" -X POST)
  echo "  POST: $STATUS"
  if [ "$STATUS" != "200" ]; then
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$SB_URL/storage/v1/object/company-templates/$TYR_STORAGE_PATH" \
      -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" \
      -H "Content-Type: application/pdf" \
      --data-binary "@$TYR_FILE" -X PUT)
    echo "  PUT: $STATUS"
  fi
else
  echo "WARNING: TYR template file not found: $TYR_FILE"
fi

echo ""
echo "=== Step 3: Create company_templates records ==="

# VIS template record
if [ -n "$VIS_ID" ]; then
  echo "Creating VIS company_templates record..."
  curl -s "$SB_URL/rest/v1/company_templates" \
    -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" \
    -H "Content-Type: application/json" -H "Prefer: return=representation" \
    -d "{\"company_id\":\"$VIS_ID\",\"template_name\":\"VIS Daily Report\",\"file_name\":\"DR_00_Woodland_Park_MS Mod_Mar 11_2026.pdf\",\"file_type\":\"pdf\",\"storage_path\":\"company-templates/$VIS_STORAGE_PATH\",\"mode\":\"template\"}" | python3 -m json.tool 2>/dev/null || echo "(may already exist)"
fi

# TYR template record
if [ -n "$TYR_ID" ]; then
  echo "Creating TYR company_templates record..."
  curl -s "$SB_URL/rest/v1/company_templates" \
    -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" \
    -H "Content-Type: application/json" -H "Prefer: return=representation" \
    -d "{\"company_id\":\"$TYR_ID\",\"template_name\":\"TYR Daily Report\",\"file_name\":\"DR_353__Oceanside_District_Office_Jan_31_2026.pdf\",\"file_type\":\"pdf\",\"storage_path\":\"company-templates/$TYR_STORAGE_PATH\",\"mode\":\"template\"}" | python3 -m json.tool 2>/dev/null || echo "(may already exist)"
fi

echo ""
echo "=== Done! ==="
echo "VIS company: $VIS_ID"
echo "TYR company: $TYR_ID"
echo ""
echo "Now when a new user signs up and selects 'Vital Inspection Services' or 'TYR Engineering'"
echo "as their company, they'll see the template auto-populate when creating a job."
