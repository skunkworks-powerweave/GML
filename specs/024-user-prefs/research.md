# Research 024
- Upsert via Drizzle's `.insert(...).onConflictDoUpdate({target: userPrefs.userId, set: {...}})` — clean per-user persistence.
- Defaults returned when no row exists (avoids client needing to know defaults).
- Audit action `user_prefs.update` includes `metadata.keys` so the audit timeline shows WHAT changed without storing the full new state.
