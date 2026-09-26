// /observation/new mints the cycle code -- EXECUTED, no database needed.
//
// The demo seed wrote OBS-2026-001..008 by hand and nothing else ever minted a
// code, because nothing else ever created a cycle. The nomination form now
// does, and the code it assigns must be free (UNIQUE(code)) and must be one the
// admin-grid entity's own schema accepts, since the action validates with it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { nextCycleCode, cycleCodePrefix } from "../../apps/web/src/lib/observation/cycle-code.ts";
import { parseSubmission } from "./_admin-submit.ts";

test("the next free OBS code follows the highest for that year", () => {
  assert.equal(nextCycleCode(2026, []), "OBS-2026-001");
  assert.equal(
    nextCycleCode(2026, ["OBS-2026-001", "OBS-2026-008", "OBS-2026-003"]),
    "OBS-2026-009",
    "the next code follows the highest, not the count -- a deleted cycle must not cause a collision",
  );
  assert.equal(nextCycleCode(2027, ["OBS-2026-008"]), "OBS-2027-001", "numbering restarts each year");
  assert.equal(nextCycleCode(2026, ["PILOT-1", "OBS-2026-x", " OBS-2026-004 "]), "OBS-2026-005");
  assert.equal(nextCycleCode(2026, ["OBS-2026-999"]), "OBS-2026-1000");
  assert.equal(cycleCodePrefix(2026), "OBS-2026-");
});

test("whatever it mints, the observation-cycles schema accepts", () => {
  const r = parseSubmission("observation-cycles", {
    code: nextCycleCode(2026, ["OBS-2026-999"]),
    teacherId: "11111111-1111-4111-8111-111111111111",
    observerId: "22222222-2222-4222-8222-222222222222",
    kind: "evaluative",
    scheduledAt: "2026-12-01",
  });
  assert.ok(r.success, JSON.stringify(r.success ? null : r.error.issues));
});
