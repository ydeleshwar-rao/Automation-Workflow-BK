import { createClient, SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl      = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error(
    "Missing required env vars: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"
  );
}

/**
 * Service-role Supabase client — used for ALL backend DB operations.
 *
 * ✅ Bypasses Row Level Security (intentional — backend is trusted)
 * ✅ Can call supabase.auth.admin.* methods (create user, delete user, etc.)
 * ❌ NEVER expose this key or this client to the frontend
 *
 * Auth note:
 *   - Login: supabase.auth.admin.signInWithPassword() for credential validation
 *   - Sessions: we issue our own custom JWTs — Supabase sessions are NOT used
 *   - Middleware: verifies our custom JWT locally, no Supabase API call needed
 */
export const supabase: SupabaseClient = createClient(
  supabaseUrl,
  supabaseServiceKey,
  {
    auth: {
      persistSession:   false,
      autoRefreshToken: false,
    },
  }
);

// NOTE: No anon client needed.
// We use service_role for everything:
//   - signInWithPassword  (to validate user credentials)
//   - admin.createUser     (to create developers)
//   - All DB queries       (profiles, page_permissions, etc.)