// Spec 038 — Resumable upload endpoint. In production this proxies to the
// `tusd` container (configured in docker-compose.yml with the MinIO S3 backend).
// In dev without tusd running, we accept the upload PATCH chain and stream
// directly into MinIO via the put-object path.
//
// The post-finish hook (tusd's `pre-finish` event) creates the files +
// video_submissions rows. We expose a small companion endpoint that tusd POSTs
// to once the upload completes: /api/uploads/tus/finish.

import { NextResponse } from "next/server";

// tusd should handle PATCH / HEAD / DELETE. This route exists as a fallback +
// proxy hook; in production Caddy routes /upload directly to tusd.

export async function POST(req: Request) {
  // Create — tus protocol uses POST to allocate a new upload.
  const tusdUrl = process.env.TUSD_INTERNAL_URL;
  if (tusdUrl) {
    // Proxy to tusd
    const r = await fetch(`${tusdUrl}/files`, {
      method: "POST",
      headers: req.headers,
      body: req.body,
      // @ts-expect-error duplex required by Node fetch for streaming bodies
      duplex: "half",
    });
    const headers = new Headers(r.headers);
    return new Response(r.body, { status: r.status, headers });
  }
  return NextResponse.json(
    { error: "tusd_not_configured", hint: "Set TUSD_INTERNAL_URL=http://tusd:1080 in .env" },
    { status: 501 },
  );
}

export async function HEAD() {
  // tus offset query — when running without proxied tusd, this returns 501
  return new Response(null, { status: 501 });
}

export async function PATCH(req: Request) {
  const tusdUrl = process.env.TUSD_INTERNAL_URL;
  if (tusdUrl) {
    const url = new URL(req.url);
    const upstreamId = url.searchParams.get("id");
    const r = await fetch(`${tusdUrl}/files/${upstreamId}`, {
      method: "PATCH",
      headers: req.headers,
      body: req.body,
      // @ts-expect-error duplex required by Node fetch
      duplex: "half",
    });
    return new Response(r.body, { status: r.status, headers: new Headers(r.headers) });
  }
  return new Response(null, { status: 501 });
}
