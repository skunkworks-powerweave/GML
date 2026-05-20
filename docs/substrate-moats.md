# Substrate moats

Invariants the codebase defends at multiple layers. Each moat must survive every spec byte-for-byte; violating one requires explicit user sign-off and a dedicated spec.

**Status:** placeholder. The six moats below are listed for orientation; their enforcement layers (DB constraint / Zod schema / middleware / CI gate) land in spec 011.

- **SM-1** Audit log is append-only.
- **SM-2** Section grants expire (no `section_gate_grants` row outlives 8h).
- **SM-3** Video originals retained until HLS verified.
- **SM-4** Anti-download is documented, not promised.
- **SM-5** No prod without recent restore drill (≤ 30 days).
- **SM-6** Confidentiality footer on every protected page.

See [`../PLAN.md` § "Substrate moats"](../../PLAN.md) for the full rationale.
