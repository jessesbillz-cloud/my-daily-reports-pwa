/**
 * Migration Runner
 * Reads SQL files in order and executes against Supabase
 *
 * Usage: node migrations/run.js
 *
 * NOTE: For the initial setup, it's easier to just run each SQL file
 * directly in the Supabase SQL Editor. This runner is for automation.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function run() {
  const files = fs.readdirSync(__dirname)
    .filter(f => f.endsWith('.sql'))
    .sort();

  console.log(`Found ${files.length} migration files`);

  for (const file of files) {
    console.log(`\nRunning: ${file}`);
    const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');

    const { error } = await supabase.rpc('exec_sql', { query: sql }).catch(e => {
      // Fallback: try direct REST API
      return { error: e };
    });

    if (error) {
      console.warn(`  Warning: ${error.message || error}`);
      console.warn('  You may need to run this SQL file manually in the Supabase SQL Editor.');
    } else {
      console.log(`  ✓ Success`);
    }
  }

  console.log('\nMigrations complete!');
  console.log('If any failed, copy the SQL from the migration file and paste it into:');
  console.log(`${SUPABASE_URL.replace('.supabase.co', '')}/project/sql/new`);
}

run().catch(console.error);
