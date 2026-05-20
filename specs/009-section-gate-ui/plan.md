# Plan 009

Files CREATED:
- `apps/web/src/app/gate/[slug]/page.tsx`
- `apps/web/src/app/gate/[slug]/actions.ts`
- `tests/governance/test_009_section_gate_ui.test.mjs`

Files EDITED:
- `apps/web/src/middleware.ts` (add `/gate/:path*` to matcher? No — gate pages are accessed unauth-protected once user is logged in; existing policies cover this via the auth requirement)
