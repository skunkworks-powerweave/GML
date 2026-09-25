// preflight.sh — executed against stubs (structural sandbox: _sandbox.mjs).
//
// preflight.sh is the read-only check an operator runs before a first deploy.
// Each test below pins a place where it used to say PASS (or nothing) about a
// condition that breaks the deploy or the backups:
//
//   Host       node and pnpm were never checked, though deploy.sh cannot run
//              without them (node dies before the build; a missing pnpm fails
//              AFTER a working deploy and reads as a failed one). jq, which the
//              runbooks pipe to, was not mentioned.
//   Backups    "pg_dump installed" was a PASS for a client that cannot dump
//              the server (pg_dump aborts on a newer server major), and the
//              hint named postgresql-client-16 whatever the server was.
//   Mirror     it demanded SUPABASE_S3_ENDPOINT (derivable, so optional) and
//              only the short credential spellings, warning on a working
//              configuration.
//   TLS CA     "the pooler certificate will be verified" was printed from the
//              .env value — which no container receives.
//   Upload     the 600 MB probe's reservation was never cleaned up, though its
//              comment said it was.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeSandbox, root } from "./_sandbox.mjs";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIBstubstubstub\n-----END CERTIFICATE-----\n";

const BASE_ENV_FILE = {
  DOMAIN: "localhost",
  ACME_EMAIL: "ops@example.test",
  DATABASE_URL: "postgres://stub:stub@127.0.0.1:5432/stub",
  NEXT_PUBLIC_SUPABASE_URL: "https://abcdefgh.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "stub",
  SUPABASE_SECRET_KEY: "stub",
  WHATSAPP_APP_SECRET: "stub",
};

const CURL = `
url=""; method=GET; hdrfile=""; prev=""
for a in "$@"; do
  case "$prev" in -X) method="$a" ;; -D) hdrfile="$a" ;; esac
  case "$a" in http://*|https://*) url="$a" ;; esac
  prev="$a"
done
printf 'curl-req %s %s\\n' "$method" "$url" >> "$SANDBOX_LOG"
code=000
case "$method $url" in
  "GET "*"/auth/v1/health") code=200 ;;
  "POST "*"/storage/v1/upload/resumable")
    code="\${FAKE_UPLOAD_CODE:-201}"
    if [ -n "$hdrfile" ]; then
      printf 'HTTP/1.1 %s Created\\r\\nLocation: https://abcdefgh.supabase.co/storage/v1/upload/resumable/probe-123\\r\\nTus-Resumable: 1.0.0\\r\\n\\r\\n' "$code" > "$hdrfile"
    fi ;;
  "DELETE "*"/storage/v1/upload/resumable/probe-123") code=204 ;;
esac
printf '%s' "$code"
`;

function preflightSandbox({ envFile = {}, tools = {} } = {}) {
  const sb = makeSandbox({ prefix: "gml-preflight-" });
  for (const f of ["scripts/preflight.sh", "scripts/lib/pg-major.sh", "docker/supabase-ca.crt"]) {
    if (existsSync(resolve(root, f))) sb.copy(f);
  }
  const vars = { ...BASE_ENV_FILE, ...envFile };
  const text = Object.entries(vars)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  chmodSync(sb.write(".env", `${text}\n`), 0o600);

  const t = {
    docker: true,
    node: "v22.19.0",
    pnpm: "10.33.4",
    jq: true,
    psql: true,
    pg_dump: "17.6",
    ...tools,
  };
  if (t.docker) {
    sb.stub(
      "docker",
      `case "$*" in
  --version) echo "Docker version 27.3.1, build ce12230" ;;
  "compose version --short") echo "2.29.7" ;;
esac
exit 0`,
    );
  }
  if (t.node) sb.stub("node", `[ "$1" = "--version" ] && echo "${t.node}"; exit 0`);
  if (t.pnpm) sb.stub("pnpm", `[ "$1" = "--version" ] && echo "${t.pnpm}"; exit 0`);
  if (t.jq) sb.stub("jq", "exit 0");
  if (t.psql) {
    sb.stub(
      "psql",
      `case "$*" in
  *server_version_num*) echo "\${FAKE_PG_SERVER_NUM:-170006}" ;;
  *) echo 1 ;;
esac`,
    );
  }
  if (t.pg_dump) sb.stub("pg_dump", `[ "$1" = "--version" ] && echo "pg_dump (PostgreSQL) ${t.pg_dump}"; exit 0`);
  if (t.rclone) sb.stub("rclone", "exit 0");
  sb.stub("curl", CURL);
  // A fixed, roomy disk so the verdict does not depend on the test machine.
  sb.stub(
    "df",
    `printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/stub 104857600 1 94371840 1%% /\\n'`,
  );
  return sb;
}

function run(opts = {}, env = {}) {
  const sb = preflightSandbox(opts);
  try {
    const r = sb.run("scripts/preflight.sh", { env });
    return { ...r, calls: sb.invocations(), out: `${r.stdout}${r.stderr}` };
  } finally {
    sb.cleanup();
  }
}

const line = (out, level, re) =>
  out.split(/\r?\n/).find((l) => new RegExp(`^\\s+${level}\\s`).test(l) && re.test(l));

// ── Host ─────────────────────────────────────────────────────────────────────

test("Host: a missing node or pnpm is a FAIL that points at the runbook", () => {
  const r = run({ tools: { node: false, pnpm: false } });
  assert.ok(line(r.out, "FAIL", /\bnode\b/), `expected a FAIL for node:\n${r.out}`);
  assert.ok(line(r.out, "FAIL", /\bpnpm\b/), `expected a FAIL for pnpm:\n${r.out}`);
  assert.match(r.out, /README-deploy\.md 2\.5/, "the fix hint must name the section that installs them");
  assert.equal(r.status, 1, "a host that cannot run deploy.sh is not safe to deploy");
});

test("Host: node older than package.json's engines floor is a FAIL", () => {
  const r = run({ tools: { node: "v20.11.1" } });
  assert.ok(line(r.out, "FAIL", /node/), `expected a FAIL for node 20:\n${r.out}`);
});

test("Host: jq absent is a WARN, not a blocker", () => {
  const r = run({ tools: { jq: false } });
  assert.ok(line(r.out, "WARN", /\bjq\b/), `expected a WARN for jq:\n${r.out}`);
  assert.ok(!line(r.out, "FAIL", /\bjq\b/));
});

test("Host: a complete toolchain passes", () => {
  const r = run();
  for (const t of [/node/, /pnpm/, /\bjq\b/, /docker present/]) {
    assert.ok(line(r.out, "PASS", t), `expected PASS ${t}:\n${r.out}`);
  }
  assert.equal(r.status, 0, `a fully prepared host must be safe to deploy:\n${r.out}`);
});

// ── Backups: the client/server major ─────────────────────────────────────────

test("Backups: pg_dump older than the server is a FAIL naming both majors", () => {
  const r = run({ tools: { pg_dump: "16.4" } }, { FAKE_PG_SERVER_NUM: "170006" });
  const fail = line(r.out, "FAIL", /pg_dump/);
  assert.ok(fail, `a pg_dump that cannot dump this server must BLOCK, not pass or warn:\n${r.out}`);
  assert.match(fail, /16/);
  assert.match(fail, /17/);
  assert.match(r.out, /postgresql-client-17/, "the fix must name the client for THIS server");
  assert.ok(!line(r.out, "PASS", /pg_dump installed/));
  assert.equal(r.status, 1);
});

test("Backups: a matching or newer pg_dump passes, whatever the server major", () => {
  for (const [client, server] of [["17.6", "170006"], ["18.0", "170006"], ["15.8", "150008"]]) {
    const r = run({ tools: { pg_dump: client } }, { FAKE_PG_SERVER_NUM: server });
    assert.ok(line(r.out, "PASS", /pg_dump/), `client ${client} vs server ${server}:\n${r.out}`);
    assert.ok(!line(r.out, "FAIL", /pg_dump/));
  }
});

test("Backups: with no pg_dump, the hint names the server's client, not a guessed one", () => {
  const r = run({ tools: { pg_dump: false } }, { FAKE_PG_SERVER_NUM: "170006" });
  assert.match(r.out, /pg_dump[^\n]*postgresql-client-17/, r.out);
  assert.doesNotMatch(r.out, /postgresql-client-16/);
});

// ── Backups: the Storage mirror ──────────────────────────────────────────────

test("Mirror: the dashboard credential names, with no endpoint, count as configured", () => {
  const r = run({
    envFile: {
      SUPABASE_S3_ACCESS_KEY_ID: "AK",
      SUPABASE_S3_SECRET_ACCESS_KEY: "SK",
      BACKUP_S3_BUCKET: "s3://dr",
    },
    tools: { rclone: true },
  });
  assert.ok(line(r.out, "PASS", /Storage mirror configured/), `a working mirror config must not warn:\n${r.out}`);
});

test("Mirror: a key without its secret is NOT configured", () => {
  const r = run({ envFile: { SUPABASE_S3_ACCESS_KEY_ID: "AK", BACKUP_S3_BUCKET: "s3://dr" } });
  assert.ok(line(r.out, "WARN", /Storage mirror NOT configured/), r.out);
  assert.match(r.out, /SUPABASE_S3_SECRET_ACCESS_KEY/, "the warning must name the dashboard spelling");
});

// ── TLS to Postgres ──────────────────────────────────────────────────────────

test("CA: a SUPABASE_CA_CERT in .env alone does not claim verification — no container reads it", () => {
  const r = run({ envFile: { SUPABASE_CA_CERT: "/etc/gml/supabase-ca.crt" } });
  assert.ok(
    !/will be verified/.test(r.out),
    `preflight claimed a TLS guarantee the containers do not have:\n${r.out}`,
  );
  assert.match(r.out, /docker\/supabase-ca\.crt/, "it must say where the containers actually read the CA");
});

test("CA: docker/supabase-ca.crt holding a PEM is what makes it PASS", () => {
  const sb = preflightSandbox();
  try {
    sb.write("docker/supabase-ca.crt", PEM);
    const r = sb.run("scripts/preflight.sh");
    assert.ok(line(`${r.stdout}`, "PASS", /verified/), r.stdout);
  } finally {
    sb.cleanup();
  }
});

test("CA: docker/supabase-ca.crt holding something that is not a PEM is a FAIL", () => {
  const sb = preflightSandbox();
  try {
    sb.write("docker/supabase-ca.crt", "not a certificate\n");
    const r = sb.run("scripts/preflight.sh");
    assert.ok(line(r.stdout, "FAIL", /supabase-ca\.crt/), r.stdout);
  } finally {
    sb.cleanup();
  }
});

// ── Upload ceiling ───────────────────────────────────────────────────────────

test("Upload: an accepted 600 MB probe deletes the reservation it created", () => {
  const r = run();
  assert.ok(line(r.out, "PASS", /600 MB upload is accepted/), r.out);
  assert.ok(
    r.calls.includes("curl-req DELETE https://abcdefgh.supabase.co/storage/v1/upload/resumable/probe-123"),
    `the probe must terminate its tus reservation:\n${r.calls.join("\n")}`,
  );
});

test("Upload: the 50 MB project cap is still a FAIL", () => {
  const r = run({}, { FAKE_UPLOAD_CODE: "413" });
  assert.ok(line(r.out, "FAIL", /600 MB upload/), r.out);
});

// ── WhatsApp is optional ─────────────────────────────────────────────────────
//
// The webhook route refuses every request while WHATSAPP_APP_SECRET is unset
// (it fails closed), so requiring the secret to deploy added no protection and
// made WhatsApp -- an integration the programme switches on later -- a
// prerequisite for running the LMS at all.

test("WhatsApp: an unconfigured integration is a WARN that says ingest is off, not a blocker", () => {
  const r = run({ envFile: { WHATSAPP_APP_SECRET: undefined } });
  assert.ok(!line(r.out, "FAIL", /WHATSAPP/), `an optional integration must not fail preflight:\n${r.out}`);
  assert.ok(line(r.out, "WARN", /WHATSAPP_APP_SECRET/), `the operator must be told WhatsApp ingest is off:\n${r.out}`);
  assert.equal(r.status, 0, `a host with everything but WhatsApp is safe to deploy:\n${r.out}`);
});

test("WhatsApp: a configured integration passes", () => {
  const r = run();
  assert.ok(line(r.out, "PASS", /WHATSAPP_APP_SECRET/), `expected a PASS for the configured secret:\n${r.out}`);
});

// F139: the secret is what switches the webhook on, but it is not what makes
// ingest WORK. With the secret set and the access token empty -- the state
// compose accepts -- every video is recorded and none can be fetched; with the
// verify token empty, Meta's webhook handshake is refused. Preflight used to
// PASS the secret and say nothing about either.
test("WhatsApp: a secret without the token, verify token or phone number id is a WARN naming each", () => {
  const r = run();
  for (const name of ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"]) {
    assert.ok(line(r.out, "WARN", new RegExp(name)), `expected a WARN naming ${name}:\n${r.out}`);
  }
  assert.equal(r.status, 0, `a partly configured integration must not block the deploy:\n${r.out}`);

  const full = run({
    envFile: { WHATSAPP_ACCESS_TOKEN: "t", WHATSAPP_VERIFY_TOKEN: "v", WHATSAPP_PHONE_NUMBER_ID: "p" },
  });
  assert.ok(!line(full.out, "WARN", /WHATSAPP_/), `a fully configured integration draws no warning:\n${full.out}`);
});

// ── Disk: where Docker's data lives ──────────────────────────────────────────
//
// README-deploy.md 2.4 sizes a 30 GiB root and a 100 GiB data volume at
// /var/lib/gml "for ffmpeg scratch". But the worker's scratch is a Docker
// volume, and Docker keeps volumes, images and build cache under its data
// root, /var/lib/docker -- on the root volume -- and no step moved it. The
// disk check only looked at `.`.

/**
 * A df that places each path on the filesystem a test says it is on. The size
 * is whole GiB, or `{ kib }` for the exact figure a real filesystem reports --
 * never a whole number of GiB, because the partition table, the EFI and /boot
 * partitions and ext4's own metadata come out of the disk first.
 */
const dfFor = (mounts) => `
last=""; for a in "$@"; do last="$a"; done
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'
case "$last" in
${Object.entries(mounts)
  .map(([path, [dev, size, mnt]]) => {
    const kib = typeof size === "object" ? size.kib : size * 1048576;
    return `  ${path}) printf '%s %s 1 %s 1%% %s\\n' ${dev} ${kib} ${Math.floor(kib * 0.9)} ${mnt} ;;`;
  })
  .join("\n")}
  *) printf '/dev/root 31457280 1 20971520 1%% /\\n' ;;
esac`;

function preflightDocker(dockerRoot, mounts) {
  const sb = preflightSandbox();
  sb.stub(
    "docker",
    `case "$*" in
  --version) echo "Docker version 27.3.1, build ce12230" ;;
  "compose version --short") echo "2.29.7" ;;
  "info --format {{.DockerRootDir}}") echo "${dockerRoot}" ;;
esac
exit 0`,
  );
  sb.stub("df", dfFor(mounts));
  try {
    const r = sb.run("scripts/preflight.sh");
    return { ...r, out: `${r.stdout}${r.stderr}` };
  } finally {
    sb.cleanup();
  }
}

test("Disk: Docker's data root on a 30 GiB root volume is a FAIL that points at the runbook", () => {
  const r = preflightDocker("/var/lib/docker", {
    "/": ["/dev/root", 30, "/"],
    "/var/lib/docker": ["/dev/root", 30, "/"],
  });
  const l = line(r.out, "FAIL", /Docker data root/);
  assert.ok(l, `images, build cache and transcode scratch would fill the root volume:\n${r.out}`);
  assert.match(r.out, /README-deploy\.md 2\.5/);
});

test("Disk: Docker's data root on the data volume passes", () => {
  const r = preflightDocker("/var/lib/gml/docker", {
    "/": ["/dev/root", 30, "/"],
    "/var/lib/gml/docker": ["/dev/data", 100, "/var/lib/gml"],
  });
  assert.ok(line(r.out, "PASS", /Docker data root \/var\/lib\/gml\/docker is on \/var\/lib\/gml/), r.out);
  assert.ok(!line(r.out, "FAIL", /Docker data root/), r.out);
});

// W3-48. The check's own rule is "a single root disk of 60 GiB or more is not
// a failure", but it compared df's size -- the FILESYSTEM, rounded down to
// whole GiB -- against 60. A 60 GiB EBS volume on the Ubuntu 24.04 AMI
// (BIOS, EFI and /boot partitions, then ext4 metadata) reports 60831118 KiB:
// 58 GiB. So the disk it said was fine was FAILed, and preflight refused to
// call the host safe to deploy.

test("Disk: a single 60 GiB root disk passes, at the size df really reports for it", () => {
  const r = preflightDocker("/var/lib/docker", {
    "/": ["/dev/root", { kib: 60831118 }, "/"],
    "/var/lib/docker": ["/dev/root", { kib: 60831118 }, "/"],
  });
  assert.ok(
    !line(r.out, "FAIL", /Docker data root/),
    `a 60 GiB root disk is the documented single-disk layout, and preflight failed it:\n${r.out}`,
  );
  assert.ok(line(r.out, "PASS", /Docker data root \/var\/lib\/docker is on the root volume/), r.out);
});

test("Disk: a root disk well under 60 GiB still fails when Docker's data root is on it", () => {
  // 50 GiB after the same overhead: the allowance must not swallow the rule.
  const r = preflightDocker("/var/lib/docker", {
    "/": ["/dev/root", { kib: 50691000 }, "/"],
    "/var/lib/docker": ["/dev/root", { kib: 50691000 }, "/"],
  });
  assert.ok(line(r.out, "FAIL", /Docker data root/), r.out);
});

test("Disk: the free-space hint describes what the root volume holds now", () => {
  // The hint still said "images, transcode scratch and backups need room",
  // which is what README-deploy.md 2.5 moves OFF the root volume.
  const sb = preflightSandbox();
  sb.stub("df", `printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/root 31457280 1 10485760 1%% /\\n'`);
  try {
    const r = sb.run("scripts/preflight.sh");
    const out = `${r.stdout}${r.stderr}`;
    const l = line(out, "FAIL", /disk: 10 GiB free here/);
    assert.ok(l, out);
    const hint = out.slice(out.indexOf(l)).split("\n").slice(0, 3).join("\n");
    assert.doesNotMatch(hint, /transcode scratch and backups/, `the hint names what belongs on the data volume:\n${hint}`);
    assert.match(hint, /README-deploy\.md 2\.5/, `and points at the step that moves it there:\n${hint}`);
  } finally {
    sb.cleanup();
  }
});
