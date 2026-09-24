// Stands in for apps/web/src/lib/supabase/browser.ts (see ../_ui.ts). The real
// module reads the signed-in session out of document.cookie through
// @supabase/ssr; outside a browser there is no session to read. The upload
// module only uses it to fetch the bearer token it hands Storage, so a stub
// that returns a fixed token changes nothing the upload tests look at.

export type SupabaseBrowserConfig = { url: string; anonKey: string };

export const TEST_ACCESS_TOKEN = "test-access-token";

export function supabaseBrowser(): never {
  throw new Error("supabaseBrowser() is not available in behaviour tests");
}

export async function accessToken(): Promise<string | null> {
  return TEST_ACCESS_TOKEN;
}
