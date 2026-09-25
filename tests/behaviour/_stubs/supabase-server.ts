// Stands in for apps/web/src/lib/supabase/server.ts, but only in a test file
// that calls stubSupabaseServer() (../_ui.ts) before importing the code under
// test; everywhere else the real module loads.
//
// supabaseAdmin() answers with the fake a test put on the shared fake request
// (`request.supabaseAdmin`), so a server action that creates or deletes an
// auth account (admin/users) can run as far as the database, and the test
// can see what it asked Supabase Auth to do. A behaviour test never talks to
// a real Supabase project.

type State = { supabaseAdmin?: unknown };
const state = () => ((globalThis as Record<string, unknown>).__gmlTestRequest ?? {}) as State;

export function supabaseAdmin(): unknown {
  const fake = state().supabaseAdmin;
  if (!fake) throw new Error("supabaseAdmin(): put a fake client on request.supabaseAdmin first");
  return fake;
}

export async function createSupabaseServerClient(): Promise<never> {
  throw new Error("createSupabaseServerClient is not available in a behaviour test");
}
