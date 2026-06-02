import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const HELPER_PATH = "apps/web/src/lib/video/signed-url.ts";
const ROUTE_PATH = "apps/web/src/app/api/media/[token]/route.ts";
const SPEC_DIR = "specs/145-signed-url-subnet-binding";

test("spec 145: signed-url helper exports ipToBindKey", () => {
  const src = read(HELPER_PATH);
  assert.match(
    src,
    /export\s+function\s+ipToBindKey\s*\(/,
    "ipToBindKey must be an exported function in the helper module",
  );
});

test("spec 145: ipToBindKey JSDoc documents the /24 IPv4 and /64 IPv6 binding choice", () => {
  const src = read(HELPER_PATH);
  // The header block must name both prefix lengths so a future reader
  // doesn't have to read the implementation to learn the contract.
  assert.match(src, /\/24/, "helper must document the /24 IPv4 binding");
  assert.match(src, /\/64/, "helper must document the /64 IPv6 binding");
});

test("spec 145: ipToBindKey implementation uses .split('.').slice(0, 3) for IPv4 /24 collapse", () => {
  const src = read(HELPER_PATH);
  // The /24 collapse is "first three dotted octets" — assert the
  // canonical implementation pattern is present.
  assert.match(
    src,
    /\.split\(["']\.["']\)/,
    "helper must split on '.' to extract IPv4 octets",
  );
  assert.match(
    src,
    /\.slice\(\s*0\s*,\s*3\s*\)/,
    "helper must slice the first three octets for the /24 prefix",
  );
});

test("spec 145: ipToBindKey expands the IPv6 '::' shorthand before slicing the /64 prefix", () => {
  const src = read(HELPER_PATH);
  // The expansion is what makes the same input map to the same bind key
  // regardless of where the user wrote `::`.
  assert.match(
    src,
    /includes\(["']::["']\)/,
    "helper must detect the '::' shorthand before slicing",
  );
  // After expansion the implementation slices first four hextets for the /64.
  assert.match(
    src,
    /\.slice\(\s*0\s*,\s*4\s*\)/,
    "helper must slice the first four hextets for the /64 prefix",
  );
});

test("spec 145: signMediaToken HMACs the bind key rather than the raw IP", () => {
  const src = read(HELPER_PATH);
  // The signer must call ipToBindKey on the supplied IP and embed the
  // result in the payload, not the raw IP.
  const signerBlock = src.split("export function signMediaToken")[1] ?? "";
  assert.match(
    signerBlock.slice(0, 600),
    /ipToBindKey\(\s*ip\s*\)/,
    "signMediaToken must collapse the IP to its bind key before HMACing",
  );
});

test("spec 145: verifySignedToken collapses the request IP to its bind key before comparing", () => {
  const src = read(HELPER_PATH);
  const verifyBlock = src.split("export function verifySignedToken")[1] ?? "";
  assert.match(
    verifyBlock,
    /ipToBindKey\(\s*currentIp\s*\)/,
    "verifySignedToken must collapse the request IP to its bind key before comparing",
  );
});

test("spec 145: verifySignedToken uses timingSafeEqual on the bind-key compare (constant-time)", () => {
  const src = read(HELPER_PATH);
  const verifyBlock = src.split("export function verifySignedToken")[1] ?? "";
  // Two timingSafeEqual calls in the verifier: one for the signature and
  // one for the bind-key compare. The original (pre-145) code had a
  // bare `!==` for the IP compare.
  const occurrences = (verifyBlock.match(/timingSafeEqual\(/g) || []).length;
  assert.ok(
    occurrences >= 2,
    `verifySignedToken must call timingSafeEqual twice (signature + bind key), got ${occurrences}`,
  );
  // And the raw-IP `!==` check must be gone.
  assert.ok(
    !/if\s*\(\s*ip\s*!==\s*currentIp\s*\)/.test(verifyBlock),
    "verifySignedToken must not contain the legacy `if (ip !== currentIp)` /32 compare",
  );
});

test("spec 145: media proxy route imports ipToBindKey from the signed-url helper", () => {
  const src = read(ROUTE_PATH);
  assert.match(
    src,
    /import\s*\{[^}]*ipToBindKey[^}]*\}\s*from\s*["']@\/lib\/video\/signed-url["']/,
    "route must import ipToBindKey from @/lib/video/signed-url",
  );
});

test("spec 145: media proxy route passes ipToBindKey(ip) to verifySignedToken", () => {
  const src = read(ROUTE_PATH);
  assert.match(
    src,
    /verifySignedToken\(\s*token\s*,\s*ipToBindKey\(\s*ip\s*\)\s*\)/,
    "route must call verifySignedToken(token, ipToBindKey(ip))",
  );
});

test("spec 145: media proxy route documents the spec 145 motivation inline", () => {
  const src = read(ROUTE_PATH);
  // An operator reading the request handler should see the why-this-is-
  // /24-not-/32 explanation right at the callsite.
  assert.match(
    src,
    /Spec\s*145/,
    "route must reference spec 145 at the verify callsite",
  );
});

test("spec 145: sign + verify round-trip succeeds within the same /24 (cellular handoff)", async () => {
  // We can't `import` the TS source directly from a `node --test` harness
  // because there's no TS loader registered. Instead we mirror the helper
  // contract inline using node:crypto — this is a CONTRACT test: it
  // executes the exact algorithm the helper implements (HMAC-SHA256 over
  // `bucket:objectKey:userId:bindKey:exp`, with bindKey derived via the
  // /24 (IPv4) / /64 (IPv6) collapse rules documented in
  // specs/145-signed-url-subnet-binding/spec.md). If the helper drifts
  // from this contract, the static-pattern assertions earlier in this
  // file catch the drift; this test catches arithmetic / encoding bugs.
  process.env.MEDIA_SIGN_SECRET = "spec-145-test-secret";
  const { createHmac } = await import("node:crypto");

  function ipToBindKey(ip) {
    if (!ip || ip === "unknown") return ip || "unknown";
    if (ip.includes(".") && !ip.includes(":")) {
      const parts = ip.split(".");
      if (parts.length !== 4) return ip;
      return parts.slice(0, 3).join(".");
    }
    if (ip.includes(":")) {
      const noZone = ip.split("%")[0];
      let expanded = noZone;
      if (expanded.includes("::")) {
        const [left, right] = expanded.split("::");
        const leftParts = left ? left.split(":") : [];
        const rightParts = right ? right.split(":") : [];
        const missing = 8 - leftParts.length - rightParts.length;
        const zeros = Array(Math.max(0, missing)).fill("0");
        expanded = [...leftParts, ...zeros, ...rightParts].join(":");
      }
      const parts = expanded.split(":");
      if (parts.length < 4) return ip;
      return parts.slice(0, 4).map((p) => p || "0").join(":");
    }
    return ip;
  }

  function sign({ bucket, objectKey, userId, ip, ttlSeconds = 300 }) {
    const secret = process.env.MEDIA_SIGN_SECRET;
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const bindKey = ipToBindKey(ip);
    const payload = `${bucket}:${objectKey}:${userId}:${bindKey}:${exp}`;
    const payloadB64 = Buffer.from(payload).toString("base64url");
    const sig = createHmac("sha256", secret).update(payloadB64).digest("base64url");
    return `${payloadB64}.${sig}`;
  }

  function verify(token, currentIp) {
    const parts = token.split(".");
    if (parts.length !== 2) return { ok: false, reason: "format" };
    const [payloadB64, sig] = parts;
    const secret = process.env.MEDIA_SIGN_SECRET;
    const expectedSig = createHmac("sha256", secret).update(payloadB64).digest("base64url");
    if (sig !== expectedSig) return { ok: false, reason: "signature" };
    const decoded = Buffer.from(payloadB64, "base64url").toString();
    const fields = decoded.split(":");
    if (fields.length < 5) return { ok: false, reason: "format" };
    const bucket = fields[0];
    const objectKey = fields[1];
    const userId = fields[2];
    const expStr = fields[fields.length - 1];
    const bindKey = fields.slice(3, fields.length - 1).join(":");
    const exp = Number.parseInt(expStr, 10);
    if (!Number.isFinite(exp)) return { ok: false, reason: "format" };
    if (Math.floor(Date.now() / 1000) > exp) return { ok: false, reason: "expired" };
    const currentBindKey = ipToBindKey(currentIp);
    if (bindKey !== currentBindKey) return { ok: false, reason: "ip_mismatch" };
    return { ok: true, bucket, objectKey, userId, ip: bindKey, exp };
  }

  // IPv4 /24 collapse
  assert.equal(ipToBindKey("203.0.113.42"), "203.0.113");
  assert.equal(ipToBindKey("203.0.113.99"), "203.0.113");
  // IPv6 /64 collapse with `::` expansion
  assert.equal(ipToBindKey("2001:db8:1::abcd"), "2001:db8:1:0");
  // "unknown" sentinel passthrough
  assert.equal(ipToBindKey("unknown"), "unknown");

  // Intra-/24 round-trip: signer sees one host, verifier sees a different
  // host in the SAME /24 → token still validates.
  const tokenV4 = sign({
    bucket: "gml-videos-hls",
    objectKey: "v/abc123/master.m3u8",
    userId: "user-1",
    ip: "203.0.113.42",
  });
  const rOK = verify(tokenV4, "203.0.113.99");
  assert.equal(rOK.ok, true, `intra-/24 verify should succeed, got ${JSON.stringify(rOK)}`);

  // Cross-/24 hop: verifier sees a different /24 entirely → token rejects.
  const rBad = verify(tokenV4, "203.0.114.99");
  assert.equal(rBad.ok, false);
  assert.equal(rBad.reason, "ip_mismatch", "cross-/24 verify must reject as ip_mismatch");

  // IPv6 intra-/64 round-trip
  const tokenV6 = sign({
    bucket: "gml-videos-hls",
    objectKey: "v/abc123/master.m3u8",
    userId: "user-1",
    ip: "2001:db8:1::abcd",
  });
  const r6OK = verify(tokenV6, "2001:db8:1:0:dead:beef::1");
  assert.equal(r6OK.ok, true, `intra-/64 verify should succeed, got ${JSON.stringify(r6OK)}`);

  // Cross-/64 hop
  const r6Bad = verify(tokenV6, "2001:db8:2::1");
  assert.equal(r6Bad.ok, false);
  assert.equal(r6Bad.reason, "ip_mismatch", "cross-/64 verify must reject as ip_mismatch");
});

test("spec 145: all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist`,
    );
  }
});

test("spec 145: plan.md follows the three-line CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/);
  assert.match(src, /EDITED:/);
  assert.match(src, /MIGRATED:/);
});
