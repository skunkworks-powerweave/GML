# Quickstart 145 — Signed-URL subnet binding

Manual smoke (3 minutes), entirely from a Node REPL — no need to
boot the full stack:

## Repro the original failure (would-have-401'd)

1. Open a Node REPL in the repo root:
   ```
   node
   ```
2. Compile the helper TS to JS with esbuild or run via tsx (or
   pre-build the web app and require from `apps/web/.next/...`).
   The lazy path is to add an `.mjs` driver:
   ```js
   import { signMediaToken, verifySignedToken, ipToBindKey } from
     "./apps/web/src/lib/video/signed-url.ts";  // via tsx --tsconfig
   process.env.MEDIA_SIGN_SECRET = "smoke-test-secret";

   const t = signMediaToken({
     bucket: "gml-videos-hls",
     objectKey: "v/abc123/master.m3u8",
     userId: "user-1",
     ip: "203.0.113.42",
   });
   console.log(verifySignedToken(t, "203.0.113.99"));
   // Expected (post-145): { ok: true, ... }
   // Pre-145 would have been: { ok: false, reason: "ip_mismatch" }
   ```
3. Repeat with a cross-/24 IP:
   ```js
   console.log(verifySignedToken(t, "203.0.114.99"));
   // Expected: { ok: false, reason: "ip_mismatch" }
   ```

## IPv6 round-trip

4. Sign with one IPv6, verify with another in the same /64:
   ```js
   const t6 = signMediaToken({
     bucket: "gml-videos-hls",
     objectKey: "v/abc123/master.m3u8",
     userId: "user-1",
     ip: "2001:db8:1::abcd",
   });
   console.log(verifySignedToken(t6, "2001:db8:1:0:dead:beef::1"));
   // Expected: { ok: true, ... }
   console.log(verifySignedToken(t6, "2001:db8:2::1"));
   // Expected: { ok: false, reason: "ip_mismatch" }
   ```

## End-to-end smoke (requires docker-compose + a real HLS asset)

5. Boot the stack: `docker compose up -d` then `pnpm dev`.
6. Sign in as a learner, open a video detail page —
   `apps/web/src/app/(authenticated)/videos/[id]/page.tsx` — the
   page mints a 5-minute signed token and routes through
   `/api/media/[token]`.
7. Watch hls.js fetch master + segments. Open the Network panel.
   You'll see every `/api/media/<token>` request return 200.
8. Simulate a tower handoff by changing `x-forwarded-for` on a
   subsequent request to a different host octet inside the same
   /24. Easiest path: Caddyfile rewrites the X-Forwarded-For
   header behind a per-request env var.
   ```
   curl -H "X-Forwarded-For: 203.0.113.99" \
        http://localhost:3000/api/media/<token>
   ```
   Expected: 200 OK.
9. Change to a different /24 (`203.0.114.99`):
   ```
   curl -H "X-Forwarded-For: 203.0.114.99" \
        http://localhost:3000/api/media/<token>
   ```
   Expected: 403, body `{ "error": "signed_url_invalid", "reason": "ip_mismatch" }`.

## Test gate

10. Run the scoped governance suite:
    ```
    pnpm test -- --test-name-pattern "spec 145"
    ```
    All six+ assertions green. Full suite stays at 1083 + new
    tests this spec adds.
