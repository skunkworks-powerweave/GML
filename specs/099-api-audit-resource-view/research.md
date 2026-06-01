# Research 099

- `PdfViewer.tsx` (spec 087) already posts `{ id: resourceId }` via `fetch` with `keepalive: true` — the modern `sendBeacon`-equivalent for cross-origin friendly JSON beacons; route must accept that shape OR the spec'd `{ resourceId }` shape.
- `recordAudit` from `@/lib/audit` already swallows insert errors (try/catch + console.error) — the beacon path is therefore safe to fire-and-forget without an extra wrapper.
- `audit_log.action` is `varchar(64)` (spec 021), action `resource.view.client_ping` is 26 chars — no migration needed.
