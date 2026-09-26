// Shared harness for the behavioural suite.
//
// ── WHY THIS DIRECTORY EXISTS ────────────────────────────────────────────────
//
// `tests/governance/` contains 1552 assertions across 130-odd files, and every
// one of them readFileSync's a source file and regex-matches its text. NOT ONE
// imports application code. 25,000 lines of test that cannot observe a single
// runtime behaviour, reporting green while the section gate compared a cookie
// to the string "1", the media proxy 403'd every video segment, the worker
// container shipped without its own source code, and `docker compose up` could
// not start on any machine.
//
// Those tests still have a job -- they pin structural invariants a runtime test
// cannot reach, like "the service-role key is never imported into a client
// module". But they are not evidence that anything works, and they were treated
// as though they were.
//
// Everything in this directory executes the thing it is testing.

import { Client } from "pg";

export const DATABASE_URL = process.env.DATABASE_URL;

/**
 * Skip a whole file when there is no database to talk to.
 *
 * Returns a reason string, or null when the suite can run. Callers pass this to
 * node:test's `{ skip }` option.
 *
 * Deliberately NOT a silent pass: `node --test` exits 0 when everything skips,
 * which is exactly how the old integration suite managed to be "green" without
 * ever running. CI sets DATABASE_URL against a real Postgres service container,
 * so a skip there means the workflow is misconfigured -- and the summary line
 * printed at the end of a skipped run says so.
 */
export function needsDatabase(): string | false {
  if (!DATABASE_URL) {
    return "DATABASE_URL not set — these tests need a real Postgres (see .github/workflows/test.yml)";
  }
  return false;
}

/** A connected client, for a single test. Always paired with `close`. */
export async function connect(): Promise<Client> {
  const c = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
  await c.connect();
  return c;
}

/**
 * Run a body against a fresh client and always close it.
 *
 * Connection leaks in a test suite look like flakiness: the pool exhausts part
 * way through and later tests fail for reasons unrelated to what they assert.
 */
export async function withClient<T>(body: (c: Client) => Promise<T>): Promise<T> {
  const c = await connect();
  try {
    return await body(c);
  } finally {
    await c.end().catch(() => undefined);
  }
}

/**
 * Serialise the tests that briefly put a public table WITHOUT row-level
 * security in place (rls-every-deploy.test.ts, and seed-bootstrap.test.ts's
 * verify-auth check) against each other and against the invariant that no
 * such table exists (invariants.test.ts). Files run in parallel processes, so
 * without this the invariant could see a probe table, or one test's migrate
 * could lock down the other's probe before it was looked at. Probes take the
 * lock exclusively; the invariant takes it shared.
 */
export async function withRlsProbeLock<T>(mode: "exclusive" | "shared", body: () => Promise<T>): Promise<T> {
  const c = await connect();
  const fn = mode === "exclusive" ? "pg_advisory_lock" : "pg_advisory_lock_shared";
  try {
    await c.query(`SELECT ${fn}(hashtext('tests:public-table-without-rls'))`);
    return await body();
  } finally {
    await c.end().catch(() => undefined); // ending the session releases the lock
  }
}

/** A unique tag so concurrent test files cannot collide on shared tables. */
export function tag(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}
