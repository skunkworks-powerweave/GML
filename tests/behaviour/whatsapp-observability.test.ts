// Can an operator tell that WhatsApp ingest is broken? Executed.
//
// ── THE DEFECT (F139) ────────────────────────────────────────────────────────
//
// A misconfigured or failing integration looked healthy everywhere:
//
//   - /api/health reported ok with no WhatsApp field at all, so a deployment
//     with the secret set and the access token missing -- the state compose
//     accepts -- was green while every video was dropped;
//   - with WHATSAPP_VERIFY_TOKEN unset, Meta's webhook handshake got a 403 and
//     the logs said nothing;
//   - with the WRONG secret, every delivery was a 401 and the logs said
//     nothing either -- the troubleshooting tables told operators to look for
//     a "refusal line" that is printed only when the secret is UNSET;
//   - docs/audit-actions.md described metadata the code never wrote
//     (url_failed's httpStatus, signature_failed's ipMasked) and omitted rows
//     it does write, so an operator reading the audit log could not tell a
//     token expiry from a Meta outage.
//
// These tests read what the running code reports.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { needsDatabase, DATABASE_URL, tag } from "./_harness.js";
import { render, request, resetRequest } from "./_ui.js";
import {
  acceptAndClaim,
  envelope,
  fakeGraph,
  fakeStorage,
  route,
  SECRET,
  signed,
  videoMessage,
  waitFor,
  withEnv,
  withWorld,
} from "./_whatsapp.js";

const skip = needsDatabase();

after(async () => {
  if (!DATABASE_URL) return;
  const { getPool } = await import("../../packages/db/src/client.ts");
  await getPool().end();
});

// Secret set, nothing else: the state compose accepts. No Supabase either, so
// the storage probe answers "not set" without leaving the machine.
const PARTLY = {
  WHATSAPP_APP_SECRET: SECRET,
  WHATSAPP_VERIFY_TOKEN: undefined,
  WHATSAPP_ACCESS_TOKEN: undefined,
  WHATSAPP_PHONE_NUMBER_ID: undefined,
  NEXT_PUBLIC_SUPABASE_URL: undefined,
  SUPABASE_SECRET_KEY: undefined,
};

async function health(): Promise<Record<string, unknown>> {
  const { GET } = await import("../../apps/web/src/app/api/health/route.ts");
  return (await (await GET()).json()) as Record<string, unknown>;
}

/** Collect what console.warn / console.error print while `body` runs. */
async function captureLogs(body: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const [w, e] = [console.warn, console.error];
  console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    await body();
  } finally {
    console.warn = w;
    console.error = e;
  }
  return lines.join("\n");
}

test("F139: /api/health says whether WhatsApp is off, partly set up or on, and what is missing", { skip }, async () => {
  await withEnv({ ...PARTLY, WHATSAPP_APP_SECRET: undefined }, async () => {
    assert.equal((await health()).whatsapp, "off");
  });
  await withEnv(PARTLY, () =>
    withWorld(async (w) => {
      await acceptAndClaim(w).catch(() => undefined); // leaves a fetch that cannot run without a token
      const { POST } = await route();
      await POST(signed(envelope([videoMessage({ id: w.wamid(), from: w.teacher.phone, caption: w.cycleCode })])));
      const body = await health();
      assert.equal(body.whatsapp, "partial", "a secret with no access token accepts videos it cannot fetch");
      const wa = (body.details as Record<string, Record<string, unknown>>).whatsapp!;
      assert.deepEqual(
        [...(wa.missing as string[])].sort(),
        ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_VERIFY_TOKEN"],
      );
      assert.ok(Number(wa.pendingFetches) >= 1, "videos waiting on a fetch are counted");
    }),
  );
  await withEnv(
    { ...PARTLY, WHATSAPP_VERIFY_TOKEN: "v", WHATSAPP_ACCESS_TOKEN: "t", WHATSAPP_PHONE_NUMBER_ID: "p" },
    async () => {
      assert.equal((await health()).whatsapp, "on");
    },
  );
});

test("F139: an unset verify token and a wrong app secret each say so in the logs", { skip }, async () => {
  await withEnv(PARTLY, async () => {
    const { GET, POST } = await route();
    const handshake = await captureLogs(async () => {
      const res = await GET(
        new Request("http://x/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=anything&hub.challenge=42"),
      );
      assert.equal(res.status, 403);
    });
    assert.match(handshake, /WHATSAPP_VERIFY_TOKEN/, "Meta's handshake was refused with nothing in the logs");

    const ip = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.9`;
    const wrong = await captureLogs(async () => {
      const res = await POST(
        new Request("http://x/api/webhooks/whatsapp", {
          method: "POST",
          headers: { "x-real-ip": ip, "x-hub-signature-256": "sha256=" + "1".repeat(64) },
          body: "{}",
        }),
      );
      assert.equal(res.status, 401);
    });
    assert.match(wrong, /WHATSAPP_APP_SECRET/, "a wrong secret made every delivery a 401 and logged nothing");
  });
});

test("F139: the ingest log says what the configuration is missing", { skip }, async () => {
  await withEnv(PARTLY, async () => {
    const id = randomUUID();
    (globalThis as Record<string, unknown>).__gmlTestSession = {
      user: { id, email: `${id}@example.test`, name: "Operator", image: null, role: "super_admin" },
    };
    const { default: Page } = await import("../../apps/web/src/app/(authenticated)/admin/whatsapp-log/page.tsx");
    const html = await render(await Page({ searchParams: Promise.resolve({}) }));
    assert.match(html, /WHATSAPP_ACCESS_TOKEN/, "the page an operator opens first must say why videos are not arriving");
  });
});

test("F139: docs/audit-actions.md documents every whatsapp.* row the code writes, with its real metadata", { skip }, async () => {
  const REPLIES = { WHATSAPP_ACCESS_TOKEN: "t", WHATSAPP_PHONE_NUMBER_ID: "PNID" };
  const ua = tag("wa-doc");
  const written = new Map<string, { entity_type: string; keys: Set<string> }>();
  const EXPECTED = [
    "whatsapp.signature_failed",
    "whatsapp.message.received",
    "whatsapp.message.replay_ignored",
    "whatsapp.message.ignored",
    "whatsapp.context.unmatched",
    "whatsapp.context.forbidden",
    "whatsapp.fetch.enqueued",
    "whatsapp.media.fetched",
    "whatsapp.media.fetch_failed",
    "whatsapp.reply.sent",
    "whatsapp.log.surface_viewed",
    "whatsapp.fetch.retried",
  ];
  const collect = async (c: import("pg").Client, where: string, params: unknown[]) => {
    // The rows are written fire-and-forget; read until every expected one is in.
    const rows = await waitFor(
      async () =>
        (await c.query(`SELECT action, entity_type, metadata FROM audit_log WHERE action LIKE 'whatsapp.%' AND (${where})`, params))
          .rows as Array<{ action: string; entity_type: string; metadata: Record<string, unknown> }>,
      (rs) => EXPECTED.every((a) => rs.some((r) => r.action === a)),
    );
    for (const r of rows) {
      const e = written.get(r.action) ?? { entity_type: r.entity_type, keys: new Set<string>() };
      for (const k of Object.keys(r.metadata ?? {})) if (k !== "__dedupKey") e.keys.add(k);
      written.set(r.action, e);
    }
  };

  await withEnv(PARTLY, () =>
    withWorld(async (w) => {
      const since = new Date(Date.now() - 1000);
      request.headers = { "user-agent": ua };
      const { POST } = await route();
      // signature_failed
      const sourceIp = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.1`;
      await POST(new Request("http://x/api/webhooks/whatsapp", { method: "POST", headers: { "x-real-ip": sourceIp }, body: "{}" }));
      // received + fetch.enqueued, then replay_ignored
      const linked = w.wamid();
      const body = envelope([videoMessage({ id: linked, from: w.teacher.phone, caption: w.cycleCode })]);
      await POST(signed(body));
      await POST(signed(body));
      // context.unmatched, context.forbidden, message.ignored
      await POST(signed(envelope([videoMessage({ id: w.wamid(), from: w.teacher.phone, caption: "no code" })])));
      await POST(signed(envelope([videoMessage({ id: w.wamid(), from: w.otherTeacher.phone, caption: w.cycleCode })])));
      await POST(signed(envelope([{ from: w.teacher.phone, id: w.wamid(), timestamp: "1", type: "text", text: { body: "hi" } }])));
      // The worker's rows: fetched (+ checksum_mismatch, reply.sent), then fetch_failed.
      const { fetchWhatsAppMedia } = await import("../../apps/worker/src/whatsapp-fetch.ts");
      const ok = await acceptAndClaim(w);
      await fetchWhatsAppMedia(ok.job.payload as never, { attempt: 1, maxAttempts: 10 }, { fetch: fakeGraph().fetch, put: fakeStorage().put, env: REPLIES });
      const bad = await acceptAndClaim(w);
      await fetchWhatsAppMedia(bad.job.payload as never, { attempt: 10, maxAttempts: 10 }, {
        fetch: fakeGraph({ meta: new Response("", { status: 500 }) }).fetch,
        put: fakeStorage().put,
        env: REPLIES,
      }).catch(() => undefined);
      // The ingest log's own rows: surface_viewed and fetch.retried.
      const id = randomUUID();
      (globalThis as Record<string, unknown>).__gmlTestSession = {
        user: { id, email: `${id}@example.test`, name: "Operator", image: null, role: "super_admin" },
      };
      const { default: Page } = await import("../../apps/web/src/app/(authenticated)/admin/whatsapp-log/page.tsx");
      await render(await Page({ searchParams: Promise.resolve({}) }));
      const { retryWhatsAppFetchAction } = await import("../../apps/web/src/app/(authenticated)/admin/whatsapp-log/actions.ts");
      const fd = new FormData();
      fd.set("submissionId", String((await w.submission(bad.id))!.id));
      await retryWhatsAppFetchAction(fd).catch(() => undefined); // ends in redirect()

      await collect(w.c, `created_at >= $1 AND (metadata->>'msgId' LIKE $2 OR user_agent = $3)`, [since, `wamid.${w.T}%`, ua]);
      resetRequest();
    }),
  );

  const doc = readFileSync(new URL("../../docs/audit-actions.md", import.meta.url), "utf8");
  const start = doc.indexOf("## whatsapp.*");
  const section = doc.slice(start, doc.indexOf("\n## ", start + 1));
  const documented = section
    .split("\n")
    .map((l) => /^\| `(whatsapp\.[a-z_.]+)` \|/.exec(l)?.[1])
    .filter((a): a is string => Boolean(a));

  for (const expected of EXPECTED) {
    assert.ok(written.has(expected), `the scenario above should have written ${expected}`);
  }
  for (const [action, { entity_type, keys }] of written) {
    const line = section.split("\n").find((l) => l.startsWith(`| \`${action}\` |`));
    assert.ok(line, `${action} is written by the code and missing from docs/audit-actions.md`);
    for (const key of keys) assert.ok(line!.includes(`\`${key}\``), `${action}: metadata key ${key} is not documented`);
    assert.ok(line!.includes(`\`${entity_type}\``), `${action}: entity_type ${entity_type} is not documented`);
  }
  // And nothing documented that no code writes: the doc is what an operator
  // reads to interpret the log.
  const sources = [
    "../../apps/web/src/app/api/webhooks/whatsapp/route.ts",
    "../../apps/worker/src/whatsapp-fetch.ts",
    "../../apps/web/src/app/(authenticated)/admin/whatsapp-log/page.tsx",
    "../../apps/web/src/app/(authenticated)/admin/whatsapp-log/actions.ts",
  ]
    .map((p) => readFileSync(new URL(p, import.meta.url), "utf8"))
    .join("\n");
  for (const action of documented) {
    assert.ok(sources.includes(`"${action}"`), `docs/audit-actions.md documents ${action}, which nothing writes`);
  }
});

// A worker killed during a fetch's last attempt leaves the job 'running' with
// an expired lease; the reaper dead-letters it. It did so without setting
// completed_at, and the health count of fetches that gave up is "dead with
// completed_at in the last 24 hours", so an exhausted fetch never showed as
// dead (and pruneFinished, which also keys on completed_at, never removed it).
test("F93: a fetch dead-lettered by the lease reaper counts as a fetch that gave up", { skip }, async () => {
  await withEnv(PARTLY, () =>
    withWorld(async (w) => {
      const { job } = await acceptAndClaim(w);
      // The worker died mid-attempt on the last try.
      await w.c.query(`UPDATE jobs SET attempts = max_attempts, lease_expires_at = now() - interval '1 minute' WHERE id = $1`, [job.id]);
      const dead = async () =>
        Number(((await health()).details as Record<string, Record<string, unknown>>).whatsapp!.deadFetches24h);
      const before = await dead();

      const { reapExpiredLeases } = await import("../../packages/db/src/queue.ts");
      const { db } = await import("../../packages/db/src/index.ts");
      await reapExpiredLeases(db as never);

      const [row] = (await w.c.query(`SELECT status, completed_at FROM jobs WHERE id = $1`, [job.id])).rows;
      assert.equal(row.status, "dead");
      assert.ok(row.completed_at, "a dead-lettered job has finished; completed_at is what health and pruning read");
      assert.ok((await dead()) > before, "the exhausted fetch must be counted as one that gave up");
    }),
  );
});
