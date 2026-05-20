# Research 009

## D-001: JWT mutation NOT done in server action — relies on next refresh
Auth.js v5 has no in-place JWT mutation API. The server action sets a short-lived **cookie marker** `gml-gate-<slug>=1; Max-Age=8h` that middleware also checks (alongside DB grant). Belt + braces. The next sign-in refresh will eventually carry `user.gates` from the DB.

## D-002: `getActiveGrant` is queried from middleware **only via cookie marker**, not DB
Edge runtime can't hit Postgres. Cookie is the primary middleware check; DB is the source of truth for audit + admin reporting.

## D-003: Cookie is `HttpOnly` + `SameSite=Strict` + signed
Signed via `AUTH_SECRET` HMAC so it can't be forged. JWT-side carries the same info on next refresh.
