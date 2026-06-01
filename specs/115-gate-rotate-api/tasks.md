# Tasks 115

- [x] T1 → write governance test (red) → author `apps/web/src/app/api/admin/gates/[slug]/rotate/route.ts` (POST: auth + super_admin role gate + slug validation + crypto.randomBytes password + bcrypt cost 10 + section_gates INSERT + section_gate_grants mass DELETE + gate.password.rotated audit + 200 {ok, plaintext, version} response + 405 method-not-allowed stubs) → green
- [x] T2 → companion `apps/web/src/app/api/admin/gates/[slug]/share/route.ts` (POST: same gates + zod body validation + recipient phone lookup + wa.me URL composition + gate.password.share_initiated audit) → green
- [x] T3 → `apps/web/src/app/(authenticated)/admin/gates/page.tsx` server component + `rotate-controls.tsx` client component for the per-row Rotate / Copy / Share UX; link the `/admin` index tile to the new page → green
