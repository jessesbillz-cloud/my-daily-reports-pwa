/**
 * Upload TYR template files to Supabase and clean up old versions.
 *
 * Usage: node upload-tyr-templates.mjs your@email.com yourpassword
 *
 * This script:
 * 1. Signs in with your email/password
 * 2. Lists all existing TYR company_templates records
 * 3. Deletes old/duplicate TYR template records and storage files
 * 4. Uploads TYR_Daily_Report_Template.pdf and TYR_Daily_Report_v5_fixed.pdf
 * 5. Creates company_templates records for each
 */

import { readFileSync, existsSync } from 'fs';

const SB_URL = "https://wluvkmpncafugdbunlkw.supabase.co";
const SB_KEY = "sb_publishable_ljHZivQXVH-9tB5PxFTB6g_jpatXcvC";
const TYR_COMPANY_ID = "a0000000-0000-0000-0000-000000000002";
const FOLDER = "TYR_Inspection_Services";

const EMAIL = process.argv[2];
const PASSWORD = process.argv[3];

if (!EMAIL || !PASSWORD) {
  console.error("\nUsage: node upload-tyr-templates.mjs your@email.com yourpassword\n");
  process.exit(1);
}

async function main() {
  // Sign in
  console.log("\n--- Signing in... ---");
  const authR = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SB_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD })
  });
  if (!authR.ok) {
    console.error("Login failed:", authR.status, await authR.text());
    process.exit(1);
  }
  const authData = await authR.json();
  const TOKEN = authData.access_token;
  console.log("Signed in as", authData.user?.email);

  const headers = {
    apikey: SB_KEY,
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json"
  };

  // 1. List existing TYR templates
  console.log("\n--- Step 1: List existing TYR company_templates ---");
  const listR = await fetch(
    `${SB_URL}/rest/v1/company_templates?company_id=eq.${TYR_COMPANY_ID}&select=*`,
    { headers }
  );
  if (!listR.ok) {
    console.error("Failed to list templates:", listR.status, await listR.text());
    return;
  }
  const existing = await listR.json();
  console.log(`Found ${existing.length} existing TYR template records:`);
  existing.forEach(t => console.log(`  - ${t.id} | ${t.template_name || t.file_name} | ${t.storage_path}`));

  // 2. Delete ALL existing TYR template records
  console.log("\n--- Step 2: Delete old TYR template records ---");
  for (const t of existing) {
    const delR = await fetch(
      `${SB_URL}/rest/v1/company_templates?id=eq.${t.id}`,
      { method: "DELETE", headers }
    );
    console.log(`  Deleted record ${t.id} (${t.template_name}): ${delR.status}`);

    if (t.storage_path) {
      const sp = t.storage_path.replace("company-templates/", "");
      const sDelR = await fetch(
        `${SB_URL}/storage/v1/object/company-templates/${sp}`,
        { method: "DELETE", headers: { apikey: SB_KEY, Authorization: `Bearer ${TOKEN}` } }
      );
      console.log(`  Deleted storage ${sp}: ${sDelR.status}`);
    }
  }

  // 3. Upload the two template files
  const files = [
    { filename: "TYR_Daily_Report_Template.pdf", templateName: "TYR Daily Report Template" },
    { filename: "TYR_Daily_Report_v5_fixed.pdf", templateName: "TYR Daily Report v5 fixed" },
  ];

  for (const { filename, templateName } of files) {
    if (!existsSync(filename)) {
      console.log(`\n  SKIPPING ${filename} — file not found in current directory`);
      continue;
    }
    const fileData = readFileSync(filename);
    if (fileData.length === 0) {
      console.log(`\n  SKIPPING ${filename} — file is 0 bytes`);
      continue;
    }

    const storagePath = `${FOLDER}/${filename}`;
    console.log(`\n--- Upload ${filename} (${fileData.length} bytes) ---`);

    let upR = await fetch(`${SB_URL}/storage/v1/object/company-templates/${storagePath}`, {
      method: "POST",
      headers: { apikey: SB_KEY, Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/pdf" },
      body: fileData
    });
    if (!upR.ok) {
      upR = await fetch(`${SB_URL}/storage/v1/object/company-templates/${storagePath}`, {
        method: "PUT",
        headers: { apikey: SB_KEY, Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/pdf" },
        body: fileData
      });
    }
    console.log(`  Storage upload: ${upR.status} ${upR.ok ? "OK" : await upR.text()}`);

    const recR = await fetch(`${SB_URL}/rest/v1/company_templates`, {
      method: "POST",
      headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify({
        company_id: TYR_COMPANY_ID,
        template_name: templateName,
        file_name: filename,
        original_filename: filename,
        file_type: "pdf",
        storage_path: `company-templates/${storagePath}`,
        mode: "template"
      })
    });
    const recData = await recR.json().catch(() => null);
    console.log(`  DB record: ${recR.status} ${recR.ok ? "OK" : JSON.stringify(recData)}`);
    if (recR.ok && recData?.[0]) {
      console.log(`  Created: ${recData[0].id} → ${recData[0].storage_path}`);
    }
  }

  // 4. Verify
  console.log("\n--- Final TYR templates ---");
  const verifyR = await fetch(
    `${SB_URL}/rest/v1/company_templates?company_id=eq.${TYR_COMPANY_ID}&select=id,template_name,storage_path`,
    { headers }
  );
  const final = await verifyR.json();
  console.log(`TYR has ${final.length} template(s):`);
  final.forEach(t => console.log(`  ✓ ${t.template_name} → ${t.storage_path}`));
  console.log("\nDone!\n");
}

main().catch(e => console.error("Fatal error:", e));
