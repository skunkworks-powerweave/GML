// Governance test for spec 109 — backup script strict mirror.
//
// PARTLY INVERTED. Spec 109's actual subject — "the object mirror must not be
// allowed to fail quietly" — is the right concern and every assertion of it
// below is kept. What has to change is WHAT is being mirrored and HOW, because
// three of the original assertions pinned a command that could never run:
//
//   `mc mirror` was executed INSIDE the `minio` server container. The
//   `minio/minio` image ships the SERVER; `mc` is a separate image
//   (`minio/mc`). So the step exited 127 — command not found — and under
//   `set -e` that killed the backup AFTER the database dump had succeeded and
//   BEFORE a single object was captured. The script's own header promised
//   "strict mirror, never lose video assets" and did the exact opposite of it
//   on every single run.
//
//   FR-109-D ("we did not remove the actual mirror step"), FR-109-F ('MinIO
//   mirror complete') and FR-109-G (`du -sh` of the mirror directory) each
//   required a piece of that broken arrangement to stay in place. FR-109-F is
//   the sharpest example: it demanded a SUCCESS LOG for a step that could not
//   succeed, which is a governance test asserting that a lie be printed.
//
// Since then MinIO withdrew their public Docker images outright (the whole
// `minio/*` namespace is "pull access denied ... repository does not exist"),
// so there is no MinIO to mirror from either. Objects live in Supabase Storage
// and are mirrored REMOTE-TO-REMOTE with `rclone` into an S3 bucket we control
// — remote-to-remote because a 100 GB video set must never have to land on the
// EC2 root disk on its way to S3, which is also why `du -sh` has nothing left
// to measure.
//
// The one thing that got STRICTER: Supabase Storage has no backup product at
// all, so if the Storage credentials are missing the videos are unbacked by
// anyone. That case must be LOUD (WARNING on stderr), which is the same
// property FR-109-F was reaching for, re-pointed at the branch that can
// actually occur.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const scriptPath = resolve(root, "scripts/backup.sh");

/** `#`-comment-stripped view — the script documents the `mc` defect in prose. */
const code = (src) => src.replace(/(^|\s)#.*$/gm, "$1");

test("FR-109-A: scripts/backup.sh exists", () => {
  assert.ok(existsSync(scriptPath), "scripts/backup.sh must exist");
});

test("FR-109-B: backup.sh has `set -euo pipefail` so non-zero exits abort the script", () => {
  const src = readFileSync(scriptPath, "utf8");
  assert.match(
    src,
    /^set -euo pipefail$/m,
    "scripts/backup.sh must contain `set -euo pipefail` on its own line",
  );
});

test("FR-109-C: backup.sh installs an ERR trap that logs the failing line", () => {
  const src = readFileSync(scriptPath, "utf8");
  // Unchanged in substance. Only the spelling of the variable is widened:
  // the assertion demanded a bare `$LINENO` and the script writes the
  // brace form `${LINENO}`, which is the same variable. A real property
  // (a cron failure must name its line, not just exit non-zero) was failing
  // on punctuation, so the pattern accepts either form.
  assert.match(
    src,
    /trap\s+'[^']*\$\{?LINENO\}?[^']*'\s+ERR/,
    "scripts/backup.sh must `trap '...$LINENO...' ERR` for clear failure logging",
  );
});

test("FR-109-D: the object mirror runs remote-to-remote, and `mc` is gone", () => {
  const src = code(readFileSync(scriptPath, "utf8"));
  // Was: "backup.sh must still invoke `mc mirror`". See this file's header —
  // that invocation exited 127 on every run because the `minio/minio` image
  // has no `mc` binary, so the assertion protected a step that never ran.
  assert.ok(
    !/\bmc\s+(mirror|alias|cp)\b/.test(src),
    "backup.sh must not shell out to `mc` — the minio server image never shipped that " +
      "binary, so the step exited 127 and killed the backup before any object was captured",
  );
  assert.ok(
    !/docker\s+(compose\s+)?exec[^\n]*minio/.test(src),
    "backup.sh must not exec into a minio container — MinIO withdrew their public images",
  );
  // The replacement, pinned positively so the mirror cannot simply disappear.
  // `rclone copy`, NOT `rclone sync`.
  //
  // The old assertion required `sync`, which is a DESTRUCTIVE mirror: it makes
  // the destination match the source by DELETING destination objects that are
  // absent from it. So a deletion inside Supabase -- accident, bad admin
  // action, compromised key -- would propagate into the disaster-recovery
  // bucket on the next nightly run and destroy the only copy of the videos
  // that is not Supabase's. The test was pinning a backup that would
  // faithfully replicate the disaster it exists to survive, inside 24 hours.
  //
  // `copy` only adds and updates. Pruning belongs to the bucket's lifecycle
  // policy, where it is deliberate and versioned.
  assert.match(
    src,
    /rclone copy/,
    "backup.sh must mirror Storage with `rclone copy`",
  );
  assert.ok(
    !/rclone sync/.test(src),
    "backup.sh must NOT use `rclone sync` — it deletes destination objects absent from the " +
      "source, so a deletion in Supabase would wipe the DR copy of the videos on the next run",
  );
  // Remote-to-remote, so a 100 GB video set never transits the EC2 root disk.
  // Both endpoints are now declared as rclone remotes through the environment
  // rather than inline in argv, because an argv is readable from /proc for the
  // hours a mirror of that size runs.
  assert.match(
    src,
    /RCLONE_CONFIG_SUPASRC_ENDPOINT="\$\{SUPABASE_S3_ENDPOINT\}"/,
    "the source must be the Supabase S3 endpoint",
  );
  assert.match(
    src,
    /rclone copy[\s\S]{0,200}?"SUPASRC:\$\{bucket\}"[\s\S]{0,200}?"DRDEST:/,
    "the mirror must run remote-to-remote, Supabase -> our S3 bucket",
  );
  assert.ok(
    !/secret_access_key=\$\{SUPABASE_S3_SECRET_KEY\}/.test(src),
    "the S3 secret must not be interpolated into the command line",
  );
  assert.match(
    src,
    /for bucket in [^\n]*videos-original[^\n]*videos-hls/,
    "the mirror must cover the video buckets — they are the irreplaceable half",
  );
});

test("FR-109-E: backup.sh does NOT silence the mirror or the dump with `|| true`", () => {
  const src = readFileSync(scriptPath, "utf8");
  const lines = src.split(/\r?\n/);
  // Same rule as before, re-pointed from `mc mirror` at the three steps that
  // now carry the data: the dump, the mirror, and the retention prune. A
  // swallowed failure in any of them produces a backup run that reports
  // success while holding nothing.
  const offending = lines.filter(
    (ln) => /rclone sync|pg_dump|aws s3 cp|find [^\n]*-delete/.test(ln) && /\|\|\s*true/.test(ln),
  );
  assert.equal(
    offending.length,
    0,
    `no backup step may be silenced with \`|| true\` (found ${offending.length}: ${offending.join(" / ")})`,
  );
});

test("FR-109-F: a skipped Storage mirror is LOUD — the videos are otherwise unbacked", () => {
  const src = readFileSync(scriptPath, "utf8");
  // Was: `assert.match(src, /MinIO mirror complete/)` — a mandatory success log
  // for a step that could not succeed. The property underneath it (a human
  // reading cron mail can tell whether objects were actually captured) is kept
  // and re-pointed at the branch that can really happen: credentials absent.
  //
  // This matters more than the old assertion did. Supabase Pro backs up
  // Postgres daily; Supabase Storage has NO backup product at all. If this
  // branch is taken, the classroom videos — which cannot be re-recorded — have
  // no copy anywhere except Supabase's own live bucket.
  assert.match(
    src,
    /WARNING: Storage mirror SKIPPED/,
    "backup.sh must announce a skipped Storage mirror explicitly",
  );
  assert.match(
    src,
    /The videos are NOT being backed up/,
    "the skip must say in plain words what is unprotected, not just name a missing variable",
  );
  const skipLines = src
    .split(/\r?\n/)
    .filter((ln) => /WARNING: (Storage mirror SKIPPED|The videos are NOT)/.test(ln));
  for (const ln of skipLines) {
    assert.match(
      ln,
      />&2\s*$/,
      `the skip warning must go to stderr so cron mails it: ${ln.trim()}`,
    );
  }
  // And the success path still narrates itself, per bucket.
  assert.match(
    code(src),
    /log "mirroring \$\{bucket\}"/,
    "each bucket mirror must log, so a partial run is visible in cron mail",
  );
});

test("FR-109-G: the dump is size-checked, so a 0-byte 'success' cannot pass for a backup", () => {
  const src = code(readFileSync(scriptPath, "utf8"));
  // Was: `du -sh` on the local mirror directory. There is no local mirror
  // directory any more — the object copy is remote-to-remote by design, so
  // nothing on this host holds the bytes to measure.
  assert.ok(
    !/du -sh/.test(src),
    "backup.sh must not `du -sh` a mirror path — the mirror is remote-to-remote and " +
      "never lands on this disk",
  );
  // The at-a-glance-health property survives, applied to the artefact that IS
  // local: a pg_dump that exits 0 having written almost nothing is the classic
  // silent backup failure, and it is caught here rather than during a restore.
  assert.match(
    src,
    /size="\$\(stat -c '%s' "\$\{DUMP\}"\)"/,
    "backup.sh must measure the dump it just wrote",
  );
  assert.match(
    src,
    /\[ "\$\{size\}" -gt \d+ \]/,
    "backup.sh must refuse to treat a suspiciously small dump as a backup",
  );
  assert.match(
    src,
    /log "dumped/,
    "the dump size must be logged for at-a-glance health monitoring",
  );
});

test("FR-109-H: retention pruning is not silenced either", () => {
  const src = code(readFileSync(scriptPath, "utf8"));
  // Kept from the original spirit of FR-109-E and made explicit: the prune is
  // deliberately NOT `|| true`, because a prune that fails fills the disk, and
  // a full disk is how the NEXT backup fails silently.
  assert.match(
    src,
    /find "\$\{DB_DIR\}" -name 'gml-\*\.dump\.gz' -mtime "\+\$\{KEEP_DAILY\}" -delete/,
    "backup.sh must prune old dumps by age",
  );
  assert.match(
    src,
    /KEEP_DAILY="\$\{KEEP_DAILY:-14\}"/,
    "local retention must default to 14 days",
  );
  assert.match(
    src,
    /last-backup\.txt/,
    "backup.sh must stamp last-backup.txt so staleness is detectable from outside the script",
  );
});
