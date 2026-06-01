# Tasks 099

- [x] Ship `apps/web/src/app/api/audit/resource-view/route.ts` with auth-gated POST + zod body + recordAudit call + 204 response + explicit 405 GET.
- [x] Land `tests/governance/test_099_api_audit_resource_view.test.mjs` with 5+ assertions covering handler shape, auth gate, zod, audit call, 204, never-404 contract.
- [x] Run `pnpm test -- tests/governance/test_099_*.test.mjs` and confirm green.
