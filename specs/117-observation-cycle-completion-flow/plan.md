# Plan 117

CREATED: `apps/web/src/app/(authenticated)/observation/[cycleId]/actions.ts`, `tests/governance/test_117_observation_cycle_completion_flow.test.mjs`, `specs/117-observation-cycle-completion-flow/{spec,plan,research,quickstart,tasks}.md`
EDITED: `apps/web/src/app/(authenticated)/observation/[cycleId]/page.tsx`
MIGRATED: none (rides existing `observation_cycles.status` enum + `observation_forms (cycle_id, kind)` unique index + `observation_cycles.remark` text column; the v1 signoff record is an `audit_log` row, not a new table)
