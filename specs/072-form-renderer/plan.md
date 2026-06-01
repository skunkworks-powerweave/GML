CREATED: apps/web/src/components/forms/FormRenderer.tsx, apps/web/src/lib/form-draft.ts, apps/web/src/app/api/form-drafts/[id]/route.ts
EDITED: (none — wires into existing audit + db modules only)
MIGRATED: (none — reuses existing `form_drafts` table from earlier migration; partial-unique scoping on `(user_id, template_id)` and `(user_id, observation_cycle_id)` is already in place)
