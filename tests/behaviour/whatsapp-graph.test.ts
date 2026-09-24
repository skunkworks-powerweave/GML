// Behaviour test — the Graph API URL the WhatsApp webhook actually builds.
//
// This tier EXECUTES the code. tests/governance/test_173 reads the source text
// and can only assert that a version literal is absent and that the pinned
// string sits in a table; neither of those observes what URL comes out. Both
// exist because they catch different things: the governance file catches the
// version going stale on a date, this one catches the builder being wrong.
//
// NO DATABASE. Every other file in this directory calls needsDatabase() and
// skips without one; this module is pure — no db import, no server-only, no Next
// runtime — so it runs anywhere tsx runs. That is a property worth keeping: it is
// the reason the version pin is testable at all, and it is why the constant was
// put in packages/shared rather than left in the route, which cannot be imported
// outside Next.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GRAPH_API_VERSION,
  graphApiVersion,
  mediaMetadataUrl,
  type EnvLike,
} from "@gml/shared/whatsapp/graph";

/**
 * A fresh env each time, so these tests cannot leak into each other — and so
 * nothing here touches the real `process.env`.
 *
 * `EnvLike`, not `NodeJS.ProcessEnv`: `packages/shared` declares no `@types/node`
 * and must not, because it is imported by browser-bound code. The first version
 * of the module used the Node type, typechecked on this machine where the types
 * happen to be reachable through the pnpm store, and failed CI on a clean
 * install with TS2503/TS2591.
 */
const env = (over: EnvLike = {}): EnvLike => ({ ...over });

test("the media URL carries the pinned version, not a literal", () => {
  const url = mediaMetadataUrl("MEDIA123", env());
  assert.equal(url, `https://graph.facebook.com/${DEFAULT_GRAPH_API_VERSION}/MEDIA123`);
  // The defect, stated as an assertion: the version that was hardcoded here for
  // four months past its expiry must not be what comes out.
  assert.doesNotMatch(url, /\/v19\.0\//, "v19.0 expired 2026-05-21 and must not be called");
});

test("the version is overridable for an expiry, without a code change", () => {
  assert.equal(
    mediaMetadataUrl("M1", env({ WHATSAPP_GRAPH_API_VERSION: "v26.0" })),
    "https://graph.facebook.com/v26.0/M1",
  );
  assert.equal(graphApiVersion(env({ WHATSAPP_GRAPH_API_VERSION: "v26.0" })), "v26.0");
});

test("an unset or blank override falls back to the pin", () => {
  assert.equal(graphApiVersion(env()), DEFAULT_GRAPH_API_VERSION);
  assert.equal(graphApiVersion(env({ WHATSAPP_GRAPH_API_VERSION: "" })), DEFAULT_GRAPH_API_VERSION);
  assert.equal(
    graphApiVersion(env({ WHATSAPP_GRAPH_API_VERSION: "   " })),
    DEFAULT_GRAPH_API_VERSION,
  );
  // A trailing newline is what you get from `VAR=$(cat file)` and from some
  // secret managers; it must not reach the URL path.
  assert.equal(
    graphApiVersion(env({ WHATSAPP_GRAPH_API_VERSION: "v26.0\n" })),
    "v26.0",
  );
});

test("a malformed override is refused, not pasted into the URL", () => {
  // Without this, `v25` or `25.0` goes straight into the path, Meta rejects it,
  // and `!r.ok` turns that into a dropped video. It is not SILENT — route.ts
  // audits it as `whatsapp.media.url_failed` — but nothing in that row points at
  // the variable that caused it, so it reads as a Meta outage.
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    for (const bad of ["v25", "25.0", "latest", "v25.0/../v19.0", "v-1.0", "V25.0"]) {
      assert.equal(
        graphApiVersion(env({ WHATSAPP_GRAPH_API_VERSION: bad })),
        DEFAULT_GRAPH_API_VERSION,
        `"${bad}" is not a Graph version and must not be used`,
      );
    }
  } finally {
    console.error = realError;
  }
  assert.equal(errors.length, 6, "each rejected override must say so on stderr, not fail silently");
  assert.match(errors[0]!, /WHATSAPP_GRAPH_API_VERSION/);
});

test("the media id is percent-encoded, because it comes from a webhook payload", () => {
  // The id is attacker-supplied in the sense that matters: it arrives in an
  // inbound POST body. An unencoded `/` or `?` would change which endpoint is
  // called, not just which object.
  assert.equal(
    mediaMetadataUrl("../me?fields=id", env()),
    `https://graph.facebook.com/${DEFAULT_GRAPH_API_VERSION}/..%2Fme%3Ffields%3Did`,
  );
  const parsed = new URL(mediaMetadataUrl("a/b", env()));
  assert.equal(parsed.host, "graph.facebook.com");
  assert.equal(parsed.pathname, `/${DEFAULT_GRAPH_API_VERSION}/a%2Fb`);
});

test("the pinned version is a shape Meta publishes", () => {
  assert.match(DEFAULT_GRAPH_API_VERSION, /^v\d+\.\d+$/);
});
