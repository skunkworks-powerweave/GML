// What Cmd+K tells a person when /api/quickfind does not answer their search
// -- executed: the real QuickFind component, driven through its own open
// event, input handler and debounced fetch.
//
// ── W3-26 ────────────────────────────────────────────────────────────────────
//
// The palette read only `res.ok`. Every refusal -- 429 over the throttle, 401
// once the session had ended, 503 when the limiter was down, any 5xx during
// an outage -- and every network failure became an empty result list, which
// it rendered as `No matches / No results for "<q>"`: a statement that the
// teacher or school being looked up does not exist. An admin checking a list
// could then create a duplicate. It is also why the route's throttle had to
// sit above anything a palette could send (400 a minute), rather than where
// the permanent audit row each search writes wants it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mount, hostElements, renderSync, decodeEntities } from "./_ui.js";

type Reply = Response | Error;

/**
 * Mount QuickFind in a stand-in window whose fetch answers with `reply`,
 * open it, type `q`, and return the overlay's markup once the debounced
 * search has settled. With several replies, `q` is typed again after each
 * (one more letter each time), and the markup is the last one's.
 */
async function searchWith(reply: Reply | Reply[], q = "Tsering"): Promise<{ html: string; urls: string[] }> {
  const replies = Array.isArray(reply) ? [...reply] : [reply];
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document, fetch: g.fetch };
  const urls: string[] = [];
  let html = "";
  const win = Object.assign(new EventTarget(), {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    location: { assign() {} },
  });
  g.window = win;
  // createPortal only checks that its container is an element node.
  g.document = { body: { nodeType: 1 } };
  g.fetch = async (url: string) => {
    urls.push(url);
    const next = replies[Math.min(urls.length, replies.length) - 1]!;
    if (next instanceof Error) throw next;
    return next.clone();
  };
  const { default: QuickFind } = await import("../../apps/web/src/components/quickfind/QuickFind.tsx");
  const { QUICKFIND_OPEN_EVENT } = await import("../../apps/web/src/components/quickfind/events.ts");
  const m = mount(QuickFind as (p: { userId: string }) => unknown, { userId: "u-quickfind" }, { effects: true, client: true });
  try {
    win.dispatchEvent(new Event(QUICKFIND_OPEN_EVENT));
    const overlay = () => (m.rerender() as unknown as { children: unknown }).children;
    const input = hostElements(overlay()).find((el) => el.type === "input");
    assert.ok(input, "the open palette has a search box");
    for (let i = 0; i < replies.length; i++) {
      (input.props.onChange as (e: unknown) => void)({ target: { value: q.slice(0, q.length - replies.length + 1 + i) } });
      m.rerender();
      // The debounce, then the fetch and the state it sets.
      await new Promise((r) => setTimeout(r, 400));
      html = decodeEntities(renderSync(overlay()));
    }
    return { html, urls };
  } finally {
    m.unmount();
    g.window = saved.window;
    g.document = saved.document;
    g.fetch = saved.fetch;
  }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const NO_RESULTS = /No results for "Tsering"/;

test("W3-26 QuickFind: a search that finds nothing still says so", async () => {
  const { html, urls } = await searchWith(json(200, { ok: true, q: "Tsering", results: [] }));
  assert.deepEqual(urls, ["/api/quickfind?q=Tsering"], "the palette searched once, after the debounce");
  assert.match(html, NO_RESULTS);
});

test("W3-26 QuickFind: over the throttle, it says to wait, and for how long -- not that nothing matched", async () => {
  const { html } = await searchWith(json(429, { error: "rate_limited", retryAfterMs: 41_200 }, { "Retry-After": "42" }));
  assert.doesNotMatch(html, NO_RESULTS, "a throttled search was shown as a search that found nothing");
  assert.match(html, /Too many searches/);
  assert.match(html, /42 s/, "the palette says when searching works again");
});

test("W3-26 QuickFind: a refusal or an outage is never shown as 'No results'", async () => {
  const cases: Array<[string, Reply, RegExp]> = [
    ["503 rate_limit_unavailable", json(503, { error: "rate_limit_unavailable" }), /Search unavailable/],
    ["500", json(500, { error: "internal" }), /Search unavailable/],
    ["401 (session ended)", json(401, { error: "unauthenticated" }), /Sign in again/],
    ["a network failure", new TypeError("fetch failed"), /Search unavailable/],
  ];
  for (const [what, reply, says] of cases) {
    const { html } = await searchWith(reply);
    assert.doesNotMatch(html, NO_RESULTS, `${what} was shown as a search that found nothing`);
    assert.match(html, says, `${what}: ${html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}`);
  }
});

test("W3-26 QuickFind: the next search that is answered replaces the refusal", async () => {
  const { html, urls } = await searchWith([
    json(429, { error: "rate_limited", retryAfterMs: 5_000 }, { "Retry-After": "5" }),
    json(200, { ok: true, q: "Tsering", results: [] }),
  ]);
  assert.deepEqual(urls, ["/api/quickfind?q=Tserin", "/api/quickfind?q=Tsering"]);
  assert.doesNotMatch(html, /Too many searches/, "an answered search still showed the earlier refusal");
  assert.match(html, NO_RESULTS);
});
