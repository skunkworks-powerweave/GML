// The video pages speak the reader's language -- executed.
//
// ── THE DEFECT (UAT, 2026-09-27) ─────────────────────────────────────────────
//
// A user who picked Hindi or Bhoti got a translated menu over English video
// pages: the library, the player page and its controls, /uploads, the upload
// dialog, the phone upload flow and every message an upload or playback
// failure showed -- all written into the components in English, and the
// stored status, context and source printed as they are stored ("teach back",
// "via direct").
//
// What is rendered here is the real page or component, with next-intl's real
// translator over the app's own bundles (tests/behaviour/_ui.ts), in Hindi and
// in Bhoti. Each check pairs a string from the video namespace that must appear
// with its English original that must not. What people typed or uploaded --
// names, file names, captions -- stays as stored.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire, registerHooks } from "node:module";
import { Client } from "pg";
import { render, renderSync, request, mount, hostElements, textOf, decodeEntities, withAppRouter, h } from "./_ui.js";
import { signIn, outcome, closeAppDb } from "./_server-actions.js";
import { needsDatabase, DATABASE_URL, tag } from "./_harness.js";
import { uploadScript } from "./_stubs/upload-actions.ts";
import { loadMessages } from "../../apps/web/src/i18n/config.ts";

// The upload controls' two server actions and the tus transfer, replaced for
// those components only (as upload-confirm.test.ts does): a network round-trip
// the test scripts. The pages and actions below import the real ones.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    const url = resolved.url.replace(/\\/g, "/");
    const fromUploadUi = /\/components\/video\/(UploadProgress|MobileUploadRunner)\.tsx$/.test(
      (context.parentURL ?? "").replace(/\\/g, "/"),
    );
    if (fromUploadUi && /\/app\/\(authenticated\)\/uploads\/actions\.ts$/.test(decodeURIComponent(url))) {
      return { url: new URL("./_stubs/upload-actions.ts", import.meta.url).href, shortCircuit: true };
    }
    if (fromUploadUi && /\/lib\/video\/tus-upload\.ts$/.test(url)) {
      return { url: new URL("./_stubs/tus-upload.ts", import.meta.url).href, shortCircuit: true };
    }
    return resolved;
  },
});

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

/** Run `body` with the fake request in `locale`, back to English afterwards. */
async function inLocale<T>(locale: "hi" | "bo", body: () => Promise<T> | T): Promise<T> {
  request.locale = locale;
  try {
    return await body();
  } finally {
    request.locale = "en";
  }
}

/** The visible text of rendered markup, entities decoded, whitespace collapsed. */
const text = (html: string) =>
  decodeEntities(html.replace(/<!-- -->/g, "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");

/** Every `shown` string appears in `out`, and no `hidden` one does. */
function speaks(out: string, pairs: Array<[shown: string, hidden: string]>): void {
  for (const [shown, hidden] of pairs) {
    assert.ok(out.includes(shown), `"${shown}" is shown in: ${out.slice(0, 600)}`);
    assert.ok(!out.includes(hidden), `"${hidden}" is not`);
  }
}

// ── client components (no database) ──────────────────────────────────────────

test("the upload dialog on /videos is Hindi and Bhoti, and the caption codes stay as the webhook reads them", async () => {
  const { UploadModal } = await import("../../apps/web/src/components/video/UploadModal.tsx");
  const opened = (locale: "hi" | "bo") => {
    const m = mount(UploadModal as (p: unknown) => unknown, { whatsappPhone: "+919999999999", videoDefaultQuality: "480p" }, { intl: locale });
    const trigger = hostElements(m.tree).find((el) => el.props["data-testid"] === "upload-trigger")!;
    const label = textOf(trigger);
    (trigger.props.onClick as () => void)();
    const dialog = hostElements(m.rerender()).find((el) => el.props["data-testid"] === "upload-modal")!;
    return { label, dialog: textOf(dialog), aria: dialog.props["aria-label"] };
  };

  const hi = opened("hi");
  assert.equal(hi.label, "अपलोड");
  assert.equal(hi.aria, "वीडियो अपलोड करें");
  speaks(hi.dialog, [
    ["पाठ भेजने के दो तरीके", "Two ways to send a lesson"],
    ["WhatsApp से भेजें", "Send via WhatsApp"],
    ["फ़ोन नंबर कॉपी करें", "Copy phone number"],
    ["OBS-<कोड>", "OBS-<code>"],
    ["480p HLS", "transcodes to"],
  ]);

  const bo = opened("bo");
  assert.equal(bo.label, "འགྲེམས་སྤེལ།");
  speaks(bo.dialog, [
    ["སློབ་ཁྲིད་གཏོང་ཐབས་གཉིས།", "Two ways to send a lesson"],
    ["OBS-<ཨང་རྟགས་>", "attaches to an observation cycle"],
    ["MM-<ID>", "MM-<uuid>"],
  ]);
});

test("the player's controls, the upload tray and the phone upload flow are Hindi and Bhoti", async () => {
  const { HlsPlayer } = await import("../../apps/web/src/components/video/HlsPlayer.tsx");
  const { UploadProgress } = await import("../../apps/web/src/components/video/UploadProgress.tsx");
  const { MobileUploadRunner } = await import("../../apps/web/src/components/video/MobileUploadRunner.tsx");

  const player = await inLocale("hi", () => renderSync(h(HlsPlayer, { src: "/api/media/playlist/v1", watermark: "Asha · 2026-09-27 10:00 UTC" })));
  speaks(text(player), [
    ["गति", "Speed"],
    ["गुणवत्ता", "Quality"],
    ["स्वचालित", "Auto"],
    ["720p (उपलब्ध नहीं)", "not available"],
  ]);
  assert.ok(player.includes('aria-label="प्लेबैक की गति"'), "the speed group is named in Hindi");
  assert.ok(text(player).includes("Asha · 2026-09-27 10:00 UTC"), "the watermark is shown as given");

  const tray = await inLocale("bo", () => renderSync(withAppRouter(h(UploadProgress, { contextType: "generic" }))));
  speaks(text(tray), [
    ["བརྙན་ཕབ་འགྲེམས་སྤེལ།", "Upload video"],
    ["དྲ་རྒྱ་ཆད་ན་མུ་མཐུད་ཐུབ།", "resumable on network drop"],
  ]);

  const phone = await inLocale("hi", () => renderSync(withAppRouter(h(MobileUploadRunner, { whatsappPhone: "+919999999999" }))));
  speaks(text(phone), [
    ["पाठ का वीडियो जमा करें", "Submit a lesson video"],
    ["अभी रिकॉर्ड करें", "Record now"],
    ["गैलरी से चुनें", "Pick from gallery"],
    ["धीमा 2G/3G कनेक्शन है?", "On a slow 2G/3G link?"],
    ["WhatsApp खोलें", "Open WhatsApp"],
  ]);
  const phoneBo = await inLocale("bo", () => renderSync(withAppRouter(h(MobileUploadRunner, {}))));
  speaks(text(phoneBo), [
    ["སློབ་ཁྲིད་ཀྱི་བརྙན་ཕབ་ཕུལ།", "Submit a lesson video"],
    ["ད་ལྟ་བརྙན་ཕབ།", "Record now"],
  ]);
});

test("a failed phone upload says why in Bhoti, not in English and not with the browser's own error text", async () => {
  // Driven through the runner's own handlers (as upload-confirm.test.ts does):
  // a file is picked, Start is pressed, and the reservation call dies on the
  // network. extractFirstFrame builds a <video> for the thumbnail; there is no
  // DOM here, so it is handed one that fails to decode, which the runner handles.
  const g = globalThis as Record<string, unknown>;
  const hadDocument = "document" in g;
  const { createObjectURL, revokeObjectURL } = URL;
  g.document = {
    createElement: () => {
      const v: Record<string, unknown> = { removeAttribute: () => undefined, load: () => undefined };
      setImmediate(() => (v.onerror as (() => void) | undefined)?.());
      return v;
    },
  };
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => undefined;
  const ctx = (
    createRequire(new URL("../../apps/web/package.json", import.meta.url))(
      "next/dist/shared/lib/app-router-context.shared-runtime",
    ) as { AppRouterContext: { _currentValue: unknown } }
  ).AppRouterContext;
  const previous = ctx._currentValue;
  ctx._currentValue = (withAppRouter(null, []) as { props: { value: unknown } }).props.value;
  const drain = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  try {
    const u = uploadScript();
    u.calls = [];
    u.begin = () => Promise.reject(new TypeError("Failed to fetch"));
    const { MobileUploadRunner } = await import("../../apps/web/src/components/video/MobileUploadRunner.tsx");
    const m = mount(MobileUploadRunner as (p: unknown) => unknown, {}, { intl: "bo" });
    const els = () => hostElements(m.rerender());
    const input = els().find((el) => el.props["data-testid"] === "gallery-input")!;
    await (input.props.onChange as (e: unknown) => Promise<void>)({ target: { files: [{ name: "a.mp4", size: 10, type: "video/mp4" }], value: "x" } });
    await drain();
    const preview = textOf(els().find((el) => el.props["data-testid"] === "mobile-upload-runner") ?? null);
    speaks(preview, [
      ["ལེགས་པོ་འདུག་གམ།", "Looks good?"],
      ["འགྲེམས་སྤེལ་འགོ་འཛུགས།", "Start upload"],
      ["ཕྱིར་ལོག", "Back"],
    ]);
    await (els().find((el) => el.props["data-testid"] === "start-upload")!.props.onClick as () => Promise<void>)();
    await drain();
    const screen = textOf(els().find((el) => el.props["data-testid"] === "mobile-upload-runner") ?? null);
    assert.deepEqual(u.calls, ["begin"]);
    speaks(screen, [
      ["འགྲེམས་སྤེལ་མ་ཐུབ།", "Upload failed"],
      ["ཞབས་ཞུའི་འཕྲུལ་ཆས་དང་འབྲེལ་མ་ཐུབ།", "Could not reach the server"],
      ["ཡང་བསྐྱར་ཚོད་ལྟ།", "Retry"],
    ]);
    assert.doesNotMatch(screen, /Failed to fetch/);
    m.unmount();
  } finally {
    ctx._currentValue = previous;
    if (!hadDocument) delete g.document;
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  }
});

// ── pages and server actions (database) ──────────────────────────────────────

test("the player page and the library are Hindi and Bhoti; the stored status, context and source show as labels", { skip }, async () => {
  const c = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
  await c.connect();
  const T = tag("i18nvid");
  const userId = (
    await c.query(`INSERT INTO users (id, email, name, role) VALUES (gen_random_uuid(), $1, $2, 'teacher') RETURNING id`, [`${T}@example.test`, `Teacher ${T}`])
  ).rows[0].id as string;
  const fileId = (
    await c.query(
      `INSERT INTO files (bucket, object_key, mime_type, kind, status, owner_user_id) VALUES ('videos-original', $1, 'video/mp4', 'video_original', 'stored', $2) RETURNING id`,
      [`test/${T}.mp4`, userId],
    )
  ).rows[0].id as string;
  const videoId = (
    await c.query(
      `INSERT INTO video_submissions (file_id, source, status, context_type, submitted_by_user_id, hls_master_key, duration_sec, verified_at)
       VALUES ($1, 'direct', 'ready', 'teach_back', $2, 'hls/test/index.m3u8', 125, now()) RETURNING id`,
      [fileId, userId],
    )
  ).rows[0].id as string;
  try {
    signIn({ id: userId, role: "teacher", name: `Teacher ${T}` });
    const { default: VideoPlayerPage } = await import("../../apps/web/src/app/(authenticated)/videos/[id]/page.tsx");
    const { default: VideoLibraryPage } = await import("../../apps/web/src/app/(authenticated)/videos/page.tsx");
    const playerPage = (locale: "hi" | "bo") =>
      inLocale(locale, async () => text(await render(withAppRouter(await VideoPlayerPage({ params: Promise.resolve({ id: videoId }) })))));
    const libraryPage = (locale: "hi" | "bo") =>
      inLocale(locale, async () => text(await render(withAppRouter(await VideoLibraryPage({ searchParams: Promise.resolve({}) })))));

    const hi = await playerPage("hi");
    speaks(hi, [
      ["टीच-बैक वीडियो", "Teach-back video"],
      ["← लाइब्रेरी", "← Library"],
      ["टीच-बैक · सीधा अपलोड से", "via direct"],
      ["प्लेयर", "Player"],
      ["प्लेबैक लिंक कुछ ही घंटों में समाप्त हो जाते हैं", "Playback links expire"],
      ["अवधि", "Duration"],
      ["2 मि॰ 05 से॰", "2m 05s"],
      ["तैयार", "ready"],
      ["गति", "Speed"],
    ]);
    assert.ok(hi.includes(`Teacher ${T}`), "the viewer's own name stays as stored");

    const bo = await playerPage("bo");
    speaks(bo, [
      ["ཕྱིར་སློབ་ཀྱི་བརྙན་ཕབ།", "Teach-back video"],
      ["ཕྱིར་སློབ། · ཐད་ཀར་འགྲེམས་སྤེལ། བརྒྱུད།", "via direct"],
      ["གཏོང་ཆས།", "Player"],
      ["ཞིབ་ཕྲ།", "Metadata"],
      ["མྱུར་ཚད།", "Speed"],
    ]);

    const libHi = await libraryPage("hi");
    speaks(libHi, [
      ["जमा किए गए वीडियो और पाठ की रिकॉर्डिंग", "Submissions & lesson recordings"],
      ["समीक्षा के लिए तैयार", "Ready to review"],
      ["सभी स्रोत", "All sources"],
      ["लागू करें", "Apply"],
      ["▶ चलाने के लिए क्लिक करें", "click to play"],
      ["सीधा अपलोड से · 2 मिनट", "via direct"],
      ["अपलोड", "Upload"],
    ]);
    assert.match(libHi, /\d+ में से \d+–\d+ दिखाए जा रहे हैं/);
    assert.doesNotMatch(libHi, /Showing \d/);

    const libBo = await libraryPage("bo");
    speaks(libBo, [
      ["ཕུལ་བའི་བརྙན་ཕབ་དང་སློབ་ཁྲིད་ཀྱི་ཕབ་ཟིན་པའི་བརྙན།", "Submissions & lesson recordings"],
      [(loadMessages("bo").video as { library: { filter: { ready: string } } }).library.filter.ready, "Ready to review"],
      ["ཕྱིར་སློབ།", "teach back"],
      ["འབྱུང་ཁུངས་ཚང་མ།", "All sources"],
    ]);
  } finally {
    signIn(null);
    await c.query(`DELETE FROM video_submissions WHERE id = $1`, [videoId]);
    await c.query(`DELETE FROM files WHERE id = $1`, [fileId]);
    await c.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await c.end();
  }
});

test("/uploads, and what the upload actions answer, are Hindi and Bhoti", { skip }, async () => {
  const c = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
  await c.connect();
  const T = tag("i18nupl");
  const adminId = (
    await c.query(`INSERT INTO users (id, email, name, role) VALUES (gen_random_uuid(), $1, $2, 'programme_admin') RETURNING id`, [`${T}@example.test`, `Admin ${T}`])
  ).rows[0].id as string;
  const fileId = (
    await c.query(
      `INSERT INTO files (bucket, object_key, mime_type, kind, status, owner_user_id, original_filename) VALUES ('videos-original', $1, 'video/mp4', 'video_original', 'failed', $2, $3) RETURNING id`,
      [`test/${T}.mp4`, adminId, `${T}-lesson.mp4`],
    )
  ).rows[0].id as string;
  const videoId = (
    await c.query(
      `INSERT INTO video_submissions (file_id, source, status, context_type, submitted_by_user_id) VALUES ($1, 'direct', 'failed', 'generic', $2) RETURNING id`,
      [fileId, adminId],
    )
  ).rows[0].id as string;
  try {
    signIn({ id: adminId, role: "programme_admin", name: `Admin ${T}` });
    request.headers = {};
    const { default: UploadsPage } = await import("../../apps/web/src/app/(authenticated)/uploads/page.tsx");
    const page = (locale: "hi" | "bo") =>
      inLocale(locale, async () => {
        const r = await outcome(async () => render(withAppRouter(await UploadsPage({ searchParams: Promise.resolve({}) }))));
        assert.equal(r.kind, "returned", JSON.stringify(r));
        return text(String((r as { value: unknown }).value));
      });

    const hi = await page("hi");
    speaks(hi, [
      ["पाठ का वीडियो जमा करें", "Submit a lesson video"],
      ["यह वीडियो इसके लिए है", "This video is for"],
      ["किसी अवलोकन चक्र, बैठक या जोड़ी से नहीं जुड़ा", "Not linked to a cycle, meeting or pairing"],
      ["यहाँ अपलोड करें", "Upload here"],
      ["वीडियो अपलोड करें", "Upload video"],
      ["मेरे हाल के अपलोड", "My recent uploads"],
      ["1 वीडियो · सबसे नए पहले", "most recent first"],
      ["किससे जुड़ा", "Linked to"],
      ["वेब", "Web"],
      ["किसी से नहीं जुड़ा (केवल आप और एडमिन)", "Not linked (only you and admins)"],
      ["विफल", "failed"],
    ]);
    assert.ok(hi.includes(`${T}-lesson.mp4`), "the file's name is shown as stored");
    assert.equal(hi.split("मेरे अपलोड").length - 1, 1, "the label is Hindi once, not Hindi beside its own Hindi name");

    const bo = await page("bo");
    speaks(bo, [
      ["སློབ་ཁྲིད་ཀྱི་བརྙན་ཕབ་ཕུལ།", "Submit a lesson video"],
      ["ངའི་ཉེ་ཆར་གྱི་འགྲེམས་སྤེལ།", "My recent uploads"],
      ["བརྙན་ཕབ་ 1 · གསར་ཤོས་སྔོན་ལ།", "most recent first"],
      ["མ་ཐུབ།", "failed"],
    ]);
    assert.ok(!bo.includes("मेरे अपलोड"), "no Hindi on a Bhoti page");

    // What the upload actions answer goes straight onto the upload screen.
    const { completeUploadAction } = await import("../../apps/web/src/app/(authenticated)/uploads/actions.ts");
    const missing = await inLocale("hi", () => completeUploadAction(randomUUID()));
    assert.deepEqual(missing, { ok: false, error: "वह अपलोड नहीं मिला।" });
    const { assertContextAllowed } = await import("../../apps/web/src/app/(authenticated)/uploads/context.ts");
    const unknown = await inLocale("bo", () => assertContextAllowed({ id: adminId, role: "programme_admin" } as never, { contextType: "nope" }));
    assert.deepEqual(unknown, { ok: false, error: "འགྲེམས་སྤེལ་གྱི་འབྲེལ་ཡུལ་ངོས་མ་ཟིན།" });
    const { beginUpload } = await import("../../apps/web/src/lib/video/upload.ts");
    const empty = await inLocale("hi", () =>
      beginUpload({ userId: adminId, filename: "a.mp4", sizeBytes: 0, contentType: "video/mp4", contextType: "generic" }),
    );
    assert.deepEqual(empty, { error: "यह फ़ाइल खाली लगती है।" });
  } finally {
    signIn(null);
    await c.query(`DELETE FROM video_submissions WHERE id = $1`, [videoId]);
    await c.query(`DELETE FROM files WHERE id = $1`, [fileId]);
    await c.query(`DELETE FROM users WHERE id = $1`, [adminId]);
    await c.end();
  }
});
