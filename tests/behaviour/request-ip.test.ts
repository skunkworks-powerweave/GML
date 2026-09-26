// The client IP, executed.
//
// One value feeds three controls: the section-gate brute-force limit
// (gate/[slug]/actions.ts, 5 per 15 minutes keyed `${ip}:${user}:${slug}`), the
// magic-link / password-reset throttle (login/email-actions.ts, keyed on the ip
// alone) and audit_log.ip, the forensic column an administrator reads. All three
// used to take the FIRST element of X-Forwarded-For.
//
// docker/Caddyfile is the only ingress, and its reverse_proxy APPENDS the socket
// peer to whatever X-Forwarded-For the client sent. It also sets
// `header_up X-Real-IP {remote_host}`, which the client cannot influence. So a
// request built with `X-Forwarded-For: 1.2.3.4` reaches the app as
//
//     x-forwarded-for: 1.2.3.4, 203.0.113.7
//     x-real-ip:       203.0.113.7
//
// and the first element is the attacker's string. These tests build exactly
// those header bags and hand them to the one function every caller now uses.
// Pure: no database, runs everywhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isIP } from "node:net";
import { clientIpFrom, UNKNOWN_IP } from "../../apps/web/src/lib/request-ip.js";

const REAL = "203.0.113.7";

/** The header bag Caddy forwards when the client sent `X-Forwarded-For: spoofed`. */
function viaCaddy(spoofed: string | null, peer = REAL): Headers {
  const h = new Headers();
  h.set("x-forwarded-for", spoofed === null ? peer : `${spoofed}, ${peer}`);
  h.set("x-real-ip", peer);
  return h;
}

test("a client-supplied X-Forwarded-For does not become the client ip", () => {
  assert.equal(
    clientIpFrom(viaCaddy("1.2.3.4")),
    REAL,
    "the first X-Forwarded-For element is whatever the CLIENT sent; the peer Caddy saw is the client ip",
  );
});

test("rotating X-Forwarded-For per request cannot mint fresh rate-limit keys", () => {
  // This is the gate brute-force: one new header value per attempt, and the
  // 5-per-15-minutes counter never sees the same key twice.
  const keys = new Set<string>();
  for (let i = 0; i < 25; i++) {
    const ip = clientIpFrom(viaCaddy(`10.0.${i}.${(i * 7) % 250}`));
    keys.add(`gate:${ip}:user-1:observation`);
  }
  assert.equal(keys.size, 1, `25 spoofed requests from one peer produced ${keys.size} distinct gate keys`);
});

test("without X-Real-IP, the LAST X-Forwarded-For hop is used — the one our proxy appended", () => {
  const h = new Headers({ "x-forwarded-for": `1.2.3.4, 5.6.7.8, ${REAL}` });
  assert.equal(clientIpFrom(h), REAL);
});

test("a malformed X-Real-IP falls through to the proxy-appended hop, not to the client's", () => {
  const h = new Headers({ "x-forwarded-for": `9.9.9.9, ${REAL}`, "x-real-ip": "not-an-ip" });
  assert.equal(clientIpFrom(h), REAL);
});

test("no proxy headers at all yields the explicit unknown marker", () => {
  assert.equal(clientIpFrom(new Headers()), UNKNOWN_IP);
});

test("only a parseable IP literal is ever returned, and it always fits varchar(64)", () => {
  // section_gate_grants.ip and audit_log.ip are varchar(64). An over-long value
  // made the grant INSERT throw AFTER bcrypt.compare had accepted a correct
  // password -- the right password answered with a server error.
  const hostile = [
    "A".repeat(200),
    `${"1".repeat(70)}, `,
    "1.2.3.4; DROP TABLE users",
    "<script>alert(1)</script>",
    "1.2.3.4:8080",
    "999.1.1.1",
    "::ffff:999.1.1.1",
    "1.2.3.4::",
    "fe80::1%eth0",
    " , , ",
    "",
  ];
  for (const bad of hostile) {
    for (const h of [
      new Headers({ "x-real-ip": bad }),
      new Headers({ "x-forwarded-for": bad }),
      new Headers({ "x-forwarded-for": `${bad}, ${bad}`, "x-real-ip": bad }),
    ]) {
      const ip = clientIpFrom(h);
      assert.ok(ip.length <= 64, `result for ${JSON.stringify(bad)} is ${ip.length} chars`);
      assert.ok(
        ip === UNKNOWN_IP || isIP(ip) !== 0,
        `result for ${JSON.stringify(bad)} was ${JSON.stringify(ip)} — neither an IP nor the unknown marker`,
      );
    }
  }
});

test("IPv6 peers are accepted; an IPv4-mapped peer collapses to its IPv4 form", () => {
  assert.equal(clientIpFrom(new Headers({ "x-real-ip": "2001:DB8::1" })), "2001:db8::1");
  // Dual-stack sockets report IPv4 peers as ::ffff:a.b.c.d. Left alone, every
  // such peer would mask to the same audit prefix and share one rate-limit key
  // shape with nothing else.
  assert.equal(clientIpFrom(new Headers({ "x-real-ip": "::ffff:203.0.113.7" })), REAL);
});
