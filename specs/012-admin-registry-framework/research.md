# Research 012

## D-001: One registry file, many entities — not one route per entity
Adding a teacher table vs a school table is the same UX pattern. One generic grid + a registry of metadata is the Frappe-DocType pattern boiled down to ~200 LOC of TypeScript.

## D-002: Drizzle table object stored directly in the registry
TypeScript gets table-name-narrowing across `db.select().from(t)` calls. Trade-off: registry imports all schemas → larger bundle. Acceptable for admin pages (server-only, rarely loaded).

## D-003: Server actions vs API routes
Server actions get type-safety + Auth.js session "for free". API routes would force a manual JWT check. Server actions also play nicer with `useActionState` on the client form.
