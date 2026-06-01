# Research 072 — Form Renderer

## Decision: build the renderer on plain React state + zod, NOT react-hook-form

`apps/web/package.json` does not list `react-hook-form`, and the task brief forbids new dependencies. The handful of stateful concerns (controlled values, blur-time validation, debounced autosave) are simple enough that plain `useState` + a small `useEffect`-driven debounce is cleaner than fighting a missing library. Zod is already in the workspace and used by every other API route, so we reuse it for the field-level + body-level validation surface.

## Decision: `[id]` route param doubles as either template-id or cycle-id

`form_drafts` has two mutually-exclusive scope columns with partial-unique indices. The simplest URL shape is `/api/form-drafts/{id}?scope=template|cycle`. The alternative (two routes, `/api/form-drafts/templates/[id]` and `/api/form-drafts/cycles/[id]`) doubles the surface and adds nothing — a `scope` query param is unambiguous and the partial-unique index does the heavy lifting at the DB layer.
