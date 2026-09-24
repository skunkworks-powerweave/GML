// Properties of the operator scripts that no regex over their TEXT can see.
//
// 1. THE EXEC BIT. Every scripts/*.sh was once committed 100644, so the
//    runbook's literal first command, `./scripts/deploy.sh`, was "Permission
//    denied" on a fresh Linux clone -- and so were `make deploy` and both cron
//    lines, whose failures land in logs nobody reads. This tree has
//    core.fileMode=false (Windows), so a `chmod +x` here is never recorded;
//    only `git update-index --chmod=+x` is. The mode lives in the INDEX, so
//    that is what this reads. (CI additionally runs `test -x` on the
//    checked-out files -- see .github/workflows/test.yml.)
//
// 2. CONTROL BYTES. scripts/backup.sh carried a literal 0x01 where a sed
//    backreference belonged -- a heredoc had eaten the backslash -- and that
//    single byte made the Storage S3 endpoint derivation produce garbage for
//    as long as it existed. It is invisible in a terminal and in most diffs.
//    Tab, LF and CR are the only control characters a script needs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./_sandbox.mjs";

function shellScripts(dir = "scripts") {
  const out = [];
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...shellScripts(rel));
    else if (e.name.endsWith(".sh")) out.push(rel);
  }
  return out;
}

test("every top-level scripts/*.sh is committed executable (mode 100755)", (t) => {
  const r = spawnSync("git", ["ls-files", "-s", "--", "scripts"], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) {
    t.skip(`git index not readable here (${r.stderr?.trim() || r.error?.message}); CI's test -x step covers it`);
    return;
  }
  const modes = new Map(
    r.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        const [meta, path] = l.split("\t");
        return [path, meta.split(" ")[0]];
      }),
  );
  // Sourced libraries (scripts/lib/) are read with `.`, never executed.
  const executables = shellScripts().filter((p) => !p.startsWith("scripts/lib/"));
  assert.ok(executables.length >= 6, `expected the six operator scripts, found ${executables.join(", ")}`);
  for (const p of executables) {
    assert.equal(
      modes.get(p),
      "100755",
      `${p} is ${modes.get(p) ?? "untracked"} in the index. \`./${p}\` would be "Permission denied" ` +
        `on a Linux clone. Fix with: git update-index --chmod=+x ${p}`,
    );
  }
});

test("no shell script, Caddyfile or compose file carries a stray control byte", () => {
  const files = [...shellScripts(), "docker/Caddyfile", "docker-compose.yml"];
  const bad = [];
  for (const f of files) {
    const buf = readFileSync(join(root, f));
    let line = 1;
    for (const b of buf) {
      if (b === 10) line++;
      else if (b < 32 && b !== 9 && b !== 13) bad.push(`${f}:${line} byte 0x${b.toString(16).padStart(2, "0")}`);
    }
  }
  assert.deepEqual(
    bad,
    [],
    "a control byte in a script is almost always a backslash sequence eaten by a heredoc " +
      "(backup.sh's endpoint derivation was dead for exactly this reason):\n  " +
      bad.join("\n  "),
  );
});
