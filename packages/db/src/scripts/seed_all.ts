// Spec 104 — Seed orchestrator.
//
// Runs all five seed scripts in dependency order, in-process (no child
// processes — each script's `main()` is exported and invoked here). This is
// the single command operators run on a fresh deployment to populate
// everything (districts, schools, teachers, mentors, pairings, cycles, plus
// the 4×mentor + 4×mentee + 3×observation + 2×misc feedback-form templates).
//
// Order matters:
//   1. seed             — districts, zones, schools, teachers, mentors,
//                         pairings, cycles, phases, terms, RTT subjects,
//                         super_admin bootstrap (spec 103). The observation
//                         seed below attaches to cycle code `OBS-2026-001`,
//                         so this must run first. (After purge_demo_data.ts
//                         --apply that cycle is gone for good, and phase 4
//                         warns and skips rather than failing the deploy.)
//   2. seed_forms_mentor      — 4 mentor-audience feedback templates
//   3. seed_forms_mentee      — 4 mentee-audience feedback templates
//   4. seed_forms_observation — 3 observation templates onto OBS-2026-001
//   5. seed_forms_misc        — school-visit + endline forms
//
// Idempotent: every sub-script gates inserts on natural keys, so re-running
// `seed:all` against a populated database is a fast no-op.
//
// Exit codes:
//   0 — every phase succeeded (including pure-skip phases on re-run)
//   1 — any phase threw; remaining phases are not attempted.
//
// Run: pnpm --filter @gml/db run seed:all
// Dry: SEED_DRY_RUN=true pnpm --filter @gml/db run seed:all

import "dotenv/config";
import { main as seedCore } from "./seed.js";
import { main as seedFormsMentor } from "./seed_forms_mentor.js";
import { main as seedFormsMentee } from "./seed_forms_mentee.js";
import { main as seedFormsObservation } from "./seed_forms_observation.js";
import { main as seedFormsMisc } from "./seed_forms_misc.js";

interface Phase {
  name: string;
  run: () => Promise<void>;
}

const PHASES: Phase[] = [
  { name: "seed", run: seedCore },
  { name: "seed_forms_mentor", run: seedFormsMentor },
  { name: "seed_forms_mentee", run: seedFormsMentee },
  { name: "seed_forms_observation", run: seedFormsObservation },
  { name: "seed_forms_misc", run: seedFormsMisc },
];

async function main(): Promise<void> {
  const overallStart = Date.now();
  console.log(`[seed:all] starting ${PHASES.length} phases (DRY_RUN=${process.env.SEED_DRY_RUN === "true"})`);

  for (const phase of PHASES) {
    const start = Date.now();
    console.log(`[seed:all] → phase: ${phase.name}`);
    try {
      await phase.run();
    } catch (err) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(2);
      console.error(`[seed:all] ✗ phase '${phase.name}' failed after ${elapsed}s:`, err);
      process.exit(1);
    }
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[seed:all] ✓ phase '${phase.name}' done in ${elapsed}s`);
  }

  const totalElapsed = ((Date.now() - overallStart) / 1000).toFixed(2);
  console.log(`[seed:all] DONE — ${PHASES.length} phases in ${totalElapsed}s`);
}

main().catch((err) => {
  console.error("[seed:all] orchestrator failed:", err);
  process.exit(1);
});
