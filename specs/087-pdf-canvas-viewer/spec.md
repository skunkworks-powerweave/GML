# Spec 087 — PDF canvas viewer (signed URL + watermark overlay)

**Status:** complete · **Date:** 2026-06-01 · **Phase:** 10 (Hardening)

## Overview

Ships the in-browser PDF viewer that the repository detail page (spec 055) has been routing to with a placeholder. Lives at `/repo/resource/[id]/view` and wires together three SM-4 (anti-exfiltration) deterrents that already exist for video: (1) a 5-minute signed media URL minted via `signMediaToken` and proxied through `/api/media/[token]` so the underlying MinIO object key never reaches the client, (2) a diagonal repeating watermark burned over the viewport with the viewer's email + the `OBS-CONFIDENTIAL` tag at `mix-blend-mode: difference` so screenshots and screen-recordings carry identifying marks, and (3) a context-menu block and an iframe URL fragment (`#toolbar=0&navpanes=0&scrollbar=0`) that suppresses the browser's built-in download / print / save-as affordances.

The viewer deliberately uses the browser's native PDF plugin via `<iframe>` instead of bundling `pdfjs-dist` (~3 MB of JS). Ladakh deployment runs on satellite and 2G fallbacks — shipping a 3 MB PDF renderer per page load is a non-starter. The native plugin renders progressively from the streamed signed URL and works everywhere our learner-side browser matrix already supports (Chrome ≥ 90, Edge, Firefox, Safari 14+).

The disclosure footer ("PDF viewing is logged. Document is confidential — do not redistribute. (Anti-download is a deterrent, not DRM.)") is rendered below the viewer. SM-4 honesty in writing: we don't pretend a fragment-hidden toolbar is DRM; we say so out loud. The same wording is reused on the `HlsPlayer` page footer for consistency.

The button label on the resource detail page is changed from "Download PDF" to "View PDF" because the viewer is in-browser only — there is no download path. This is the only edit to existing code; the rest of spec 055 is preserved verbatim.

## Functional Requirements

- **FR-001** — `apps/web/src/components/pdf/PdfViewer.tsx` is a `"use client"` component exporting `PdfViewer({ src, watermark, resourceId })`. It renders an absolutely-positioned wrapper containing an `<iframe>` (signed URL + fragment-hidden toolbar), a diagonal repeating watermark `<div>`, and a top-right tag badge. The wrapper blocks `onContextMenu` via `e.preventDefault()`.
- **FR-002** — The watermark overlay is `aria-hidden`, `pointer-events: none`, `user-select: none`, `opacity: 0.15`, `mix-blend-mode: difference`, and tiled with the watermark string repeated diagonally across the viewport. Always covers `inset: 0` so the viewer cannot crop it away. Visible but not obstructive at the default opacity.
- **FR-003** — `apps/web/src/app/(authenticated)/repo/resource/[id]/view/page.tsx` is a server component with `export const dynamic = "force-dynamic"`. It calls `auth()` at the top; anon sessions redirect to `/login`. It resolves the resource by id (must be `active = true`), 404s if missing or if `fileKey` is null (no fileKey → no PDF to serve).
- **FR-004** — Server mints a 5-minute signed URL via `signMediaToken({ bucket: "gml-resources", objectKey: res.fileKey, userId, ip })` and passes `/api/media/${token}` as `src` to the `PdfViewer`. IP is read from `x-forwarded-for` / `x-real-ip` with `"unknown"` fallback (matches the HLS player page).
- **FR-005** — Server calls `recordAudit({ action: "resource.pdf.view", entityType: "resource", entityId: id, metadata: { piiAudited: false, kind, fileKey } })` exactly once per page load. SM-9: every view of a confidential document is logged. `recordAudit` is best-effort (swallows errors) so a broken audit table cannot take the viewer down.
- **FR-006** — Below the viewer, the page renders the SM-4 disclosure footer with the exact text: `PDF viewing is logged. Document is confidential — do not redistribute. (Anti-download is a deterrent, not DRM.)`.
- **FR-007** — The resource detail page (`/repo/resource/[id]`, shipped in spec 055) has its action button label changed from `Download PDF` to `View PDF`. The route (`/repo/resource/${id}/view`) is unchanged; only the JSX label is edited. All other detail-page behaviour is preserved.
- **FR-008** — **NO new dependencies.** `pdfjs-dist` is explicitly out — too heavy for low-bandwidth deployment. Browser-native iframe rendering only.

## Acceptance Criteria

| Behaviour | Verification |
| --- | --- |
| `/repo/resource/<uuid>/view` renders for an authed user with a fileKey-bearing resource | Manual: visit URL, see PDF in iframe + watermark overlay |
| Anon → /login | Manual: log out, hit URL, redirected |
| Missing / inactive resource → 404 | Manual: visit fake uuid → notFound() |
| Resource without fileKey → 404 | Manual: visit external-only resource → notFound() (no PDF to serve) |
| Right-click is blocked on the wrapper | Manual: right-click on viewer → context menu suppressed |
| Watermark is visible diagonally across the viewport | Manual: take a screenshot → watermark text appears in the image |
| Disclosure footer text matches verbatim | Manual: visible below viewer; governance test asserts substring |
| Audit row written per view | `SELECT * FROM audit_log WHERE action = 'resource.pdf.view' ORDER BY created_at DESC LIMIT 1` |
| Resource detail button reads "View PDF" not "Download PDF" | Governance test grep on detail page |
| No new package added | `package.json` diff is empty |

## Audit hooks

- `resource.pdf.view` on every page load — userId / entityId / entityType / ip / userAgent / metadata (`{ piiAudited: false, kind, fileKey }`).
- The client-side `<PdfViewer>` also POSTs `/api/audit/resource-view` on mount as a secondary signal that the viewer actually painted (server audit fires before render; client audit confirms render). The client-side ping is best-effort (`keepalive: true`, `.catch(() => undefined)`).

## Out of scope

- Search / page-jump / zoom controls inside the PDF — deferred to the browser's native plugin defaults.
- Annotation overlays / highlighting — not in this phase.
- Page-by-page audit (which page did the user view) — not technically possible with the iframe approach. If we ever need this, we'd have to swap to `pdfjs-dist` and accept the bundle hit.
- Per-page watermarking (each PDF page tagged at render time) — also a `pdfjs-dist` requirement. The viewport overlay is the SM-4 deterrent for now.
- Mobile-specific UX (the iframe pattern works on mobile but is not optimised for touch). Tracked separately.

## SM-4 honesty disclosure

The viewer **does not** provide DRM. A determined user with Ctrl+S, screen-recording, or developer-tools can extract the document. What it provides is:

1. **Identification** — the watermark survives screenshots and screen-recordings; if a leaked document surfaces, we can identify the source.
2. **Audit trail** — every view is logged with user / IP / timestamp.
3. **Friction** — the obvious "Download" / "Save as…" affordances are removed so casual exfiltration takes deliberate effort.
4. **Signed URLs** — the underlying object key never reaches the client; URL-sharing is bound by IP and a 5-minute TTL.

That's the deterrence stack. The footer says so plainly.
