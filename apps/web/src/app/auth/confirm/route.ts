// Email-link landing point that works on ANY device.
//
// WHY THIS EXISTS BESIDE /auth/callback. Supabase's default email links carry a
// PKCE `code` that /auth/callback exchanges with exchangeCodeForSession -- and
// that exchange needs the code verifier @supabase/ssr stored as a cookie in the
// browser that REQUESTED the email. A teacher who asks for a reset on a school
// computer and opens the email on her phone -- the normal case here -- has no
// such cookie, so the link failed as "expired" every time.
//
// This route takes Supabase's documented server-side form instead:
//
//     {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/login/reset
//
// verifyOtp({ type, token_hash }) needs nothing from the requesting browser.
// The email templates are a Supabase dashboard setting; README-deploy §2.3 has
// the exact text. /auth/callback stays, for a link sent before the templates
// were changed.

import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";
// safeInternalPath: `next` arrives in a URL that was mailed to the user; see
// /auth/callback. publicUrl: behind Caddy the request's own origin is Next's
// bind address.
import { publicUrl, safeInternalPath } from "@/lib/safe-redirect";

/**
 * The link types this product sends: password recovery, and magic-link sign-in
 * ("email" is the current name, "magiclink" the older one). Sign-up and invite
 * links are not accepted: accounts are created by administrators.
 */
const ACCEPTED: ReadonlySet<string> = new Set<EmailOtpType>(["recovery", "email", "magiclink"]);

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const next = safeInternalPath(searchParams.get("next"));

  if (!tokenHash || !type || !ACCEPTED.has(type)) {
    return NextResponse.redirect(await publicUrl("/login?error=link_invalid"));
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.verifyOtp({ type: type as EmailOtpType, token_hash: tokenHash });
  if (error) {
    // Expired or already used. One instruction either way -- request a new
    // link -- and saying which would confirm the address exists.
    return NextResponse.redirect(await publicUrl("/login?error=link_expired"));
  }

  // As with /auth/callback, a verified link is not a guarantee of access: the
  // access-token hook still refuses an inactive profile, and auth() then reads
  // the result as signed out.
  return NextResponse.redirect(await publicUrl(next));
}
