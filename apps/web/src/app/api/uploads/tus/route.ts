// Spec 038 — Resumable upload endpoint. In production this proxies to the
// `tusd` container (configured in docker-compose.yml with the MinIO S3 backend).
// In dev without tusd running, we accept the upload PATCH chain and stream
// directly into MinIO via the put-object path.
//
// The post-finish hook (tusd's `pre-finish` event) creates the files +
// video_submissions rows. We expose a small companion endpoint that tusd POSTs
// to once the upload completes: /api/uploads/tus/finish.
//
// Spec 154 (audit-closure MEDIUM) — every method handler now gates on
// `auth()` so anonymous callers can no longer POST / PATCH / HEAD a fresh
// upload at the proxied tusd. The previous shape relied on Caddy to enforce
// the auth gate in production but the Next route was open in dev which made
// the local docker stack a footgun for anyone with shell access on the box.
// The 501 branch also no longer leaks the env var name `TUSD_INTERNAL_URL`
// in the response body — the diagnostic is logged to the server console for
// ops while the client sees a generic `tusd_unavailable` token.

import { NextResponse } from "next/server";
import { auth } from "@/auth";

// tusd should handle PATCH / HEAD / DELETE. This route exists as a fallback +
// proxy hook; in production Caddy routes /upload directly to tusd.

async function requireAuth() {
  // Spec 154 — single helper so every method handler enforces the same
  // 401 contract. Returning `null` on missing session keeps the call sites
  // terse (one early-return each).
  const session = await auth();
  if (!session?.user) return null;
  return session.user;
}

function tusdUnavailable() {
  // Spec 154 — the previous response embedded `TUSD_INTERNAL_URL=http://tusd:1080`
  // in the hint string. That leaks both the env var name and the internal
  // hostname / port to anonymous attackers probing the endpoint. The
  // diagnostic still needs to reach ops, so we log it to the server console
  // (visible in journalctl / docker logs) and return a flat token to the
  // client.
  console.warn(
    "[uploads/tus] tusd unavailable — set TUSD_INTERNAL_URL to enable proxied uploads",
  );
  return NextResponse.json({ error: "tusd_unavailable" }, { status: 501 });
}

export async function GET() {
  // Spec 154 — explicit 405 so an anonymous probe gets a method-not-allowed
  // body instead of the Next.js default. The auth gate fires first so the
  // probe doesn't even learn that GET is unsupported until it has a session.
  const user = await requireAuth();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}

export async function POST(req: Request) {
  // Spec 154 — gate the create call. Without this an anonymous request can
  // allocate a tus upload slot, which is both a DoS vector (storage quota)
  // and a way to smuggle a video into the system without an audit trail.
  const user = await requireAuth();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Create — tus protocol uses POST to allocate a new upload.
  const tusdUrl = process.env.TUSD_INTERNAL_URL;
  if (tusdUrl) {
    // Proxy to tusd
    const r = await fetch(`${tusdUrl}/files`, {
      method: "POST",
      headers: req.headers,
      body: req.body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const headers = new Headers(r.headers);
    return new Response(r.body, { status: r.status, headers });
  }
  return tusdUnavailable();
}

export async function HEAD() {
  // Spec 154 — even a HEAD request (tus offset query) must be authenticated
  // because the offset itself is sensitive information (it reveals how much
  // of an upload another user has completed).
  const user = await requireAuth();
  if (!user) return new Response(null, { status: 401 });
  // tus offset query — when running without proxied tusd, this returns 501
  return new Response(null, { status: 501 });
}

export async function PATCH(req: Request) {
  // Spec 154 — gate PATCH (the chunk-append call). An anonymous PATCH would
  // both write bytes against another user's allocation slot and bypass the
  // audit trail.
  const user = await requireAuth();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const tusdUrl = process.env.TUSD_INTERNAL_URL;
  if (tusdUrl) {
    const url = new URL(req.url);
    const upstreamId = url.searchParams.get("id");
    const r = await fetch(`${tusdUrl}/files/${upstreamId}`, {
      method: "PATCH",
      headers: req.headers,
      body: req.body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    return new Response(r.body, { status: r.status, headers: new Headers(r.headers) });
  }
  return new Response(null, { status: 501 });
}

export async function DELETE() {
  // Spec 154 — explicit gate for DELETE. tusd supports DELETE to drop a
  // partial upload; we forward an unauthenticated request as 401 so a
  // stranger can't reset another user's progress.
  const user = await requireAuth();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return new Response(null, { status: 501 });
}
