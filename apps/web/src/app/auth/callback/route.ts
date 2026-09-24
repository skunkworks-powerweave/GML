// PKCE code exchange — the landing point for every Supabase email link.
//
// Magic-link sign-in and password recovery both send the user to
// `${origin}/auth/callback?code=...&next=...`. Exchanging that one-time code
// for a session is the only step that can set the auth cookies, so it has to
// happen in a Route Handler; a Server Component could compute the session and
// would then be unable to persist it.

import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
// safeInternalPath: `next` arrives in a URL that was mailed to the user, which
// makes it attacker-supplied in the most effective way -- a link that really
// authenticates them and then forwards them elsewhere. publicUrl: behind Caddy
// the request's own origin is Next's bind address (0.0.0.0:3000).
import { publicUrl, safeInternalPath } from "@/lib/safe-redirect";


export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const next = safeInternalPath(searchParams.get("next"));

  if (!code) {
    return NextResponse.redirect(await publicUrl("/login?error=link_invalid"));
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    // Expired, already used, or issued to a different browser. All three are
    // the same instruction to the user -- request a new link -- and telling
    // them which would confirm the address exists.
    return NextResponse.redirect(await publicUrl("/login?error=link_expired"));
  }

  // NOTE: a successful exchange is NOT a guarantee of access. The account can
  // still be inactive or have no profile, in which case
  // public.custom_access_token_hook refuses to mint an access token and auth()
  // returns null -- so `next` renders as signed-out and proxy.ts bounces to
  // /login. That is the intended fail-closed behaviour, not a gap.
  return NextResponse.redirect(await publicUrl(next));
}
