#!/usr/bin/env node
// SM-5 enforcement: refuses to start the app in production mode if the last
// restore drill was > 30 days ago. The deploy script (spec 067) calls this
// before `docker compose up -d`.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const drillFile = resolve(__dirname, "..", "workspace", "last_restore_drill.json");
const MAX_AGE_DAYS = 30;

function fail(msg) {
  console.error(`[SM-5] ${msg}`);
  process.exit(1);
}

function main() {
  if (process.env.NODE_ENV !== "production") {
    console.log("[SM-5] non-production env — restore-drill check skipped.");
    process.exit(0);
  }

  if (!existsSync(drillFile)) {
    fail(
      `last_restore_drill.json missing. Perform a restore drill and write { "ranAt": "<ISO date>", "result": "ok" } to ${drillFile}.`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(drillFile, "utf8"));
  } catch (err) {
    fail(`last_restore_drill.json unreadable: ${err}`);
  }

  const ranAt = new Date(parsed.ranAt ?? 0);
  if (isNaN(ranAt.getTime())) fail(`last_restore_drill.json has invalid ranAt: ${parsed.ranAt}`);

  // The result first, and with its reason. scripts/restore.sh stamps a FAILED
  // drill as {"result":"failed","error":"..."}; before it did, a broken drill
  // left no file at all and this gate could only say "missing", which reads
  // like "nobody ran it" rather than "it ran and could not restore".
  if (parsed.result !== "ok") {
    const why = typeof parsed.error === "string" && parsed.error ? `: ${parsed.error}` : "";
    fail(
      `last restore drill (${parsed.ranAt}) result: ${parsed.result}${why}. ` +
        `Fix the cause and re-run scripts/restore.sh before deploying (README-deploy.md section 7).`,
    );
  }

  const ageDays = (Date.now() - ranAt.getTime()) / (24 * 60 * 60 * 1000);
  if (ageDays > MAX_AGE_DAYS) {
    fail(
      `restore drill is ${Math.round(ageDays)} days old (> ${MAX_AGE_DAYS}). Run a restore drill before deploying.`,
    );
  }
  console.log(`[SM-5] last restore drill ok, ${Math.round(ageDays)} days ago.`);
  process.exit(0);
}

main();
