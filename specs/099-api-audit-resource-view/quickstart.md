# Quickstart 099

1. Open any PDF resource at `/repo/resource/<id>/view` — the in-browser viewer fires a `POST /api/audit/resource-view` beacon on mount.
2. `SELECT action, entity_id, metadata FROM audit_log WHERE action = 'resource.view.client_ping' ORDER BY created_at DESC LIMIT 5;` — confirm exactly one row per viewer paint, with `metadata->>'beacon' = 'true'`.
3. `curl -X GET http://localhost:3000/api/audit/resource-view` — expect `405 Method Not Allowed` with `Allow: POST` header.
