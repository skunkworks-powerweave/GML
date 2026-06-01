# Research 076

## D-001 — Per-row existence check vs `ON CONFLICT DO NOTHING`

The `feedback_forms_kind_audience_version_uq` unique index supports `ON CONFLICT (kind, audience, version) DO NOTHING`, but the brief asks for clear `[skip]` logging per row. We do a `SELECT id` guard first so we can emit a precise "skipped existing (kind=progress_2, audience=mentee, version=2)" line and still report an accurate `inserted/skipped` summary at the end. The extra round-trip is fine for a four-row seed.
