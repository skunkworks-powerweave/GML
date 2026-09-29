// Resources: the PDF is uploaded from the data table's form, into the bucket
// the PDF viewer reads -- no more pasting a Storage key.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// resources.file_key was a text box. An administrator had to put the file in
// Storage some other way (nothing in the product offered one) and paste its
// object name; a typo was a reading-material entry whose viewer 404'd.
//
// ── WHAT MUST HOLD ───────────────────────────────────────────────────────────
//
//   - POST /api/admin/data/resources/upload?field=fileKey stores a whole PDF
//     in the `pdfs` bucket and answers its key; the row is then saved by the
//     ordinary create, and /api/media/pdf/[id] serves exactly those bytes;
//   - only whoever may write resources may upload; only a field declared as
//     an upload takes one; anything that is not a whole PDF of at most 9 MiB
//     is refused and nothing is stored; a cross-site post is refused;
//   - a web link still works on its own;
//   - the form offers a file picker for the key, not a text box;
//   - the upload is audited as the taxonomy says.
//
// Executed: the real route handlers and server action against Postgres and
// an in-process Storage (./_storage.ts), and the real form component.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { stubSupabaseServer, request, h, renderSync, decodeEntities } from "./_ui.js";
import { closeAppDb, signIn } from "./_server-actions.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { fixture, form, type Fixture } from "./_admin-fixture.js";
import { startFakeStorage, type FakeStorage } from "./_storage.js";
import { loadMessages } from "../../apps/web/src/i18n/config.ts";

stubSupabaseServer();
const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { createClient } = webRequire("@supabase/supabase-js") as typeof import("@supabase/supabase-js");

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1");

const route = () => import("../../apps/web/src/app/api/admin/data/[entity]/upload/route.ts");

function upload(
  slug: string,
  field: string,
  file: Buffer | null,
  headers: Record<string, string> = {},
  name = "handbook.pdf",
): Promise<Response> {
  const fd = new FormData();
  if (file) fd.set("file", new Blob([file], { type: "application/pdf" }), name);
  return route().then(({ POST }) =>
    POST(
      new Request(`http://app.test/api/admin/data/${slug}/upload?field=${field}`, {
        method: "POST",
        body: fd,
        headers: { host: "app.test", ...headers },
      }),
      { params: Promise.resolve({ entity: slug }) },
    ),
  );
}

type Ctx = { f: Fixture; storage: FakeStorage; padmin: string; teacher: string; t: string };

async function withUpload(body: (x: Ctx) => Promise<void>) {
  await withClient(async (c) => {
    const t = tag("ap-pdf");
    const f = fixture(c, t);
    const storage = await startFakeStorage();
    try {
      request.supabaseAdmin = createClient(storage.url, "service-role-test-key", {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const padmin = await f.user("programme_admin", "pa");
      const teacher = await f.user("teacher", "t");
      f.defer(`DELETE FROM resources WHERE name LIKE $1`, [`%${t}%`]);
      await body({ f, storage, padmin, teacher, t });
    } finally {
      signIn(null);
      request.supabaseAdmin = undefined;
      await storage.close();
      await f.cleanup();
    }
  });
}

/** The taxonomy's row for `action`: its metadata keys, and the text naming its entity type. */
function docRow(action: string): { keys: Set<string>; line: string } {
  const doc = readFileSync(new URL("../../docs/audit-actions.md", import.meta.url), "utf8");
  const line = doc.split("\n").find((l) => l.startsWith(`| \`${action}\` |`));
  assert.ok(line, `${action} is not in docs/audit-actions.md`);
  const cells = line.split("|").slice(1, -1).map((s) => s.trim());
  assert.equal(cells.length, 3);
  return { keys: new Set([...cells[2]!.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)].map((m) => m[1]!)), line };
}

test("an administrator uploads a PDF, saves the resource, and the viewer serves those bytes", { skip }, async () => {
  const { createRowAction } = await import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/actions.ts");
  const media = await import("../../apps/web/src/app/api/media/pdf/[id]/route.ts");
  await withUpload(async ({ f, storage, padmin, teacher, t }) => {
    signIn({ id: padmin, role: "programme_admin" });
    const res = await upload("resources", "fileKey", PDF);
    assert.equal(res.status, 201, await res.clone().text());
    const { fileKey, bytes } = (await res.json()) as { fileKey: string; bytes: number };
    assert.match(fileKey, /^resources\/[0-9a-f-]{36}\.pdf$/, "a new key of its own, not the file's name");
    assert.equal(bytes, PDF.byteLength);
    const stored = storage.get("pdfs", fileKey);
    assert.ok(stored, "stored in the bucket /api/media/pdf reads");
    assert.deepEqual(stored.body, PDF);
    assert.equal(stored.contentType, "application/pdf");

    // Audited as the taxonomy says.
    let row: { entity_type: string; metadata: Record<string, unknown> } | undefined;
    for (let i = 0; i < 40 && !row; i++) {
      row = (
        await f.c.query(`SELECT entity_type, metadata FROM audit_log WHERE user_id = $1 AND action = 'resource.pdf.uploaded'`, [padmin])
      ).rows[0];
      if (!row) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(row, "resource.pdf.uploaded");
    const doc = docRow("resource.pdf.uploaded");
    assert.deepEqual(Object.keys(row.metadata).sort(), [...doc.keys].sort());
    assert.equal(row.metadata.fileKey, fileKey);
    assert.ok(doc.line.includes(`\`${row.entity_type}\``));

    // The form posts the key; the ordinary create saves the row.
    const made = (await createRowAction(
      undefined,
      form({ entitySlug: "resources", name: `Handbook ${t}`, kind: "Handbook", fileKey, active: "true" }),
    )) as { ok?: boolean };
    assert.equal(made.ok, true, JSON.stringify(made));
    const id = (await f.c.query(`SELECT id, file_key FROM resources WHERE name = $1`, [`Handbook ${t}`])).rows[0];
    assert.equal(id.file_key, fileKey);

    // Any signed-in reader opens it through the viewer's own route.
    signIn({ id: teacher, role: "teacher" });
    const served = await media.GET(new Request(`http://app.test/api/media/pdf/${id.id}`), { params: Promise.resolve({ id: id.id }) });
    assert.equal(served.status, 200);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), PDF);

    // A web link on its own still makes a resource.
    signIn({ id: padmin, role: "programme_admin" });
    const link = (await createRowAction(
      undefined,
      form({ entitySlug: "resources", name: `Link ${t}`, kind: "Guide", externalUrl: "https://ncert.nic.in/guide.pdf", active: "true" }),
    )) as { ok?: boolean };
    assert.equal(link.ok, true, JSON.stringify(link));
  });
});

test("only a writer of resources uploads, only into an upload field, only a whole PDF", { skip }, async () => {
  await withUpload(async ({ f, storage, padmin, teacher }) => {
    const none = () => storage.keys("pdfs").length;

    signIn({ id: teacher, role: "teacher" });
    assert.equal((await upload("resources", "fileKey", PDF)).status, 403, "a teacher cannot put files in the bucket");
    signIn({ id: await f.user("mentor", "m"), role: "mentor" });
    assert.equal((await upload("resources", "fileKey", PDF)).status, 403);
    signIn(null);
    assert.equal((await upload("resources", "fileKey", PDF)).status, 401);

    signIn({ id: padmin, role: "programme_admin" });
    assert.equal((await upload("schools", "name", PDF)).status, 404, "a table with no upload field takes none");
    assert.equal((await upload("resources", "name", PDF)).status, 404, "nor does a field that is not one");
    assert.equal((await upload("no-such-table", "fileKey", PDF)).status, 403);

    const html = await upload("resources", "fileKey", Buffer.from("<!doctype html><script>alert(1)</script>"), {}, "x.pdf");
    assert.equal(html.status, 422);
    assert.equal(((await html.json()) as { error: string }).error, "not_pdf", "an HTML file named .pdf is not a PDF");
    const cut = await upload("resources", "fileKey", PDF.subarray(0, PDF.byteLength - 8));
    assert.equal(cut.status, 422);
    assert.equal(((await cut.json()) as { error: string }).error, "truncated", "a body cut short is refused, not stored");
    assert.equal((await upload("resources", "fileKey", Buffer.alloc(0))).status, 400);
    assert.equal((await upload("resources", "fileKey", null)).status, 400);
    const declared = await upload("resources", "fileKey", PDF, { "content-length": String(20 * 1024 * 1024) });
    assert.equal(declared.status, 413, "refused from the declared length");
    const big = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(9 * 1024 * 1024 + 10, 0x20), Buffer.from("\n%%EOF\n")]);
    assert.equal((await upload("resources", "fileKey", big)).status, 413, "and from the bytes");
    assert.equal((await upload("resources", "fileKey", PDF, { origin: "https://evil.example" })).status, 403, "cross-site");
    assert.equal(none(), 0, "nothing refused was stored");

    // Storage down: said so, nothing claimed.
    request.supabaseAdmin = createClient("http://127.0.0.1:9", "service-role-test-key", {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const down = await upload("resources", "fileKey", PDF);
    assert.equal(down.status, 502);
    assert.equal(((await down.json()) as { error: string }).error, "storage");
  });
});

test("the resource form offers a PDF picker for the key, in the user's language (hi)", async () => {
  const { RowForm } = await import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/row-form.tsx");
  const { rowFormText } = await import("../../apps/web/src/admin/labels.ts");
  const { getTranslations } = await import("next-intl/server");
  const { ADMIN_ENTITIES } = await import("../../apps/web/src/admin/registry.ts");
  request.locale = "hi";
  try {
    const text = rowFormText((await getTranslations("adminData")) as never, ADMIN_ENTITIES.resources!);
    const html = renderSync(
      h(RowForm as never, { entitySlug: "resources", mode: "edit", rowId: "r1", initialValues: { fileKey: "resources/old.pdf" }, options: {}, text } as never),
    );
    assert.match(html, /<input[^>]*type="file"[^>]*accept="application\/pdf,\.pdf"/);
    assert.match(html, /<input[^>]*type="hidden"[^>]*name="fileKey"[^>]*value="resources\/old\.pdf"/);
    assert.doesNotMatch(html, /<input[^>]*type="text"[^>]*name="fileKey"|<input[^>]*name="fileKey"[^>]*type="text"/, "no box to paste a key into");
    const hi = loadMessages("hi") as { adminData: { client: { pdfUpload: Record<string, string> }; entities: { resources: { fields: Record<string, string> } } } };
    const shown = decodeEntities(html);
    assert.ok(shown.includes(hi.adminData.client.pdfUpload.current!), "the stored-file notice is in Hindi");
    assert.ok(shown.includes(hi.adminData.client.pdfUpload.choose!), "the picker's label is in Hindi");
    assert.ok(shown.includes(hi.adminData.entities.resources.fields.fileKey!));
  } finally {
    request.locale = "en";
  }
});
