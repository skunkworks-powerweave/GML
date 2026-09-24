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

const LIB = "scripts/lib/pg-major.sh";

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
  const sb = sandboxFor(["scripts/backup.sh", LIB]);
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
