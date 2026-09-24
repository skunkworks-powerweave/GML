// The requesting client's IP, taken from the one hop we actually control.
//
// WHAT WAS WRONG. Four call sites each carried their own copy of
//
//     hdr.get("x-forwarded-for")?.split(",")[0]?.trim() ?? hdr.get("x-real-ip") ?? "unknown"
//
// -- gate/[slug]/actions.ts, login/email-actions.ts, and both header reads in
// lib/audit.ts. That expression trusts a header the CLIENT sends. Caddy's
// reverse_proxy APPENDS the socket peer to an incoming X-Forwarded-For rather
// than replacing it, so a request sent with `X-Forwarded-For: 1.2.3.4` arrives
// here as `1.2.3.4, <real ip>` and `.split(",")[0]` hands back the attacker's
// string. (`trusted_proxies` in the Caddyfile would not change that: it governs
// which hop Caddy itself treats as the client, not what it forwards.)
//
// Consequences, all three real:
//   - the section-gate limit (5 attempts per 15 minutes, keyed on ip + user +
//     slug) became unlimited: rotate one header value per attempt and every
//     attempt gets a fresh counter, against the shared password that is the only
//     thing between an authenticated teacher and a gated section;
//   - the magic-link / password-reset throttle, keyed on the ip alone, became a
//     no-op -- burning the deployment's Supabase email quota and letting anyone
//     mail-bomb a staff address;
//   - audit_log.ip, the forensic column, became attacker-chosen.
//
// WHAT WE TRUST INSTEAD. Caddy sets `header_up X-Real-IP {remote_host}` on both
// reverse_proxy blocks (docker/Caddyfile). {remote_host} is the TCP peer, so it
// cannot be forged, and Caddy is the only ingress (the only service with a
// published port; the app's 3000 is not). X-Real-IP is consulted FIRST.
// X-Forwarded-For is a fallback, and only its LAST element -- the hop our proxy
// appended. Everything to the left of it came from the client.
//
// SHAPE-CHECKED. section_gate_grants.ip and audit_log.ip are varchar(64), and the
// gate action inserts this value into the grant row. An over-long header made
// that INSERT throw AFTER bcrypt.compare had accepted a CORRECT password, so the
// right password answered with a server error. Only a parseable IP literal is
// returned; anything else is UNKNOWN_IP.
//
// ONE helper, used by every caller. The duplicated snippet is how three later
// copies inherited the bug, so consolidating is part of the fix.
//
// No "server-only" marker: clientIpFrom() is pure and the behaviour suite
// (tests/behaviour/request-ip.test.ts) executes it directly. clientIp() calls
// next/headers, which Next already refuses to bundle into a client component.

import { isIP } from "node:net";
import { headers } from "next/headers";

/** Anything with the Headers `get` shape -- `headers()`, a Request's headers. */
export type HeaderReader = { get(name: string): string | null };

/** What callers get when no trustworthy address is available. */
export const UNKNOWN_IP = "unknown";

// The longest textual IPv6 form (an IPv4-mapped address written out in full) is
// 45 characters. Anything longer is not an address, whatever else it is.
const MAX_IP_LEN = 45;

/** The candidate, normalised, if it is an IP literal; otherwise null. */
function parseIp(candidate: string | null | undefined): string | null {
  const value = candidate?.trim();
  if (!value || value.length > MAX_IP_LEN) return null;
  // A zone id ("fe80::1%eth0") is legal for isIP but is free text, and no peer
  // that reaches us through Caddy has one.
  if (value.includes("%")) return null;

  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) return null;

  const v6 = value.toLowerCase();
  // A dual-stack socket reports an IPv4 peer as ::ffff:a.b.c.d. Collapse it, so
  // the same client produces the same rate-limit key and the same audit mask
  // whichever way the listener happened to be bound.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v6);
  if (mapped && isIP(mapped[1]!) === 4) return mapped[1]!;
  return v6;
}

/**
 * Resolve the client IP from a header bag. Returns UNKNOWN_IP when neither
 * header carries a parseable address -- e.g. the app reached directly, without
 * Caddy in front of it, as it is in local development.
 */
export function clientIpFrom(h: HeaderReader): string {
  const real = parseIp(h.get("x-real-ip"));
  if (real) return real;

  const forwarded = h.get("x-forwarded-for");
  if (forwarded) {
    const appended = parseIp(forwarded.split(",").at(-1));
    if (appended) return appended;
  }

  return UNKNOWN_IP;
}

/** Request-scoped convenience for callers that need nothing else from headers(). */
export async function clientIp(): Promise<string> {
  return clientIpFrom(await headers());
}
