// The Postgres connections the stack may hold fit the Supabase session pooler.
//
// In session mode every client connection holds one pooler slot while it is
// open, and the slots are the pool size -- 15 by default on the smaller
// computes. client.ts gave app AND worker a fixed ceiling of 10 each, enough
// between them to exhaust the pooler, after which every new connect fails
// ("max clients reached"). client.ts now takes the ceiling from DB_POOL_MAX
// (executed in tests/behaviour/db-pool-size.test.ts); this pins the budget
// docker-compose.yml hands each container, which no test here can run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const yaml = readFileSync(resolve(root, "docker-compose.yml"), "utf8").replace(/(^|\s)#.*$/gm, "$1");

/** One service's block: from `  <name>:` to the next top-level service key. */
function service(name) {
  const start = yaml.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `service ${name} not found in docker-compose.yml`);
  const rest = yaml.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n|\n[a-z]/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** The DB_POOL_MAX a container gets with nothing overridden in .env. */
function budget(name) {
  const m = service(name).match(/^ {6}DB_POOL_MAX:\s*"?(?:\$\{[A-Z_]+:-(\d+)\}|(\d+))"?\s*$/m);
  assert.ok(m, `${name} must set DB_POOL_MAX -- without it the process may open 10 connections`);
  return Number(m[1] ?? m[2]);
}

test("the containers' connection ceilings add up to the session pooler's default 15", () => {
  const app = budget("app");
  const worker = budget("worker");
  const migrate = budget("migrate");
  // + 1: the worker's healthcheck opens a connection of its own every minute.
  const total = app + worker + migrate + 1;
  assert.ok(
    total <= 15,
    `app ${app} + worker ${worker} + migrate one-offs ${migrate} + healthcheck 1 = ${total}, ` +
      "more than the session pooler's default 15 clients",
  );
});
