#!/bin/bash
# Clean up duplicate company_templates and saved_templates records
# Usage: bash cleanup_duplicates.sh YOUR_SERVICE_ROLE_KEY

SB_URL="https://wluvkmpncafugdbunlkw.supabase.co"

if [ -z "$1" ]; then
  echo "Usage: bash cleanup_duplicates.sh YOUR_SERVICE_ROLE_KEY"
  exit 1
fi

SB_KEY="$1"

echo "=== Listing all company_templates ==="
curl -s "$SB_URL/rest/v1/company_templates?select=id,company_id,template_name,storage_path,created_at&order=created_at.asc" \
  -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" | python3 -m json.tool

echo ""
echo "=== Deleting OLD company_templates (keep only the ones from today's upload) ==="

# Get all company_templates, delete any that don't have the correct storage paths from our upload
# Keep: company-templates/vis/daily_report_template.pdf and company-templates/tyr/daily_report_template.pdf
# Delete everything else

# Delete VIS duplicates (wrong storage path)
echo "Deleting old VIS templates..."
curl -s -o /dev/null -w "Status: %{http_code}\n" \
  "$SB_URL/rest/v1/company_templates?company_id=eq.a0000000-0000-0000-0000-000000000001&storage_path=neq.company-templates/vis/daily_report_template.pdf" \
  -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" \
  -X DELETE

# Delete TYR duplicates (wrong storage path)
echo "Deleting old TYR templates..."
curl -s -o /dev/null -w "Status: %{http_code}\n" \
  "$SB_URL/rest/v1/company_templates?company_id=eq.a0000000-0000-0000-0000-000000000002&storage_path=neq.company-templates/tyr/daily_report_template.pdf" \
  -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" \
  -X DELETE

echo ""
echo "=== Cleaning up duplicate saved_templates for all users ==="
# List all saved_templates that came from company templates (have company-templates in storage_path)
curl -s "$SB_URL/rest/v1/saved_templates?storage_path=like.company-templates*&select=id,user_id,template_name,storage_path,created_at&order=created_at.asc" \
  -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" | python3 -m json.tool

echo ""
echo "Deleting saved_templates with bad storage paths (not from our upload)..."
curl -s -o /dev/null -w "Status: %{http_code}\n" \
  "$SB_URL/rest/v1/saved_templates?storage_path=like.company-templates*&storage_path=neq.company-templates/vis/daily_report_template.pdf&storage_path=neq.company-templates/tyr/daily_report_template.pdf" \
  -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" \
  -X DELETE

echo ""
echo "=== Remaining company_templates ==="
curl -s "$SB_URL/rest/v1/company_templates?select=id,company_id,template_name,storage_path" \
  -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" | python3 -m json.tool

echo ""
echo "=== Done! ==="
