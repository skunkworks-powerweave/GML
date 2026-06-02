# Tasks 130
governance test (red) → page.tsx widens searchParams + extracts/sanitizes context + prefill → FormRenderer gains `context` prop and plants hidden `__ctx_*` / `__formId` / `__slug` / `__pairingId` inputs → submitFormAction reads `__ctx_*` back, persists into responses.__context + spreads into audit metadata → green → Workflow Run 11 commit batch
