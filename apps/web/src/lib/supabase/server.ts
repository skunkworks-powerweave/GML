// Supabase clients for server-side code.
//
// Two clients, and the difference matters:
//
//   createSupabaseServerClient()  acts AS THE SIGNED-IN USER. It reads and
//                                 writes the auth cookie pair, and it is what
//                                 auth() and the login/logout actions use.
//   supabaseAdmin()               acts as the service role. It bypasses RLS and
//                                 can create, ban and delete accounts. It must
//                                 never be reachable from a browser.

import "server-only";
import { cookies, headers } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { boundSessionCookie, isSecureOrigin, sessionCookieOptions } from "@/lib/supabase/cookies";

// Read at call time, not at module scope. `next build` imports this module to
// prerender pages, and a module-scope throw would turn a missing env var into a
// build failure on a machine that legitimately has no Supabase credentials.
function publicEnv(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set. " +
        "Copy them from Supabase -> Project Settings -> API Keys.",
    );
  }
  return { url, key };
}

/**
 * User-scoped client. Every call resolves the cookie store fresh, because in the
 * App Router `cookies()` is request-scoped and must not be hoisted.
 */
export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  const { url, key } = publicEnv();
  const store = await cookies();
  // Secure and a bounded Max-Age on every write: see lib/supabase/cookies.ts.
  const secure = isSecureOrigin(process.env.APP_URL, (await headers()).get("x-forwarded-proto"));

  return createServerClient(url, key, {
    cookieOptions: sessionCookieOptions(secure),
    cookies: {
      getAll: () => store.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) {
            store.set(name, value, boundSessionCookie(options, secure));
          }
        } catch {
          // Server Components cannot write cookies -- `cookies().set()` throws
          // there by design. This is EXPECTED and is not an error to log.
          //
          // It is also exactly why src/proxy.ts runs on a catch-all matcher: a
          // rotated refresh token is written to the response there, on a request
          // path that CAN set cookies. Without that, a token refreshed inside a
          // Server Component would be discarded and the user would be bounced to
          // /login roughly every access-token lifetime.
        }
      },
    },
  });
}

/**
 * Service-role client. RLS-bypassing and account-administering.
 *
 * `server-only` at the top of this module is the enforcement: importing it from
 * a "use client" file is a BUILD error, not a runtime surprise. Do not re-export
 * this from a module that client code also imports.
 */
export function supabaseAdmin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set for admin operations.",
    );
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}
