# Research 087

## D-001 — Native `<iframe>` rendering over `pdfjs-dist`

`pdfjs-dist` ships ~3 MB of JS (worker + viewer chrome). For Ladakh's satellite / 2G fallback links this is a non-starter — pages must paint within 3 s on a 64 kbps link, and a 3 MB blob blows that budget on first load alone. The browser-native PDF plugin (Chrome / Edge / Firefox / Safari 14+) renders the signed URL progressively, costs zero JS, and supports the URL-fragment toolbar hide (`#toolbar=0&navpanes=0&scrollbar=0`). Trade-off: we lose programmatic control (page-by-page audit, custom annotations). Acceptable for v1; revisit if those become hard requirements.

## D-002 — Reuse `signMediaToken` instead of a new PDF-specific helper

The signed-URL helper is MIME-agnostic — it signs an opaque token (`bucket:key:user:ip:exp` HMAC) and the `/api/media/[token]` route streams whatever bytes MinIO returns with the right Content-Type. Adding a new `signPdfToken` would be parallel-code for no benefit. We use `bucket: "gml-resources"` to keep PDFs separate from HLS renditions (`gml-videos-hls`) at the storage layer, but the signing path is shared.
