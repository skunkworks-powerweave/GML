// backup.sh — executed against stubs, not grepped.
//
// Two defects are pinned here, and neither was visible to the governance tier
// (test_109 regex-matches the endpoint literal and passed against the broken
// line):
//
//   1. THE CLIENT/SERVER MAJOR. pg_dump refuses to dump a server newer than
//      itself ("aborting because of server version mismatch"). The runbook
//      installed postgresql-client-16; a Supabase project on 17 therefore got
//      no dump at all, every night, reported only as a bare pg_dump error in a
//      log nobody reads. backup.sh must now DETECT the server major and refuse
//      a too-old client BY NAME, before attempting the dump. Nothing here
//      hardcodes which major production runs — the stubs report whatever each
//      test says the server is, and the script has to work it out.
//
//   2. THE ENDPOINT DERIVATION. `sed -E 's#^https?://([^.]+)\..*##'` had an
//      empty replacement, so the derived Storage S3 endpoint was always empty
//      and the video mirror was always skipped — while the warning told the
//      operator the endpoint "is derived from NEXT_PUBLIC_SUPABASE_URL".
//
// The sandbox (see _sandbox.mjs) has no real pg_dump, psql, rclone or aws on
// its PATH — only logging stubs — and the script copy roots itself in a temp
// directory with no access to the repository's .env.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { makeSandbox, posixish, root } from "./_sandbox.mjs";
import { BUCKETS } from "../../packages/shared/src/storage/buckets.ts";

const LIB = "scripts/lib/pg-major.sh";
const AUDIT_LIB = "scripts/lib/audit-host-job.sh";
// backup.sh sources these too; without them in the sandbox every run would fail.
const TOOLS_LIBS = ["scripts/lib/pg-tools.sh", "scripts/lib/backup-root.sh"];

function sandboxFor(files) {
  const sb = makeSandbox({ prefix: "gml-backup-" });
  for (const f of files) if (existsSync(resolve(root, f))) sb.copy(f);
  return sb;
}

/**
 * pg_dump that behaves like the real one on the only axis that matters here:
 * it aborts when the server major is newer than its own.
 */
const PG_DUMP = `
case "$1" in
  --version) echo "pg_dump (PostgreSQL) \${FAKE_PG_CLIENT_VERSION} (Ubuntu \${FAKE_PG_CLIENT_VERSION}-1.pgdg24.04+1)"; exit 0 ;;
esac
cmaj="\${FAKE_PG_CLIENT_VERSION%%.*}"
smaj=$(( FAKE_PG_SERVER_NUM / 10000 ))
if [ "$smaj" -gt "$cmaj" ]; then
  echo "pg_dump: error: aborting because of server version mismatch" >&2
  exit 1
fi
f=""
for a in "$@"; do case "$a" in --file=*) f="\${a#--file=}" ;; esac; done
head -c 20480 /dev/urandom > "$f"
`;

const PSQL = `
case "$*" in
  *"-v action="*)
    # An audit write (scripts/lib/audit-host-job.sh): the SQL is on stdin.
    cat >> "$SANDBOX_DIR/audit.sql"
    [ -n "\${FAKE_AUDIT_FAIL:-}" ] && { echo "psql: error: connection to server failed" >&2; exit 2; }
    exit 0 ;;
  *server_version_num*)
    [ -n "\${FAKE_PSQL_FAIL:-}" ] && { echo "psql: error: connection to server failed" >&2; exit 2; }
    echo "\${FAKE_PG_SERVER_NUM}" ;;
  --version*) echo "psql (PostgreSQL) \${FAKE_PG_CLIENT_VERSION}" ;;
  *) echo 1 ;;
esac
`;

/**
 * rclone that records the endpoint it was handed, fails without a source
 * secret, and — like the real s3 backend — treats a destination with no keys
 * and env_auth unset as ANONYMOUS, which a private DR bucket refuses.
 */
const RCLONE = `
printf 'rclone-endpoint=%s\\n' "\${RCLONE_CONFIG_SUPASRC_ENDPOINT}" >> "$SANDBOX_LOG"
printf 'rclone-source=%s\\n' "$2" >> "$SANDBOX_LOG"
if [ -z "\${RCLONE_CONFIG_SUPASRC_SECRET_ACCESS_KEY}" ]; then
  echo "rclone: SignatureDoesNotMatch" >&2
  exit 1
fi
if [ -z "\${RCLONE_CONFIG_DRDEST_ACCESS_KEY_ID:-}" ] && [ "\${RCLONE_CONFIG_DRDEST_ENV_AUTH:-false}" != "true" ]; then
  echo "rclone: AccessDenied: anonymous PUT to DR bucket" >&2
  exit 1
fi
`;

function backupSandbox() {
  const sb = sandboxFor(["scripts/backup.sh", LIB, AUDIT_LIB, ...TOOLS_LIBS]);
  sb.stub("pg_dump", PG_DUMP);
  sb.stub("psql", PSQL);
  sb.stub("rclone", RCLONE);
  sb.stub("aws");
  return sb;
}

function baseEnv(sb, extra = {}) {
  return {
    // Never a real server: the stubs answer, and 127.0.0.1:1 refuses anyway.
    DATABASE_URL: "postgres://stub:stub@127.0.0.1:1/stub",
    NEXT_PUBLIC_SUPABASE_URL: "https://abcdefgh.supabase.co",
    BACKUP_ROOT: posixish(resolve(sb.dir, "backups")),
    FAKE_PG_CLIENT_VERSION: "17.6",
    FAKE_PG_SERVER_NUM: "170006",
    ...extra,
  };
}

// ── the pure functions ──────────────────────────────────────────────────────

test("pg-major.sh: pg_major reads a major out of every version spelling it will meet", () => {
  const sb = sandboxFor([LIB]);
  try {
    assert.ok(sb.exists(LIB), `${LIB} must exist — backup.sh, preflight.sh and restore.sh share it`);
    const cases = [
      ["pg_dump (PostgreSQL) 17.6 (Ubuntu 17.6-1.pgdg24.04+1)", "17"],
      ["pg_dump (PostgreSQL) 16.10", "16"],
      ["psql (PostgreSQL) 18beta1", "18"],
      ["17.6", "17"],
      ["15.8 (Debian 15.8-1.pgdg120+1)", "15"],
      ["170006", "17"], // server_version_num
      ["150008", "15"],
      ["90624", "9"],
    ];
    for (const [input, want] of cases) {
      const r = sb.bash(`. ./${LIB}; pg_major '${input}'`);
      assert.equal(r.status, 0, `pg_major failed on ${input}: ${r.stderr}`);
      assert.equal(r.stdout.trim(), want, `pg_major '${input}'`);
    }
    const bad = sb.bash(`. ./${LIB}; pg_major 'not a version'`);
    assert.notEqual(bad.status, 0, "an unparseable version must be an error, not a guess");
  } finally {
    sb.cleanup();
  }
});

test("pg-major.sh: a client may dump its own major or older, never newer", () => {
  const sb = sandboxFor([LIB]);
  try {
    const verdict = (c, s) => sb.bash(`. ./${LIB}; pg_client_can_dump ${c} ${s}`).status;
    assert.equal(verdict(17, 17), 0);
    assert.equal(verdict(18, 17), 0, "a newer pg_dump reads an older server");
    assert.equal(verdict(16, 17), 1, "pg_dump 16 aborts against a 17 server");
    assert.equal(verdict(9, 17), 1);
  } finally {
    sb.cleanup();
  }
});

// ── backup.sh, executed ─────────────────────────────────────────────────────

test("backup.sh refuses a pg_dump older than the server, by name, before dumping", () => {
  const sb = backupSandbox();
  try {
    const r = sb.run("scripts/backup.sh", {
      env: baseEnv(sb, { FAKE_PG_CLIENT_VERSION: "16.4", FAKE_PG_SERVER_NUM: "170006" }),
    });
    assert.notEqual(r.status, 0, "a client that cannot dump this server must fail the run");
    assert.match(
      r.stderr,
      /\[backup\] ERROR: [^\n]*pg_dump 16[^\n]*17/,
      `the failure must name both majors, not surface as a bare pg_dump exit code. stderr:\n${r.stderr}`,
    );
    assert.match(r.stderr, /postgresql-client-17/, "and it must say which client to install");
    assert.ok(
      !sb.invocations().some((l) => /^pg_dump --format/.test(l)),
      `the version check must run BEFORE the dump is attempted. Invoked:\n${sb.invocations().join("\n")}`,
    );
  } finally {
    sb.cleanup();
  }
});

test("backup.sh accepts a client at or above the server major — whatever that major is", () => {
  for (const [client, server] of [
    ["17.6", "170006"],
    ["18.0", "170006"],
    ["16.4", "160004"],
  ]) {
    const sb = backupSandbox();
    try {
      const r = sb.run("scripts/backup.sh", {
        env: baseEnv(sb, { FAKE_PG_CLIENT_VERSION: client, FAKE_PG_SERVER_NUM: server }),
      });
      assert.equal(r.status, 0, `client ${client} vs server ${server} must be accepted.\nstderr:\n${r.stderr}`);
      assert.ok(sb.invocations().some((l) => /^pg_dump --format/.test(l)), "the dump must run");
    } finally {
      sb.cleanup();
    }
  }
});

test("backup.sh fails loudly when it cannot read the server version", () => {
  const sb = backupSandbox();
  try {
    const r = sb.run("scripts/backup.sh", { env: baseEnv(sb, { FAKE_PSQL_FAIL: "1" }) });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /\[backup\] ERROR: [^\n]*server version/i, r.stderr);
    assert.ok(!sb.invocations().some((l) => /^pg_dump --format/.test(l)));
  } finally {
    sb.cleanup();
  }
});

test("backup.sh DERIVES the Storage S3 endpoint from the project URL and mirrors the videos", () => {
  const sb = backupSandbox();
  try {
    const r = sb.run("scripts/backup.sh", {
      env: baseEnv(sb, {
        SUPABASE_S3_ACCESS_KEY_ID: "AKSTUB",
        SUPABASE_S3_SECRET_ACCESS_KEY: "SKSTUB",
        BACKUP_S3_BUCKET: "s3://gml-dr-stub",
      }),
    });
    assert.equal(r.status, 0, `backup failed:\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, /Storage mirror SKIPPED/, "with key, secret and bucket set the mirror must run");
    const endpoints = sb.invocations().filter((l) => l.startsWith("rclone-endpoint="));
    assert.ok(endpoints.length >= 4, `every bucket must be mirrored; saw:\n${sb.invocations().join("\n")}`);
    for (const e of endpoints) {
      assert.equal(e, "rclone-endpoint=https://abcdefgh.storage.supabase.co/storage/v1/s3");
    }
    // Every bucket the app writes, SCORM packages included: the list was
    // hard-coded to the first four, so scorm-packages was never copied (FR-22).
    const mirrored = sb
      .invocations()
      .filter((l) => l.startsWith("rclone-source=SUPASRC:"))
      .map((l) => l.slice("rclone-source=SUPASRC:".length));
    assert.deepEqual(mirrored.sort(), Object.values(BUCKETS).sort(), "the mirrored buckets are BUCKETS");
  } finally {
    sb.cleanup();
  }
});

test("backup.sh with a key but no secret skips the mirror loudly and STILL ships the dump", () => {
  // Without the secret check the script entered the mirror branch, rclone
  // failed on the first bucket, and `set -e` killed the run AFTER the dump but
  // BEFORE it was shipped off the box and before pruning.
  const sb = backupSandbox();
  try {
    const r = sb.run("scripts/backup.sh", {
      env: baseEnv(sb, {
        SUPABASE_S3_ENDPOINT: "https://abcdefgh.storage.supabase.co/storage/v1/s3",
        SUPABASE_S3_ACCESS_KEY_ID: "AKSTUB",
        BACKUP_S3_BUCKET: "s3://gml-dr-stub",
      }),
    });
    assert.equal(r.status, 0, `a missing secret must degrade to the warning, not kill the run:\n${r.stderr}`);
    assert.match(r.stderr, /Storage mirror SKIPPED/);
    assert.match(r.stderr, /SUPABASE_S3_SECRET_ACCESS_KEY/, "the warning must name the missing secret");
    assert.ok(
      sb.invocations().some((l) => /^aws s3 cp /.test(l)),
      `the dump must still be shipped off the box:\n${sb.invocations().join("\n")}`,
    );
    assert.ok(sb.exists("backups/last-backup.txt"), "the run must complete and stamp last-backup.txt");
  } finally {
    sb.cleanup();
  }
});

test("backup.sh's skip warning tells the operator the endpoint can be overridden", () => {
  const sb = backupSandbox();
  try {
    const r = sb.run("scripts/backup.sh", { env: baseEnv(sb) });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /Storage mirror SKIPPED/);
    assert.match(r.stderr, /SUPABASE_S3_ENDPOINT/, "a custom-domain project needs a discoverable escape hatch");
  } finally {
    sb.cleanup();
  }
});

// ── The audit row /admin/system-settings reads ──────────────────────────────
//
// W3-51. The Backup & restore panel shows the latest backup.complete row in
// audit_log, and backup.sh wrote none -- it recorded its run only in
// last-backup.txt on the host -- so the panel could never show a real time,
// nor that backups had stopped. The script now appends one row per run,
// through psql variables (never SQL built from strings), and a failure to
// write it is a warning, never a failed backup.

/** The audit writes backup.sh made: [{ action, meta, url }]. */
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

test("a completed backup records backup.complete in the audit log", () => {
  const sb = backupSandbox();
  try {
    const e = baseEnv(sb);
    const r = sb.run("scripts/backup.sh", { env: e });
    assert.equal(r.status, 0, r.stderr);
    const writes = auditWrites(sb);
    assert.equal(
      writes.length,
      1,
      `a backup must leave exactly one row for /admin/system-settings to read; it wrote ${writes.length}.\n` +
        sb.invocations().join("\n"),
    );
    const [w] = writes;
    assert.equal(w.action, "backup.complete");
    assert.equal(w.url, e.DATABASE_URL, "the row goes to the database that was backed up");
    assert.match(w.meta.dump, /^gml-\d{8}T\d{6}Z\.dump\.gz$/);
    assert.ok(w.meta.bytes > 10240, JSON.stringify(w.meta));
    assert.equal(w.meta.storage_mirrored, false, "no S3 keys here: the mirror was skipped, and the row says so");
    assert.equal(w.meta.shipped_offsite, false);
    const sql = sb.read("audit.sql");
    assert.match(sql, /INSERT INTO audit_log \(user_id, action, entity_type, entity_id, metadata\)/);
    assert.match(sql, /:'action'/, "the values go in as psql variables, quoted by psql");
    assert.match(sql, /:'meta'::jsonb/);
  } finally {
    sb.cleanup();
  }
});

test("a backup that mirrors and ships says so in its audit row", () => {
  const sb = backupSandbox();
  try {
    const r = sb.run("scripts/backup.sh", {
      env: baseEnv(sb, {
        SUPABASE_S3_ACCESS_KEY_ID: "AKSTUB",
        SUPABASE_S3_SECRET_ACCESS_KEY: "SKSTUB",
        BACKUP_S3_BUCKET: "s3://gml-dr-stub",
      }),
    });
    assert.equal(r.status, 0, r.stderr);
    const [w] = auditWrites(sb);
    assert.equal(w?.meta.storage_mirrored, true, JSON.stringify(w));
    assert.equal(w?.meta.shipped_offsite, true, JSON.stringify(w));
  } finally {
    sb.cleanup();
  }
});

test("a failed backup records backup.failed, with the reason", () => {
  const sb = backupSandbox();
  try {
    const r = sb.run("scripts/backup.sh", {
      env: baseEnv(sb, { FAKE_PG_CLIENT_VERSION: "16.4", FAKE_PG_SERVER_NUM: "170006" }),
    });
    assert.notEqual(r.status, 0);
    const writes = auditWrites(sb);
    assert.deepEqual(writes.map((w) => w.action), ["backup.failed"], sb.invocations().join("\n"));
    assert.match(writes[0].meta.error, /pg_dump 16/, "the row carries what failed");
  } finally {
    sb.cleanup();
  }
});

test("an audit write that fails does not fail the backup", () => {
  const sb = backupSandbox();
  try {
    const r = sb.run("scripts/backup.sh", { env: baseEnv(sb, { FAKE_AUDIT_FAIL: "1" }) });
    assert.equal(r.status, 0, `the dump is the backup; the audit row is a report of it:\n${r.stderr}`);
    assert.match(r.stderr, /WARNING: could not record backup\.complete in the audit log/, r.stderr);
    assert.ok(sb.exists("backups/last-backup.txt"));
  } finally {
    sb.cleanup();
  }
});

// ── no PostgreSQL client on the host: the tools come from Docker ───────────
//
// The first staging server had Docker (every deploy needs it) and no
// PostgreSQL client, so no backup could run and, from its second deploy on,
// the SM-5 gate refused every deploy. scripts/lib/pg-tools.sh runs pg_dump and
// psql from the official postgres image instead, at the server's own major.

/**
 * docker, answering as the postgres image would for whichever tool and image
 * it is asked to run. The major is read from the image tag the script chose.
 */
const DOCKER_PG = `
img=""
for a in "$@"; do case "$a" in postgres:*) img="$a"; break ;; esac; done
major="\${img#postgres:}"; major="\${major%%-*}"
case "$*" in
  *" pg_dump --version"*) echo "pg_dump (PostgreSQL) \${major}.0"; exit 0 ;;
  *" pg_dump "*)
    case "$*" in *--file=*) echo "pg_dump: could not open output file: No such file or directory" >&2; exit 1 ;; esac
    head -c 20480 /dev/urandom; exit 0 ;;
  *"-v action="*) cat >> "$SANDBOX_DIR/audit.sql"; exit 0 ;;
  *server_version_num*) echo "\${FAKE_PG_SERVER_NUM}"; exit 0 ;;
esac
exit 0
`;

function dockerToolsSandbox({ hostClient = false } = {}) {
  const sb = sandboxFor(["scripts/backup.sh", LIB, AUDIT_LIB, ...TOOLS_LIBS]);
  if (hostClient) {
    sb.stub("pg_dump", PG_DUMP);
    sb.stub("psql", PSQL);
  }
  sb.stub("docker", DOCKER_PG);
  return sb;
}

function dumps(sb, root = "backups") {
  const r = sb.bash(`ls ${root}/db 2>/dev/null | grep -E '^gml-.*\.dump\.gz$' || true`);
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

test("with no PostgreSQL client on the host, backup.sh dumps through Docker at the server's own major", () => {
  const sb = dockerToolsSandbox();
  try {
    const r = sb.run("scripts/backup.sh", { env: baseEnv(sb, { FAKE_PG_SERVER_NUM: "170006" }) });
    const calls = sb.invocations();
    assert.equal(r.status, 0, `the backup must not need a client installed on the host:\n${r.stderr}\n${calls.join("\n")}`);
    const dump = calls.find((l) => /^docker run .* pg_dump --format=custom/.test(l));
    assert.ok(dump, `pg_dump must run from the postgres image:\n${calls.join("\n")}`);
    assert.match(dump, /--rm --network host/, "a throwaway container on the host's network");
    assert.doesNotMatch(dump, / -i /, "pg_dump reads nothing on stdin, so it must not drain the caller's");
    assert.ok(
      calls.some((l) => /^docker run --rm -i --network host .* psql .*-v action=/.test(l)),
      `the audit write sends its SQL on stdin, so that psql needs -i:\n${calls.join("\n")}`,
    );
    assert.match(dump, /postgres:17-alpine pg_dump/, "the tools must be the server's major");
    assert.doesNotMatch(dump, /--file=/, "--file names a path INSIDE the container, which vanishes with it");
    assert.equal(dumps(sb).length, 1, "the dump must land on the host");
    assert.equal(
      sb.read(`backups/db/${dumps(sb)[0]}.pg-tools-image`).trim(),
      "postgres:17-alpine",
      "restore.sh must be told which image wrote THIS dump",
    );
    assert.match(r.stdout, /from Docker/i, "the log must say where the tools came from");
  } finally {
    sb.cleanup();
  }
});

test("backup.sh moves the Docker tools to a newer server's major instead of failing", () => {
  const sb = dockerToolsSandbox();
  try {
    const r = sb.run("scripts/backup.sh", { env: baseEnv(sb, { FAKE_PG_SERVER_NUM: "180002" }) });
    const calls = sb.invocations();
    assert.equal(r.status, 0, `${r.stderr}\n${calls.join("\n")}`);
    assert.ok(
      calls.some((l) => /^docker run .*postgres:18-alpine pg_dump --format=custom/.test(l)),
      `a PostgreSQL 18 server must be dumped by pg_dump 18:\n${calls.join("\n")}`,
    );
    assert.equal(sb.read(`backups/db/${dumps(sb)[0]}.pg-tools-image`).trim(), "postgres:18-alpine");
  } finally {
    sb.cleanup();
  }
});

test("a host client too old for the server is replaced by Docker when Docker is there", () => {
  const sb = dockerToolsSandbox({ hostClient: true });
  try {
    const r = sb.run("scripts/backup.sh", {
      env: baseEnv(sb, { FAKE_PG_CLIENT_VERSION: "16.4", FAKE_PG_SERVER_NUM: "170006" }),
    });
    const calls = sb.invocations();
    assert.equal(r.status, 0, `${r.stderr}\n${calls.join("\n")}`);
    assert.ok(calls.some((l) => /^docker run .*postgres:17-alpine pg_dump --format=custom/.test(l)), calls.join("\n"));
    assert.ok(!calls.some((l) => /^pg_dump --format/.test(l)), "the too-old host pg_dump must not be used for the dump");
  } finally {
    sb.cleanup();
  }
});

test("with neither a PostgreSQL client nor Docker, backup.sh says what to install", () => {
  const sb = sandboxFor(["scripts/backup.sh", LIB, AUDIT_LIB, ...TOOLS_LIBS]);
  try {
    const r = sb.run("scripts/backup.sh", { env: baseEnv(sb) });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /postgresql-client/, r.stderr);
    assert.match(r.stderr, /docker/i, "Docker is the other way to get the tools, so the message must name it");
  } finally {
    sb.cleanup();
  }
});

test("with no BACKUP_ROOT and a system directory it cannot write, backup.sh keeps dumps in workspace/backups", () => {
  const sb = dockerToolsSandbox({ hostClient: true });
  try {
    sb.write("blocker", "a file where a directory would have to be, so mkdir -p fails");
    const e = baseEnv(sb, {
      BACKUP_ROOT_SYSTEM_DIR: posixish(resolve(sb.dir, "blocker", "backups")),
      BACKUP_ROOT_FALLBACK: "1", // as deploy.sh runs it
    });
    delete e.BACKUP_ROOT;
    const r = sb.run("scripts/backup.sh", { env: e });
    assert.equal(r.status, 0, `the deploy's own account must be able to back up:\n${r.stderr}`);
    assert.equal(dumps(sb, "workspace/backups").length, 1, "the dump must be in the checkout's workspace/backups");
    assert.match(r.stderr, /not writable[\s\S]*workspace\/backups/, "the fallback must be said, not silent");
  } finally {
    sb.cleanup();
  }
});

test("a BACKUP_ROOT copied from .env.example that this account cannot write falls back the same way", () => {
  // .env.example sets BACKUP_ROOT=/var/lib/gml/backups explicitly, so most .env
  // files carry it. The deploy's account usually cannot write there; a backup
  // that fails on it locks the deploy out exactly as no backup did.
  const sb = dockerToolsSandbox({ hostClient: true });
  try {
    sb.write("blocker", "a file where a directory would have to be");
    const r = sb.run("scripts/backup.sh", {
      env: baseEnv(sb, { BACKUP_ROOT: posixish(resolve(sb.dir, "blocker", "backups")), BACKUP_ROOT_FALLBACK: "1" }),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(dumps(sb, "workspace/backups").length, 1);
    assert.match(r.stderr, /blocker\/backups is not writable/, r.stderr);
  } finally {
    sb.cleanup();
  }
});

test("outside a deploy, an unwritable BACKUP_ROOT still fails the backup loudly, as before", () => {
  // The fallback is deploy.sh's (BACKUP_ROOT_FALLBACK=1). A nightly cron run whose
  // backup disk failed to mount must say so, not quietly fill the root disk.
  const sb = dockerToolsSandbox({ hostClient: true });
  try {
    sb.write("blocker", "a file where a directory would have to be");
    const r = sb.run("scripts/backup.sh", {
      env: baseEnv(sb, { BACKUP_ROOT: posixish(resolve(sb.dir, "blocker", "backups")) }),
    });
    assert.notEqual(r.status, 0, "the nightly backup must fail on a backup directory it cannot write");
    assert.match(r.stderr, /cannot create directory.*blocker/, r.stderr);
    assert.equal(dumps(sb, "workspace/backups").length, 0);
  } finally {
    sb.cleanup();
  }
});

test("BACKUP_DB_ONLY=1 (a deploy's backup) dumps the database and leaves the video mirror and the off-site copy to the nightly run", () => {
  // deploy.sh needs a dump to drill, quickly. The first video mirror can be
  // ~100 GB, and a half-configured mirror (keys set, rclone missing) or a
  // refused `aws s3 cp` used to fail the whole backup after a good dump.
  const sb = sandboxFor(["scripts/backup.sh", LIB, AUDIT_LIB, ...TOOLS_LIBS]);
  try {
    sb.stub("pg_dump", PG_DUMP);
    sb.stub("psql", PSQL);
    sb.stub("aws", 'echo "upload failed: AccessDenied" >&2; exit 1');
    // No rclone at all, although the mirror is configured.
    const r = sb.run("scripts/backup.sh", {
      env: baseEnv(sb, {
        BACKUP_DB_ONLY: "1",
        SUPABASE_S3_ACCESS_KEY_ID: "k",
        SUPABASE_S3_SECRET_ACCESS_KEY: "s",
        BACKUP_S3_BUCKET: "s3://dr",
      }),
    });
    const calls = sb.invocations();
    assert.equal(r.status, 0, `${r.stderr}\n${calls.join("\n")}`);
    assert.equal(dumps(sb).length, 1);
    assert.ok(!calls.some((l) => /^(rclone|aws) /.test(l)), calls.join("\n"));
    assert.match(r.stdout, /database only/i, "the log must say what was left out, and why");
  } finally {
    sb.cleanup();
  }
});
