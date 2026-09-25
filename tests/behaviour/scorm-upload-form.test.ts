// The SCORM upload form on /admin/scorm -- rendered for real, and its submit
// logic executed against a stand-in fetch.
//
//   - A super_admin gets the form: subject, .zip, optional title.
//   - A programme_admin gets the list and an explanation, not a form that
//     would only ever answer 403 (ingest.ts says why uploads are theirs).
//   - Submitting: a file over the limit is refused before a byte is sent (on
//     a slow link that is minutes saved); a refusal shows the server's reason
//     and the files it names; a network failure says so; success opens the
//     new package's page.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { render, withAppRouter, openingTags, attr, elements } from "./_ui.js";
import { signIn, closeAppDb } from "./_server-actions.js";
import { needsDatabase } from "./_harness.js";
import { rttWorld } from "./_rtt-world.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

test("a super_admin gets the upload form; a programme_admin gets an explanation instead", { skip }, async () => {
  const w = await rttWorld("scuf");
  try {
    const subjectId = await w.subject({ name: `Maths ${w.T}` });
    const { default: ScormAdminPage } = await import("../../apps/web/src/app/(authenticated)/admin/scorm/page.tsx");
    const superAdmin = await w.user("Root", "super_admin");

    signIn(superAdmin);
    let html = await render(withAppRouter(await ScormAdminPage()));
    const file = openingTags(html, "input").find((t) => attr(t, "type") === "file");
    assert.ok(file, "a file input");
    assert.equal(attr(file!, "name"), "file");
    assert.match(attr(file!, "accept") ?? "", /\.zip/);
    assert.ok(/\srequired(=|\s|>|\/)/.test(file!), "a file is required");
    const select = openingTags(html, "select").find((t) => attr(t, "name") === "rttSubjectId");
    assert.ok(select, "a subject picker");
    const option = elements(html, "option").find((o) => attr(o.open, "value") === subjectId);
    assert.ok(option, "the subject is offered");
    assert.match(option!.text, new RegExp(`Maths ${w.T}`));
    assert.ok(openingTags(html, "input").some((t) => attr(t, "name") === "title"), "an optional title");
    assert.match(html, /20 MB/, "the limit is stated before a slow upload starts");

    signIn(w.admin);
    html = await render(withAppRouter(await ScormAdminPage()));
    assert.equal(openingTags(html, "input").some((t) => attr(t, "type") === "file"), false, "no form that would only answer 403");
    assert.match(html, /Only a super_admin can upload/);
  } finally {
    signIn(null);
    await w.cleanup();
  }
});

test("submitting: an oversized file is refused before sending; refusals and failures are explained; success opens the package", async () => {
  const { sendScormUpload } = await import("../../apps/web/src/app/(authenticated)/admin/scorm/upload-form.tsx");
  const { SCORM_LIMITS } = await import("../../apps/web/src/lib/scorm/package.ts");
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchWith = (res: () => Promise<Response>) => (url: string, init: RequestInit) => (calls.push({ url, init }), res());
  const form = (bytes: number) => {
    const fd = new FormData();
    fd.set("file", new File([new Uint8Array(bytes)], "course.zip"));
    fd.set("rttSubjectId", "s");
    return fd;
  };

  const big = await sendScormUpload(form(SCORM_LIMITS.maxPackageBytes + 1), { maxBytes: SCORM_LIMITS.maxPackageBytes, fetch: fetchWith(async () => new Response("{}")) });
  assert.equal(big.ok, false);
  assert.match((big as { message: string }).message, /20 MB/);
  assert.equal(calls.length, 0, "nothing sent");

  const ok = await sendScormUpload(form(10), { maxBytes: SCORM_LIMITS.maxPackageBytes, fetch: fetchWith(async () => Response.json({ id: "p-9" }, { status: 201 })) });
  assert.deepEqual(ok, { ok: true, id: "p-9" });
  assert.equal(calls[0]!.url, "/api/scorm/packages");
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal(calls[0]!.init.credentials, "same-origin");

  const refused = await sendScormUpload(form(10), {
    maxBytes: SCORM_LIMITS.maxPackageBytes,
    fetch: fetchWith(async () => Response.json({ error: { code: "unsafe_path", message: "Names point outside.", paths: ["../x.html"] } }, { status: 422 })),
  });
  assert.deepEqual(refused, { ok: false, message: "Names point outside.", paths: ["../x.html"] });

  const forbidden = await sendScormUpload(form(10), { maxBytes: SCORM_LIMITS.maxPackageBytes, fetch: fetchWith(async () => Response.json({ error: "forbidden" }, { status: 403 })) });
  assert.match((forbidden as { message: string }).message, /403/);

  const offline = await sendScormUpload(form(10), { maxBytes: SCORM_LIMITS.maxPackageBytes, fetch: fetchWith(() => Promise.reject(new TypeError("Failed to fetch"))) });
  assert.match((offline as { message: string }).message, /did not reach the server/);
});
