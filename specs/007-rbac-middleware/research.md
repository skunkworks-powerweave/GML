# Research 007

## D-001: JWT-only role check in middleware (no DB hit per request)
Per-request DB lookup adds ~10ms on a fast LAN, much more on Ladakh's mountain links. JWT already carries `role` (set in spec 005). Stale-role risk: bounded by 8h JWT max-age + `signOut()` invalidation. Acceptable trade-off.

## D-002: Numeric role rank for ordering
`ROLE_RANK = {teacher: 1, observer: 2, mentor: 2, programme_admin: 3, super_admin: 4}`. `hasRole(actual, required)` returns `RANK[actual] >= RANK[required]`. Cleaner than nested switch.

## D-003: middleware.ts at apps/web/src/middleware.ts (not root)
Next.js's `--src-dir` puts middleware inside `src/`. CLAUDE.md and `.claude/settings.json` already reference this path.
