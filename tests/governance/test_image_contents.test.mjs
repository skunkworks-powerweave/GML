// No .env file, at any depth, reaches a Docker build.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// .dockerignore's secret patterns were `.env` and `.env.*`. Docker matches
// .dockerignore patterns against paths relative to the build-context root, so
// those two excluded only the ROOT .env files. An apps/web/.env or
// apps/web/.env.production on the build machine -- a developer checkout, say --
// went into the context; `next build` loaded it (inlining any NEXT_PUBLIC_*
// value into the client bundle), and Next's standalone writer copies the
// .env/.env.production it loaded into .next/standalone, which
// docker/app.Dockerfile ships as the runtime image.
//
// ── HOW THIS CHECKS IT ───────────────────────────────────────────────────────
//
// No test here can run `docker build`, so this evaluates .dockerignore the way
// Docker's pattern matcher does -- each line a filepath.Match-style glob
// against the context-relative path, `**` spanning directories, a later `!`
// line re-including, and a directory's exclusion covering what is under it --
// over the paths that matter.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");

/** A .dockerignore pattern as a RegExp over a context-relative path. */
function toRegExp(pattern) {
  let re = "";
  const p = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*" && p[i + 1] === "*") {
      // `**/` matches zero or more directories; a trailing `**` matches anything.
      if (p[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // A pattern that matches a directory excludes everything beneath it.
  return new RegExp(`^${re}(?:/.*)?$`);
}

const rules = readFileSync(resolve(root, ".dockerignore"), "utf8")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"))
  .map((l) => (l.startsWith("!") ? { keep: true, re: toRegExp(l.slice(1)) } : { keep: false, re: toRegExp(l) }));

/** Docker's verdict: the last matching line wins. */
const excluded = (path) => rules.reduce((out, r) => (r.re.test(path) ? !r.keep : out), false);

test("every .env file is kept out of the build context, at any depth", () => {
  const leaked = [
    ".env",
    ".env.local",
    ".env.production",
    "apps/web/.env",
    "apps/web/.env.production",
    "apps/web/.env.local",
    "apps/worker/.env",
    "packages/db/.env",
  ].filter((p) => !excluded(p));
  assert.deepEqual(leaked, [], "these would enter the build context, and a Next build copies .env/.env.production into the shipped image");
});

test("the app image's builder drops the traced source before the runner copies standalone", () => {
  // pingMigrations() read a process.cwd()-relative path, so the file tracer
  // put the whole apps/web directory -- src/, tsconfig.tsbuildinfo, READMEs --
  // into .next/standalone, which the runner stage copies wholesale. That cause
  // is gone (it imports the journal: health-probe-ok.test.ts), and this step
  // is the guard against the next dynamic read bringing the source back.
  const df = readFileSync(resolve(root, "docker/app.Dockerfile"), "utf8").replace(/^\s*#.*$/gm, "");
  const build = df.indexOf("RUN pnpm exec next build");
  const prune = df.search(/RUN cd \.next\/standalone\/apps\/web \\\s*\n\s*&& rm -rf src\b/);
  const runner = df.indexOf("AS runner");
  assert.ok(build >= 0 && runner > 0, "could not find the build step and the runner stage");
  assert.ok(
    prune > build && prune < runner,
    "the builder must remove apps/web/src from .next/standalone after `next build` and before the runner copies it",
  );
});

test("no application module builds a path from process.cwd() (the file tracer copies all of apps/web for one)", () => {
  // Structural, because nothing a test can run executes Next's tracer: one
  // cwd-relative read was enough to put src/ and the READMEs into
  // .next/standalone (W3-50). Read what the build needs through an import.
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|mjs)$/.test(name)) {
        const code = readFileSync(p, "utf8").replace(/^\s*(\/\/|\*).*$/gm, "");
        if (/process\.cwd\(\)/.test(code)) offenders.push(p.slice(root.length + 1));
      }
    }
  };
  walk(resolve(root, "apps/web/src"));
  assert.deepEqual(offenders, [], "these modules read relative to the working directory");
});

test(".env.example and the sources the images need are still in the context", () => {
  const dropped = [
    ".env.example",
    "apps/web/src/app/page.tsx",
    "packages/db/src/migrations/meta/_journal.json",
    "packages/db/src/migrations/_post/001_revoke_audit_writes.sql",
    "docker/Caddyfile",
  ].filter((p) => excluded(p));
  assert.deepEqual(dropped, [], "the fix must not drop files a Dockerfile COPYs");
});
