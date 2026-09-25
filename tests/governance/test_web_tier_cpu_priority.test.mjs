// The web tier outranks ffmpeg for CPU.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// docker-compose.yml's own sizing note says one ffmpeg at -preset veryfast
// saturates both vCPUs of the target instance. The only mitigation was
// WORKER_CONCURRENCY=1 -- which by that same note still saturates the box --
// and every service ran at Docker's default CPU weight. So for the length of
// every transcode, libx264's threads competed on equal terms with the single
// Next.js event loop and with Caddy's TLS: page and API latency rose for every
// user, on links in Ladakh that are slow already, and the app's 5 s healthcheck
// could trip.
//
// ── WHAT THIS PINS ───────────────────────────────────────────────────────────
//
// app and caddy carry a CPU weight well above the worker's. A weight only
// matters under contention, so ffmpeg still gets the whole box while nobody is
// browsing. This reads compose text because no test here can run the stack.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
/** `#`-comment-stripped compose text. */
const yaml = readFileSync(resolve(root, "docker-compose.yml"), "utf8").replace(/(^|\s)#.*$/gm, "$1");

/** One service's block: from `  <name>:` to the next top-level service key. */
function service(name) {
  const start = yaml.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `service ${name} not found in docker-compose.yml`);
  const rest = yaml.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n|\n[a-z]/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** Docker's default CPU weight is 1024 when a service sets none. */
const weight = (name) => Number(service(name).match(/^ {4}cpu_shares:\s*(\d+)\s*$/m)?.[1] ?? 1024);

test("app and caddy outweigh the worker for CPU, by at least 4 to 1", () => {
  const worker = weight("worker");
  for (const svc of ["app", "caddy"]) {
    assert.ok(
      weight(svc) >= 4 * worker,
      `${svc} has cpu_shares ${weight(svc)} against the worker's ${worker}: during a transcode ffmpeg ` +
        "takes an equal share of both vCPUs and every page slows down",
    );
  }
});
