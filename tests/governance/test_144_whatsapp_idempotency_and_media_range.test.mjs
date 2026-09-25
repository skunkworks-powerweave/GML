import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const SCHEMA_PATH = "packages/db/src/schema/videos.ts";
const MIGRATION_SQL = "packages/db/src/migrations/0017_whatsapp_dedup.sql";
const JOURNAL_PATH = "packages/db/src/migrations/meta/_journal.json";
const SNAPSHOT_PATH = "packages/db/src/migrations/meta/0017_snapshot.json";
const WEBHOOK_PATH = "apps/web/src/app/api/webhooks/whatsapp/route.ts";
const MEDIA_PATH = "apps/web/src/app/api/media/[token]/route.ts";
const SPEC_DIR = "specs/144-whatsapp-idempotency-and-media-range";

test("spec 144: schema declares whatsappMessageId text column on videoSubmissions", () => {
  const src = read(SCHEMA_PATH);
  // The column ID in TS land is whatsappMessageId; the underlying DB name is
  // whatsapp_message_id. Both must appear in the schema file.
  assert.match(
    src,
    /whatsappMessageId\s*:\s*text\s*\(\s*["']whatsapp_message_id["']\s*\)/,
    "videos.ts must declare whatsappMessageId: text('whatsapp_message_id')",
  );
});

test("spec 144: schema declares a partial unique index WHERE whatsapp_message_id IS NOT NULL", () => {
  const src = read(SCHEMA_PATH);
  assert.match(
    src,
    /uniqueIndex\s*\(\s*["']video_submissions_whatsapp_message_id_uq["']\s*\)/,
    "videos.ts must declare uniqueIndex('video_submissions_whatsapp_message_id_uq')",
  );
  // The .where(...) clause must reference the column AND IS NOT NULL — that
  // is how Drizzle emits the partial predicate for PostgreSQL.
  assert.match(
    src,
    /uniqueIndex\s*\(\s*["']video_submissions_whatsapp_message_id_uq["']\s*\)[\s\S]{0,200}?\.where\s*\(\s*sql`[^`]*whatsappMessageId[^`]*IS\s+NOT\s+NULL[^`]*`/,
    "the unique index must carry a .where(sql`… IS NOT NULL`) predicate so non-whatsapp rows are exempt",
  );
});

test("spec 144: migration SQL adds the column AND creates the partial unique index", () => {
  assert.ok(existsSync(resolve(root, MIGRATION_SQL)), `${MIGRATION_SQL} must exist`);
  const sql = read(MIGRATION_SQL);
  assert.match(
    sql,
    /ALTER TABLE\s+"video_submissions"\s+ADD COLUMN\s+"whatsapp_message_id"\s+text/i,
    "migration must ALTER TABLE … ADD COLUMN whatsapp_message_id text",
  );
  assert.match(
    sql,
    /CREATE UNIQUE INDEX\s+"video_submissions_whatsapp_message_id_uq"\s+ON\s+"video_submissions"[\s\S]+?WHERE\s+"whatsapp_message_id"\s+IS\s+NOT\s+NULL/i,
    "migration must CREATE UNIQUE INDEX … WHERE whatsapp_message_id IS NOT NULL",
  );
});

test("spec 144: drizzle journal references 0017_whatsapp_dedup", () => {
  const journal = JSON.parse(read(JOURNAL_PATH));
  const entry = journal.entries.find((e) => e.tag === "0017_whatsapp_dedup");
  assert.ok(entry, "_journal.json must contain an entry tagged 0017_whatsapp_dedup");
  assert.equal(entry.idx, 17, "the 0017_whatsapp_dedup entry must have idx 17");
});

test("spec 144: 0017 snapshot lists the new column on public.video_submissions", () => {
  assert.ok(existsSync(resolve(root, SNAPSHOT_PATH)), `${SNAPSHOT_PATH} must exist`);
  const snap = JSON.parse(read(SNAPSHOT_PATH));
  const vs = snap.tables?.["public.video_submissions"];
  assert.ok(vs, "snapshot must contain public.video_submissions");
  assert.ok(vs.columns?.whatsapp_message_id, "snapshot must list whatsapp_message_id column");
  assert.equal(vs.columns.whatsapp_message_id.type, "text", "whatsapp_message_id must be text");
  // The partial unique index must be in the snapshot indexes block too.
  const idx = vs.indexes?.video_submissions_whatsapp_message_id_uq;
  assert.ok(idx, "snapshot must list video_submissions_whatsapp_message_id_uq");
  assert.equal(idx.isUnique, true, "the index must be unique");
  assert.match(
    String(idx.where ?? ""),
    /whatsapp_message_id.*IS\s+NOT\s+NULL/i,
    "the snapshot index must record the partial predicate",
  );
});

test("spec 144: webhook pre-checks WHERE whatsappMessageId = msg.id before queueing the media fetch", () => {
  const src = read(WEBHOOK_PATH);
  // The select must reference videoSubmissions.whatsappMessageId.
  assert.match(
    src,
    /\.select\s*\([^)]*\)\s*\.from\s*\(\s*videoSubmissions\s*\)[\s\S]{0,400}?\.where\s*\(\s*eq\s*\(\s*videoSubmissions\.whatsappMessageId\s*,\s*msg\.id\s*\)/,
    "webhook must SELECT FROM videoSubmissions WHERE whatsappMessageId = msg.id",
  );
  // F93: the Graph fetch moved out of the webhook into the worker
  // (apps/worker/src/whatsapp-fetch.ts), because running it after Meta's 200
  // made every failure permanent. The pre-check still has to come first, now
  // ahead of the fetch JOB, so a redelivery neither queues a second fetch nor
  // wastes Graph egress on one.
  const selectIdx = src.search(/\.from\s*\(\s*videoSubmissions\s*\)/);
  const fetchIdx = src.search(/\bawait\s+enqueue\s*\(/);
  assert.ok(selectIdx > -1, "webhook must perform a SELECT against videoSubmissions");
  assert.ok(fetchIdx > -1, "webhook must queue the media fetch");
  assert.ok(
    selectIdx < fetchIdx,
    "pre-check SELECT must run BEFORE the fetch is queued so retries don't fetch twice",
  );
  assert.ok(!/fetchMediaUrl\s*\(/.test(src), "the webhook must not fetch media itself; a failure after its 200 is final");
});

test("spec 144: webhook audits whatsapp.message.replay_ignored when the row already exists", () => {
  const src = read(WEBHOOK_PATH);
  assert.match(
    src,
    /action\s*:\s*["']whatsapp\.message\.replay_ignored["']/,
    "webhook must audit whatsapp.message.replay_ignored on duplicate detection",
  );
});

test("spec 144: webhook insert sets whatsappMessageId AND uses onConflictDoNothing", () => {
  const src = read(WEBHOOK_PATH);
  // Find the videoSubmissions insert and confirm the values block carries the new column.
  const insertBlock = src.match(
    /\.insert\s*\(\s*videoSubmissions\s*\)[\s\S]*?\.returning\s*\(/,
  );
  assert.ok(insertBlock, "webhook must contain a videoSubmissions insert with .returning()");
  assert.match(
    insertBlock[0],
    /whatsappMessageId\s*:\s*msg\.id/,
    "the insert must set whatsappMessageId: msg.id so the partial unique index engages",
  );
  assert.match(
    insertBlock[0],
    /\.onConflictDoNothing\s*\(\s*\{/,
    "the insert must use .onConflictDoNothing(...) so a race between concurrent Meta retries is safe",
  );
});

// ---------- Media range: INVERTED ----------
//
// Spec 144 taught the media proxy to forward a Range header to S3 and answer
// 206 with Content-Range, so a viewer could seek without re-downloading. That
// proxy no longer exists, and the capability it added is now provided by
// something better: segments are fetched by the browser DIRECTLY from Supabase
// Storage via individually-signed URLs, and Storage answers Range natively over
// its CDN.
//
// The old arrangement streamed every byte of every video through the
// application server. For a 20-minute lesson that is ~200 requests and hundreds
// of megabytes per viewer proxied by the box that also has to render pages. It
// was the single largest input to how big the EC2 instance had to be.

test("spec 144: the application no longer proxies video bytes", () => {
  assert.ok(
    !existsSync(resolve(root, "apps/web/src/app/api/media/[token]/route.ts")),
    "the byte-proxying media route must not exist",
  );
  const playlist = readFileSync(
    resolve(root, "apps/web/src/app/api/media/playlist/[id]/route.ts"),
    "utf8",
  );
  assert.ok(
    !/Range|Content-Range|206/.test(playlist),
    "the playlist route returns a small text document and must not grow range " +
      "handling -- ranged reads belong to Storage, which serves them from a CDN",
  );
});

test("spec 144: segment URLs are signed per object, not per request", () => {
  const storage = readFileSync(resolve(root, "apps/web/src/lib/video/storage.ts"), "utf8");
  assert.match(
    storage,
    /signMany\(bucket, keys, ttl\)/,
    "the playlist builder must batch-sign, so rewriting a 200-segment playlist " +
      "is one round trip rather than 200",
  );
  assert.match(
    storage,
    /extractSegments\(playlistText\)/,
    "it must sign the names the playlist actually references. Supabase refuses " +
      "to sign a key with no object behind it, so a computed range would " +
      "silently drop any segment whose numbering was guessed wrong",
  );
});

test("spec 144: all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist`,
    );
  }
});

test("spec 144: plan.md follows the three-line CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/);
  assert.match(src, /EDITED:/);
  assert.match(src, /MIGRATED:/);
});
