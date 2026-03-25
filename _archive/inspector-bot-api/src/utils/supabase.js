import { createClient } from '@supabase/supabase-js';
import { config } from '../../config/index.js';

// Service role client (bypasses RLS - for server-side operations)
export const supabase = createClient(
  config.SUPABASE_URL,
  config.SUPABASE_SERVICE_KEY,
  {
    auth: { persistSession: false }
  }
);

// Anon client (respects RLS - for user-scoped operations)
export function createUserClient(accessToken) {
  return createClient(
    config.SUPABASE_URL,
    config.SUPABASE_ANON_KEY,
    {
      global: {
        headers: { Authorization: `Bearer ${accessToken}` }
      },
      auth: { persistSession: false }
    }
  );
}
