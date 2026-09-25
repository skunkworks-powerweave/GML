// restore.sh — the weekly SM-5 drill, executed against stubs.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// The drill restored into postgres://postgres:postgres@127.0.0.1:5432 — a local
// Postgres SERVER that nothing installs. docker-compose.yml deliberately has no
// postgres service and the runbook installs the client only, so on the real box
// the Sunday cron died at the first psql with "connection refused", wrote no
// stamp, and left a broken drill indistinguishable from one that never ran.
//
// The drill must now bring its own database: a throwaway container whose
// Postgres major is READ FROM THE DUMP (never assumed), removed on every exit
// path; and a failed drill must leave a failure stamp the SM-5 gate can report.
//
// The sandbox PATH has no real docker, psql or pg_restore — only logging stubs
// — and no .env. See _sandbox.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { makeSandbox, posixish, root } from "./_sandbox.mjs";

const FILES = [
  "scripts/restore.sh",
  "scripts/lib/pg-major.sh",
  "scripts/lib/audit-host-job.sh",
  "scripts/check-restore-drill.mjs",
];

const DOCKER = `
case "$1" in
  run) echo "0123456789abcdef" ;;
esac
exit 0
`;

const PSQL = `
case "$*" in
  *"-v action="*)
    # An audit write (scripts/lib/audit-host-job.sh): the SQL is on stdin.
    printf 'audit-pgpassword=%s\\n' "\${PGPASSWORD:-}" >> "$SANDBOX_LOG"
    cat >> "$SANDBOX_DIR/audit.sql"
    exit 0 ;;
  *"select 1"*) exit 0 ;;
  *"CREATE DATABASE"*) [ -n "\${FAKE_CREATE_FAIL:-}" ] && { echo "psql: error: could not create" >&2; exit 1; }; exit 0 ;;
  *"DROP DATABASE"*) exit 0 ;;
  *information_schema.tables*) echo 45 ;;
  *public.users*) echo 3 ;;
  *public.audit_log*) echo 10 ;;
  *public.video_submissions*) echo 2 ;;
  *) exit 0 ;;
esac
`;

const PG_RESTORE = `
list=0
for a in "$@"; do [ "$a" = "-l" ] && list=1; done
cat >/dev/null
if [ "$list" = 1 ]; then
  [ -n "\${FAKE_DUMP_HEADER_MISSING:-}" ] && exit 1
  printf ';\\n;     Dumped from database version: %s\\n;     Dumped by pg_dump version: %s\\n' "\${FAKE_DUMP_SERVER_VERSION}" "\${FAKE_DUMP_SERVER_VERSION}"
fi
exit 0
`;

function drillSandbox({ withDump = true } = {}) {
  const sb = makeSandbox({ prefix: "gml-restore-" });
  for (const f of FILES) if (existsSync(resolve(root, f))) sb.copy(f);
  sb.stub("docker", DOCKER);
  sb.stub("psql", PSQL);
  sb.stub("pg_restore", PG_RESTORE);
  if (withDump) {
    sb.write("backups/db/gml-20260920T020000Z.dump.gz", gzipSync(Buffer.from("PGDMP-not-a-real-dump")));
  }
  return sb;
}

function env(sb, extra = {}) {
  return {
    BACKUP_ROOT: posixish(join(sb.dir, "backups")),
    FAKE_DUMP_SERVER_VERSION: "17.6",
    DRILL_READY_TIMEOUT_SECONDS: "5",
    ...extra,
  };
}

function stamp(sb) {
  const p = "workspace/last_restore_drill.json";
  assert.ok(sb.exists(p), "the drill must leave a stamp whatever the outcome — a missing file hides a broken drill");
  return JSON.parse(sb.read(p));
}

/** The SM-5 deploy gate, run for real (it reads only the stamp next to it). */
function gate(sb) {
  return spawnSync(process.execPath, [join(sb.dir, "scripts", "check-restore-drill.mjs")], {
    encoding: "utf8",
    timeout: 30_000,
    env: { NODE_ENV: "production", PATH: process.env.PATH },
  });
}

test("the drill brings its own throwaway Postgres, of the dump's own major", () => {
  const sb = drillSandbox();
  try {
    const r = sb.run("scripts/restore.sh", { env: env(sb) });
    assert.equal(r.status, 0, `the drill failed:\n${r.stderr}`);
    const calls = sb.invocations();
    const run = calls.find((l) => /^docker run /.test(l));
    assert.ok(run, `the drill must start a database for itself; nothing installs one. Invoked:\n${calls.join("\n")}`);
    assert.match(run, /postgres:17-alpine/, "the drill server's major must be the one the dump came from");
    assert.match(run, /-p 127\.0\.0\.1:\d+:5432/, "published on loopback only");
    assert.match(run, /--rm/);
    for (const p of calls.filter((l) => /^psql /.test(l))) {
      assert.match(p, /127\.0\.0\.1/, `every drill query must target the throwaway database: ${p}`);
      assert.doesNotMatch(p, /supabase/i);
    }
    const runIdx = calls.indexOf(run);
    assert.ok(
      calls.slice(runIdx + 1).some((l) => /^docker rm -f /.test(l)),
      "the container must be removed when the drill ends — as a cron job nothing else would",
    );
    const s = stamp(sb);
    assert.equal(s.result, "ok");
    assert.equal(s.tables, 45);
    assert.equal(gate(sb).status, 0, "a fresh ok stamp must satisfy the SM-5 gate");
  } finally {
    sb.cleanup();
  }
});

test("the drill server follows the dump, not a hardcoded version", () => {
  const sb = drillSandbox();
  try {
    const r = sb.run("scripts/restore.sh", { env: env(sb, { FAKE_DUMP_SERVER_VERSION: "15.8" }) });
    assert.equal(r.status, 0, r.stderr);
    const run = sb.invocations().find((l) => /^docker run /.test(l));
    assert.match(run ?? "", /postgres:15-alpine/);
  } finally {
    sb.cleanup();
  }
});

test("a drill that fails mid-way still removes its container and stamps the failure", () => {
  const sb = drillSandbox();
  try {
    const r = sb.run("scripts/restore.sh", { env: env(sb, { FAKE_CREATE_FAIL: "1" }) });
    assert.notEqual(r.status, 0);
    const calls = sb.invocations();
    const runIdx = calls.findIndex((l) => /^docker run /.test(l));
    assert.ok(runIdx >= 0, `expected a drill container to have been started:\n${calls.join("\n")}`);
    assert.ok(
      calls.slice(runIdx + 1).some((l) => /^docker rm -f /.test(l)),
      "a failed drill must not leave a stray container behind",
    );
    const s = stamp(sb);
    assert.equal(s.result, "failed");
    assert.ok(Date.now() - Date.parse(s.ranAt) < 10 * 60_000, "ranAt must be the time of THIS run");
    assert.ok(typeof s.error === "string" && s.error.length > 0, "the stamp must say what went wrong");
  } finally {
    sb.cleanup();
  }
});

test("no backups: the drill stamps a failure, and the SM-5 gate reports the real reason", () => {
  const sb = drillSandbox({ withDump: false });
  try {
    const r = sb.run("scripts/restore.sh", { env: env(sb) });
    assert.notEqual(r.status, 0);
    const s = stamp(sb);
    assert.equal(s.result, "failed");
    assert.match(s.error, /no backups found/);
    const g = gate(sb);
    assert.notEqual(g.status, 0, "a failed drill must block a production deploy");
    assert.match(g.stderr, /failed/);
    assert.match(g.stderr, /no backups found/, "the gate must pass on WHY, not just that it failed");
    assert.ok(
      !sb.invocations().some((l) => /^docker run /.test(l)),
      "with nothing to restore, no container should be started",
    );
  } finally {
    sb.cleanup();
  }
});

test("an unreadable dump header fails loudly instead of guessing a server version", () => {
  const sb = drillSandbox();
  try {
    const r = sb.run("scripts/restore.sh", { env: env(sb, { FAKE_DUMP_HEADER_MISSING: "1" }) });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /DRILL_IMAGE/, "the operator must be told how to choose the drill server by hand");
    assert.equal(stamp(sb).result, "failed");
  } finally {
    sb.cleanup();
  }
});

test("an explicit DRILL_HOST is used as given, keeps its query string, and starts no container", () => {
  const sb = drillSandbox();
  try {
    const r = sb.run("scripts/restore.sh", {
      env: env(sb, { DRILL_HOST: "postgres://drill:pw@127.0.0.1:6000/postgres?sslmode=disable" }),
    });
    assert.equal(r.status, 0, r.stderr);
    const calls = sb.invocations();
    assert.ok(!calls.some((l) => /^docker run /.test(l)), "an operator-supplied server needs no container");
    const restore = calls.find((l) => /^pg_restore .*--dbname=/.test(l));
    assert.match(
      restore ?? "",
      /--dbname=postgres:\/\/drill:pw@127\.0\.0\.1:6000\/gml_restore_drill\?sslmode=disable/,
      "the database name is swapped in; the query string must survive (it used to be silently dropped)",
    );
  } finally {
    sb.cleanup();
  }
});

test("a DRILL_HOST pointing at Supabase is refused", () => {
  const sb = drillSandbox();
  try {
    const r = sb.run("scripts/restore.sh", {
      env: env(sb, { DRILL_HOST: "postgres://u:p@aws-0-ap-south-1.pooler.supabase.com:5432/postgres" }),
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /never production/);
    assert.ok(!sb.invocations().some((l) => /^(psql|pg_restore) /.test(l) && !/ -l/.test(l)));
  } finally {
    sb.cleanup();
  }
});

// ── The audit row /admin/system-settings reads ──────────────────────────────
//
// W3-51. The panel shows the latest restore.complete row, and the drill
// recorded its result only in workspace/last_restore_drill.json. It now also
// appends one row to the LIVE database's audit_log -- the one thing it writes
// there -- and every other statement still goes to the throwaway server.

const LIVE = "postgres://live:secret@db.abcdefgh.supabase.co:5432/postgres";

function auditWrites(sb) {
  return sb
    .invocations()
    .filter((l) => /^psql .*-v action=/.test(l))
    .map((l) => ({
      action: /-v action=(\S+)/.exec(l)?.[1],
      meta: JSON.parse(/-v meta=(\{.*\})$/.exec(l)?.[1] ?? "null"),
      url: l.split(" ")[1],
    }));
}

test("a passing drill records restore.complete in the live audit log, and nothing else there", () => {
  const sb = drillSandbox();
  try {
    const r = sb.run("scripts/restore.sh", { env: env(sb, { DATABASE_URL: LIVE }) });
    assert.equal(r.status, 0, r.stderr);
    const writes = auditWrites(sb);
    assert.deepEqual(
      writes.map((w) => [w.action, w.url]),
      [["restore.complete", LIVE]],
      `the drill must leave one restore.complete row where /admin/system-settings reads it:\n${sb.invocations().join("\n")}`,
    );
    assert.deepEqual(writes[0].meta, {
      source: "gml-20260920T020000Z.dump.gz",
      backup_age_days: writes[0].meta.backup_age_days,
      tables: 45,
      users: 3,
      storage_verified: false,
    });
    assert.ok(Number.isInteger(writes[0].meta.backup_age_days));
    const live = sb.invocations().filter((l) => l.includes("supabase.co"));
    assert.equal(live.length, 1, `the audit row is the only thing the drill sends to the live database:\n${live.join("\n")}`);
    assert.ok(
      sb.invocations().includes("audit-pgpassword="),
      "the throwaway server's PGPASSWORD must not be offered to the live database",
    );
    assert.match(sb.read("audit.sql"), /^INSERT INTO audit_log \(user_id, action, entity_type, entity_id, metadata\)/m);
  } finally {
    sb.cleanup();
  }
});

test("a failed drill records restore.failed, with the reason", () => {
  const sb = drillSandbox();
  try {
    const r = sb.run("scripts/restore.sh", { env: env(sb, { DATABASE_URL: LIVE, FAKE_CREATE_FAIL: "1" }) });
    assert.notEqual(r.status, 0);
    const writes = auditWrites(sb);
    assert.deepEqual(writes.map((w) => w.action), ["restore.failed"], sb.invocations().join("\n"));
    assert.equal(writes[0].meta.source, "gml-20260920T020000Z.dump.gz");
    assert.match(writes[0].meta.error, /CREATE DATABASE/, "the row carries what failed");
    assert.equal(stamp(sb).result, "failed", "the stamp the SM-5 gate reads is written as before");
  } finally {
    sb.cleanup();
  }
});

test("without DATABASE_URL the drill still runs, and says the panel will not show it", () => {
  const sb = drillSandbox();
  try {
    const r = sb.run("scripts/restore.sh", { env: env(sb) });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(auditWrites(sb), []);
    assert.match(r.stderr, /DATABASE_URL is not set -- restore\.complete not recorded/);
  } finally {
    sb.cleanup();
  }
});
