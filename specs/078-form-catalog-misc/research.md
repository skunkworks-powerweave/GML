# Research 078

## D-001 — Use `version` column as the discriminator, not a new enum value

`feedbackKindEnum` is locked and lacks `schoolvisit`/`endline`. Adding enum values mid-phase would require a migration we explicitly defer. Instead we route the two new forms through existing enum values (`baseline`/`final`) and disambiguate via the `version` column's natural suffix (`schoolvisit-1`, `endline-1`). The unique index `(kind, audience, version)` preserves idempotency, and the JSON `schema.purpose` field gives the renderer a stable dispatch key. When/if a future migration adds the enum values, this seed can be re-keyed without data loss because `version` is unique per row.
