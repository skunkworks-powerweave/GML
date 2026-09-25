// The worker's stop grace in docker-compose.yml against its own drain deadline.
//
// A STRUCTURAL invariant, and one nothing in this repo can execute: it is a
// property of Docker, which sends SIGKILL `stop_grace_period` after SIGTERM,
// set against a constant in the worker. What the worker DOES with SIGTERM is
// executed by tests/behaviour/worker-shutdown.test.ts; this only keeps the two
// numbers in the right order.
//
// F115: no stop_grace_period was set, so Docker's 10 s applied while the drain
// waited 30 s, and every deploy during a transcode was a SIGKILL -- the job
// left 'running' behind a fifteen-minute lease, an attempt spent, a ledger row
// orphaned, the scratch directory leaked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

test("F115: the worker's stop_grace_period outlasts its drain deadline", () => {
  const compose = read("docker-compose.yml");
  const start = compose.indexOf("\n  worker:\n");
  assert.ok(start >= 0, "docker-compose.yml has no worker service");
  const next = compose.slice(start + 1).search(/\n  [a-z][\w-]*:\n/);
  const worker = next < 0 ? compose.slice(start) : compose.slice(start, start + 1 + next);

  const grace = /^\s+stop_grace_period:\s*(\d+)s\s*$/m.exec(worker);
  assert.ok(grace, "the worker service must set stop_grace_period, or Docker SIGKILLs it after 10 s");

  const deadline = /const DRAIN_DEADLINE_MS = ([\d_]+);/.exec(read("apps/worker/src/index.ts"));
  assert.ok(deadline, "apps/worker/src/index.ts must define DRAIN_DEADLINE_MS");
  const graceMs = Number(grace[1]) * 1000;
  const drainMs = Number(deadline[1].replace(/_/g, ""));
  assert.ok(
    graceMs >= drainMs + 5000,
    `stop_grace_period (${graceMs} ms) must exceed the drain deadline (${drainMs} ms) with room to exit`,
  );
});
