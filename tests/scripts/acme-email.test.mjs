// acme_email_problem: why a certificate authority would refuse the ACME contact.
//
// Caddy registers ACME_EMAIL with Let's Encrypt and ZeroSSL. Both refuse a
// contact whose domain is not a real public name, so a placeholder (the
// dev@localhost.invalid in a developer's .env, the it@example.org in
// .env.example) leaves Caddy with no certificate, HTTPS never answers and
// deploy.sh can only time out at health.
//
// The function lives in BOTH scripts/preflight.sh (the pre-deploy check) and
// scripts/deploy.sh (which does not run preflight). They must not drift.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { bashExe, root } from "./_sandbox.mjs";

const FN = /^acme_email_problem\(\) \{\n[\s\S]*?\n\}\n/m;

function fn(file) {
  const m = readFileSync(resolve(root, file), "utf8").match(FN);
  assert.ok(m, `${file} must define acme_email_problem`);
  return m[0];
}

function problem(email) {
  const r = spawnSync(bashExe(), ["-c", `${fn("scripts/deploy.sh")}\nacme_email_problem "$1"`, "bash", email], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

test("preflight.sh and deploy.sh carry the same acme_email_problem", () => {
  assert.equal(fn("scripts/preflight.sh"), fn("scripts/deploy.sh"));
});

test("addresses a CA refuses are named", () => {
  const cases = [
    ["dev@localhost.invalid", /\.invalid/],
    ["it@example.org", /example domain/],
    ["IT@EXAMPLE.ORG", /example domain/],
    ["ops@mail.example.com", /example domain/],
    ["ops@example.test", /\.test/],
    ["ops@printer.local", /\.local/],
    ["ops@box.localhost", /\.localhost/],
    ["nobody", /not an address/],
    ["a@b", /not an address/],
    ["@x.org", /not an address/],
    ["", /not an address/],
  ];
  for (const [email, re] of cases) assert.match(problem(email), re, email);
});

test("real addresses are accepted, including a stray CR from a Windows-edited .env", () => {
  for (const email of ["ops@goldenmilelearning.org", "it@powerweave.com", "Ops.Team@Sub.Domain.IN", "ops@goldenmilelearning.org\r"]) {
    assert.equal(problem(email), "", email);
  }
});
