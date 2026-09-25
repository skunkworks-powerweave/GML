// Shared fixtures for the WhatsApp ingest behaviour tests.
//
// The webhook route is executed for real: a correctly signed Meta payload goes
// into its POST handler, against a real Postgres. What is replaced is only what
// sits outside the process -- Meta's Graph API and Supabase Storage -- and, for
// the webhook, Next's `after()`, which throws outside a request scope. The
// stand-in records the callbacks instead of running them, which is exactly the
// state a deployment is in between answering Meta and running the deferred
// work: if the process restarts there, whatever was only in a closure is gone.

import { createRequire } from "node:module";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import "./_ui.js"; // the @/ alias and framework stubs, for apps/web modules
import { DATABASE_URL, tag } from "./_harness.js";

const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));

/** Callbacks the route handed to after(), not yet run. */
export const deferred: Array<() => unknown> = [];
(webRequire("next/server") as { after: (cb: () => unknown) => void }).after = (cb) => {
  deferred.push(cb);
};

/** Run what the route deferred, as Next would once the response is sent. */
export async function runDeferred(): Promise<void> {
  while (deferred.length) await deferred.shift()!();
}

export const SECRET = "test-app-secret";

export const route = () => import("../../apps/web/src/app/api/webhooks/whatsapp/route.ts");

export function signed(body: string, secret = SECRET): Request {
  return new Request("http://127.0.0.1:3100/api/webhooks/whatsapp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
    },
    body,
  });
}

/** Meta's envelope around a batch of messages. */
export function envelope(messages: unknown[]): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA-TEST",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550001111", phone_number_id: "PNID-TEST" },
              messages,
            },
          },
        ],
      },
    ],
  });
}

export function videoMessage(o: { id: string; from: string; caption?: string; mediaId?: string; mime?: string }) {
  return {
    from: o.from,
    id: o.id,
    timestamp: String(Math.floor(Date.now() / 1000)),
    type: "video",
    video: {
      id: o.mediaId ?? `MEDIA-${o.id}`,
      mime_type: o.mime ?? "video/mp4",
      sha256: "0".repeat(64),
      ...(o.caption !== undefined ? { caption: o.caption } : {}),
    },
  };
}

/** A long lesson attached through WhatsApp's "Document" picker. */
export function documentMessage(o: { id: string; from: string; caption?: string; mime?: string }) {
  return {
    from: o.from,
    id: o.id,
    timestamp: String(Math.floor(Date.now() / 1000)),
    type: "document",
    document: {
      id: `MEDIA-${o.id}`,
      mime_type: o.mime ?? "video/mp4",
      filename: "lesson-recording.mp4",
      sha256: "0".repeat(64),
      ...(o.caption !== undefined ? { caption: o.caption } : {}),
    },
  };
}

export type Person = { userId: string; phone: string };

export type World = {
  c: Client;
  T: string;
  /** A fresh WhatsApp message id under this world's tag. */
  wamid: () => string;
  teacher: Person & { teacherId: string };
  otherTeacher: Person & { teacherId: string };
  cycleCode: string;
  cycleId: string;
  otherCycleCode: string;
  otherCycleId: string;
  submission: (wamid: string) => Promise<Record<string, unknown> | undefined>;
  jobs: (wamid: string) => Promise<Array<Record<string, unknown>>>;
  audits: (action: string, wamid: string) => Promise<Array<Record<string, unknown>>>;
};

/** A ten-digit Indian mobile number no other test will hold. */
function phone(): string {
  return "9" + String(Math.floor(Math.random() * 1e9)).padStart(9, "0");
}

export async function withWorld(body: (w: World) => Promise<void>): Promise<void> {
  const c = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
  await c.connect();
  const T = tag("wa").replace(/-/g, "");
  let n = 0;
  const one = async (q: string, params: unknown[]): Promise<string> => (await c.query(q, params)).rows[0].id as string;
  const district = await one(`INSERT INTO districts (name, code) VALUES ($1, $2) RETURNING id`, [`D ${T}`, T.slice(-12)]);
  const zone = await one(`INSERT INTO zones (district_id, name) VALUES ($1, $2) RETURNING id`, [district, `Z ${T}`]);
  const school = await one(`INSERT INTO schools (zone_id, name, code) VALUES ($1, $2, $3) RETURNING id`, [zone, `S ${T}`, T.slice(-12)]);
  const person = async (label: string) => {
    const p = phone();
    const userId = await one(
      `INSERT INTO users (id, email, name, role) VALUES (gen_random_uuid(), $1, $2, 'teacher') RETURNING id`,
      [`${label}.${T}@example.test`, `${label} ${T}`],
    );
    // Entered the way an administrator types it, not the way Meta sends it.
    const teacherId = await one(
      `INSERT INTO teachers (user_id, school_id, full_name, phone) VALUES ($1, $2, $3, $4) RETURNING id`,
      [userId, school, `${label} ${T}`, `+91 ${p.slice(0, 5)} ${p.slice(5)}`],
    );
    return { userId, teacherId, phone: `91${p}` };
  };
  const teacher = await person("teacher");
  const otherTeacher = await person("other");
  const year = 9000 + Math.floor(Math.random() * 999);
  const cycleCode = `OBS-${year}-${String(Math.floor(Math.random() * 900) + 100)}`;
  const otherCycleCode = `OBS-${year}-${String(Math.floor(Math.random() * 900) + 100)}X`;
  const cycle = (code: string, teacherId: string) =>
    one(
      `INSERT INTO observation_cycles (code, teacher_id, kind, topic, scheduled_at) VALUES ($1, $2, 'evaluative', 'Fractions', now()) RETURNING id`,
      [code, teacherId],
    );
  const cycleId = await cycle(cycleCode, teacher.teacherId);
  const otherCycleId = await cycle(otherCycleCode, otherTeacher.teacherId);

  const w: World = {
    c,
    T,
    wamid: () => `wamid.${T}${++n}`,
    teacher,
    otherTeacher,
    cycleCode,
    cycleId,
    otherCycleCode,
    otherCycleId,
    submission: async (wamid) =>
      (
        await c.query(
          `SELECT v.*, f.status AS file_status, f.object_key, f.bucket, f.mime_type AS file_mime
             FROM video_submissions v JOIN files f ON f.id = v.file_id
            WHERE v.whatsapp_message_id = $1`,
          [wamid],
        )
      ).rows[0],
    jobs: async (wamid) =>
      (await c.query(`SELECT * FROM jobs WHERE payload->>'msgId' = $1 OR dedupe_key = $2 ORDER BY created_at`, [wamid, `wa:${wamid}`]))
        .rows,
    audits: async (action, wamid) =>
      (await c.query(`SELECT * FROM audit_log WHERE action = $1 AND metadata->>'msgId' = $2`, [action, wamid])).rows,
  };
  try {
    await body(w);
  } finally {
    const like = `wamid.${T}%`;
    const subs = (await c.query(`SELECT id, file_id FROM video_submissions WHERE whatsapp_message_id LIKE $1`, [like])).rows;
    await c.query(`DELETE FROM jobs WHERE payload->>'msgId' LIKE $1 OR dedupe_key LIKE $2`, [like, `wa:${like}`]);
    for (const s of subs) await c.query(`DELETE FROM jobs WHERE dedupe_key = $1`, [`submission:${s.id}`]);
    await c.query(`DELETE FROM video_submissions WHERE whatsapp_message_id LIKE $1`, [like]);
    await c.query(`DELETE FROM files WHERE object_key LIKE $1`, [`whatsapp/${like}`]);
    await c.query(`DELETE FROM observation_cycles WHERE id = ANY($1)`, [[cycleId, otherCycleId]]);
    await c.query(`DELETE FROM teachers WHERE id = ANY($1)`, [[teacher.teacherId, otherTeacher.teacherId]]);
    await c.query(`DELETE FROM users WHERE id = ANY($1)`, [[teacher.userId, otherTeacher.userId]]);
    await c.query(`DELETE FROM schools WHERE id = $1`, [school]);
    await c.query(`DELETE FROM zones WHERE id = $1`, [zone]);
    await c.query(`DELETE FROM districts WHERE id = $1`, [district]);
    await c.end();
  }
}

/** Run a body with WhatsApp configured the way compose allows: secret set, token not. */
export async function withEnv(vars: Record<string, string | undefined>, body: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    await body();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ── Waiting for fire-and-forget writes ──────────────────────────────────────
//
// The webhook writes its audit rows with `void recordAudit(...)`, so they land
// some time after POST returns. A fixed sleep was flaky: with the WhatsApp
// files running in parallel against one database, 300 ms was sometimes not
// enough (4 of 7 rows seen). These poll the database instead, bounded, and
// hand back the last value read so the caller's assertion reports what was
// actually there.

/** Read until `done(value)` holds or `timeoutMs` passes; return the last value read. */
export async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  { timeoutMs = 5000, intervalMs = 50 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    value = await read();
  }
  return value;
}

/**
 * Read a count until it has stopped growing for `quietMs` (and is at least
 * `atLeast`), so an upper bound is asserted on a settled number, not on a
 * snapshot taken while rows are still arriving.
 */
export async function waitForStableCount(
  read: () => Promise<number>,
  { atLeast = 1, quietMs = 750, timeoutMs = 8000 }: { atLeast?: number; quietMs?: number; timeoutMs?: number } = {},
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let n = await read();
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    const next = await read();
    if (next !== n) {
      n = next;
      stableSince = Date.now();
    } else if (n >= atLeast && Date.now() - stableSince >= quietMs) {
      break;
    }
  }
  return n;
}

// ── Graph, Meta's media CDN and Storage, for the worker's half ───────────────

export type GraphCall = { url: string; method: string; hasSignal: boolean; auth: string | null; body: unknown };

/**
 * Graph and Meta's media CDN, answering from a script. Replies the worker sends
 * (POST /{phone-number-id}/messages) are recorded in `sent`.
 */
export function fakeGraph(script: { meta?: Response; media?: Response; send?: Response } = {}) {
  const calls: GraphCall[] = [];
  const sent: Array<{ to: string; body: string }> = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, method: init?.method ?? "GET", hasSignal: init?.signal instanceof AbortSignal, auth: headers.get("authorization"), body });
    if (url.startsWith("https://graph.facebook.com/") && url.endsWith("/messages")) {
      sent.push({ to: String(body?.to), body: String(body?.text?.body) });
      return script.send ?? Response.json({ messaging_product: "whatsapp", messages: [{ id: "wamid.reply" }] });
    }
    if (url.startsWith("https://graph.facebook.com/")) {
      return script.meta ?? Response.json({ url: "https://lookaside.fbsbx.example/media/abc" });
    }
    return (
      script.media ??
      new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { headers: { "content-type": "video/mp4" } })
    );
  }) as typeof globalThis.fetch;
  return { calls, sent, fetch };
}

/**
 * Each bucket's allowed_mime_types, read from the migration that creates the
 * buckets (_post/005), so the fake refuses exactly what Supabase refuses.
 */
export function bucketAllowlist(bucket: string): ReadonlySet<string> {
  const sql = readFileSync(
    new URL("../../packages/db/src/migrations/_post/005_storage_buckets_and_policies.sql", import.meta.url),
    "utf8",
  );
  const m = new RegExp(String.raw`\('${bucket}',\s*'${bucket}'[\s\S]*?ARRAY\[([^\]]*)\]`).exec(sql);
  if (!m) throw new Error(`bucket ${bucket} not found in _post/005`);
  return new Set([...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!));
}

/**
 * Storage, answering the way Supabase does: an object whose content type the
 * bucket does not list is refused, with Storage's own message. A fake that
 * accepted everything hid that a sender-declared type such as video/x-m4v
 * could never be stored.
 */
export function fakeStorage() {
  const puts: Array<{ bucket: string; key: string; bytes: number; type: string }> = [];
  const put = async (bucket: string, key: string, body: Uint8Array, type: string) => {
    if (!bucketAllowlist(bucket).has(type)) throw new Error(`upload ${bucket}/${key}: mime type ${type} is not supported`);
    puts.push({ bucket, key, bytes: body.byteLength, type });
  };
  return { puts, put };
}

export type ClaimedJob = { id: string; queue: string; name: string; payload: Record<string, unknown>; attempts: number; maxAttempts: number };

/**
 * Claim one specific job the way the worker's claim() does (queued -> running,
 * attempts + 1). By id, because other test files share the queue and may have
 * jobs of their own ahead of this one.
 */
export async function claimJob(w: World, jobId: string): Promise<ClaimedJob> {
  const r = (
    await w.c.query(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_by = 'test-worker',
              lease_expires_at = now() + interval '15 minutes', updated_at = now()
        WHERE id = $1 AND status = 'queued'
        RETURNING id, queue, name, payload, attempts, max_attempts`,
      [jobId],
    )
  ).rows[0];
  if (!r) throw new Error(`job ${jobId} was not queued`);
  return { id: r.id, queue: r.queue, name: r.name, payload: r.payload, attempts: Number(r.attempts), maxAttempts: Number(r.max_attempts) };
}

/** Accept a message through the real webhook and claim its fetch job. */
export async function acceptAndClaim(
  w: World,
  opts: { caption?: string; from?: string; mime?: string; asDocument?: boolean } = {},
) {
  const { POST } = await route();
  const id = w.wamid();
  const m = { id, from: opts.from ?? w.teacher.phone, caption: opts.caption ?? w.cycleCode, mime: opts.mime };
  const res = await POST(signed(envelope([opts.asDocument ? documentMessage(m) : videoMessage(m)])));
  if (res.status !== 200) throw new Error(`webhook answered ${res.status}`);
  const [ours] = (await w.jobs(id)).filter((j) => j.name === "whatsapp_fetch");
  if (!ours) throw new Error("the webhook queued no fetch");
  const job = await claimJob(w, String(ours.id));
  if (job.queue !== "whatsapp") throw new Error(`fetch queued on ${job.queue}`);
  return { id, job };
}
