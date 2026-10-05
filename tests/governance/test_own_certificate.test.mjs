// An operator-supplied TLS certificate (docker/certs), as an opt-in.
//
// DevOps may hold a certificate for the domain (purchased, wildcard, internal
// CA) and want Caddy to serve it instead of obtaining one from Let's Encrypt.
// Caddy has no way to say "use a file if there is one" in a Caddyfile except
// `import` of a glob: a bare `tls {$VAR}` with the variables empty is a Caddy
// error ("wrong argument count after 'tls'"), which would have broken every
// default deploy. So the switch is a *.caddy snippet that exists or does not.
//
// What these tests pin:
//   - the default is untouched: the Caddyfile still has no `tls` directive of
//     its own, so Caddy keeps its automatic HTTPS;
//   - the opt-in is wired: the snippet glob is imported inside the site block,
//     and compose mounts docker/certs read-only where the glob looks;
//   - a private key dropped there can never be committed or baked into an image;
//   - the instructions and the example exist and agree with the Caddyfile.
// (The adapted Caddy config with no snippet present was also compared
// byte-for-byte with the previous Caddyfile's, and a real Caddy served a pair
// from the folder; that needs Docker and is not repeated here.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");
const codeLines = (s) => s.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));

test("the Caddyfile imports the snippet glob inside the site block and has no tls directive of its own", () => {
  const caddyfile = read("docker/Caddyfile");
  const site = caddyfile.slice(caddyfile.indexOf("{$DOMAIN:localhost} {"));
  assert.match(site, /^\timport \/etc\/caddy\/certs\/\*\.caddy$/m, "the site block must import /etc/caddy/certs/*.caddy");
  assert.ok(
    !/^\s*tls\s/m.test(codeLines(caddyfile).join("\n")),
    "no tls directive in the Caddyfile itself: its presence would switch off automatic HTTPS for everyone",
  );
});

test("compose mounts docker/certs read-only at the path the Caddyfile imports from, on caddy only", () => {
  const compose = read("docker-compose.yml");
  const caddy = compose.slice(compose.indexOf("\n  caddy:\n"), compose.indexOf("\nvolumes:\n"));
  assert.match(caddy, /^\s+- \.\/docker\/certs:\/etc\/caddy\/certs:ro$/m);
  const rest = compose.replace(caddy, "");
  assert.ok(!/docker\/certs/.test(rest.replace(/^\s*#.*$/gm, "")), "no other service needs the key");
});

test("a key in docker/certs can be neither committed nor sent to a Docker build", () => {
  const gitignore = read(".gitignore").split("\n").map((l) => l.trim());
  assert.ok(gitignore.includes("docker/certs/*"), ".gitignore must ignore everything in docker/certs");
  assert.ok(gitignore.includes("!docker/certs/README.md") && gitignore.includes("!docker/certs/tls.caddy.example"));
  const dockerignore = read(".dockerignore").split("\n").map((l) => l.trim());
  assert.ok(dockerignore.includes("docker/certs"), ".dockerignore must keep docker/certs out of every build context");
});

test("the example is the one tls line the Caddyfile's mount makes valid, and the README says how to renew", () => {
  assert.ok(existsSync(resolve(root, "docker/certs/README.md")) && existsSync(resolve(root, "docker/certs/tls.caddy.example")));
  assert.deepEqual(codeLines(read("docker/certs/tls.caddy.example")), [
    "tls /etc/caddy/certs/fullchain.pem /etc/caddy/certs/privkey.pem",
  ]);
  const readme = read("docker/certs/README.md");
  assert.match(readme, /caddy reload --force --config \/etc\/caddy\/Caddyfile/, "a plain reload does nothing: the README must say --force");
  assert.match(readme, /unencrypted/i);
});

test("preflight.sh and deploy.sh both know about docker/certs", () => {
  for (const f of ["scripts/preflight.sh", "scripts/deploy.sh"]) {
    assert.match(read(f), /docker\/certs\/\*\.caddy/, `${f} must look for a supplied certificate`);
  }
  assert.match(read("scripts/deploy.sh"), /caddy validate --config \/etc\/caddy\/Caddyfile/);
});
