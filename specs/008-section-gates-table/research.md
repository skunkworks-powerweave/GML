# Research 008

## D-001: CHECK constraint enforces SM-2 at DB layer
Defence-in-depth: Zod schema + middleware + DB CHECK. App can't accidentally insert a 24h grant.

## D-002: 8h max grant
Mirrors the JWT max-age. Visitor re-prompts once per workday at worst.

## D-003: `section_gate_slug` enum reused from schema/enums.ts
Type safety + index efficiency. Adding a new gate later = `ALTER TYPE` migration.
