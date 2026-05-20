# Research 005

## D-001: next-auth@beta (v5) over v4
v5 has cleaner App Router integration, server-action-friendly `signIn()`, and direct Drizzle adapter support.

## D-002: JWT sessions, not DB sessions
DB sessions add a query per request — bad on Ladakh's mountain links. JWT puts the role + userId in the cookie. Trade-off: invalidation is delayed by JWT TTL. Mitigation: 8h max age + `lastSeenAt` bump.

## D-003: bcryptjs (pure JS) over bcrypt (native)
`bcrypt` needs native build that often breaks on Windows/musl/Alpine. `bcryptjs` is slightly slower but portable; perfectly fine for our login frequency.

## D-004: Rate-limit key `(ip, email)`
Stronger than ip-only (prevents attacker rotating emails from same IP) and email-only (doesn't punish legit user behind shared NAT for someone else's mistake).
