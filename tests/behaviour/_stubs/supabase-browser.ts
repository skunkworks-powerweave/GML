// Stands in for apps/web/src/lib/supabase/browser.ts (see ../_ui.ts). The real
// module reads the signed-in session out of document.cookie through
// @supabase/ssr; outside a browser there is no session to read. The upload
// module only uses it to fetch the bearer token it hands Storage, so a stub
// that returns a fixed token changes nothing the upload tests look at.
//
// The token can be CHANGED by a test (testTokens()), which is how the real
// getSession() behaves over a long upload: auth-js refreshes the session when
// the access token is close to expiry, and every later call returns the new
// token. `refreshed` is what a forced refreshSession() would mint.

export type SupabaseBrowserConfig = { url: string; anonKey: string };

// Recorded at evaluation, so a test can tell whether a module pulled the
// browser Supabase client in eagerly (upload-bundle.test.ts).
(globalThis as Record<string, unknown>).__gmlSupabaseBrowserLoaded = true;

export const TEST_ACCESS_TOKEN = "test-access-token";

type TokenState = { current: string; refreshed?: string; refreshCalls: number };

/** The session the stub answers from, shared across the test process. */
export function testTokens(): TokenState {
  const g = globalThis as Record<string, unknown>;
  return (g.__gmlTestTokens ??= { current: TEST_ACCESS_TOKEN, refreshCalls: 0 }) as TokenState;
}

export function supabaseBrowser(): never {
  throw new Error("supabaseBrowser() is not available in behaviour tests");
}

export async function accessToken(_config?: SupabaseBrowserConfig, opts: { refresh?: boolean } = {}): Promise<string | null> {
  const s = testTokens();
  if (opts.refresh) {
    s.refreshCalls += 1;
    if (s.refreshed) {
      s.current = s.refreshed;
      s.refreshed = undefined;
    }
  }
  return s.current;
}
