// WhatsApp captions, executed: what a teacher actually types, and what the
// app tells her to type, both driven through the real webhook.
//
// ── THE DEFECT (F129) ────────────────────────────────────────────────────────
//
// A video is linked to its observation cycle only when the webhook recognises
// the cycle code in its caption. The parser was /^(OBS|TB|MM)-.../ -- anchored
// at the start, case-sensitive, with the separator required -- so a phone
// keyboard's auto-capitalised "Obs-2026-009", a leading "#", a trailing full
// stop or "Lesson video OBS-2026-009" all fell through to 'generic', which only
// admins can see: the cycle's observer and mentor never got the video.
//
// And the app taught formats the parser never accepted: the help panel said to
// caption "#c2026-XXX", and both WhatsApp buttons on /uploads pre-filled
// "#cycle-". A teacher who followed the instructions exactly lost the link.
//
// Every assertion here goes through POST, so "the caption links" means the
// submission row really carries the cycle's id.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { randomUUID } from "node:crypto";
import { needsDatabase, DATABASE_URL } from "./_harness.js";
import { render, request, resetRequest, withAppRouter } from "./_ui.js";
import { envelope, route, SECRET, signed, videoMessage, withEnv, withWorld, type World } from "./_whatsapp.js";

const skip = needsDatabase();

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (/\/tests\/behaviour\/_stubs\/auth\.ts$/.test(resolved.url.replace(/\\/g, "/"))) {
      return { url: new URL("./_stubs/auth-session.ts", import.meta.url).href, shortCircuit: true };
    }
    return resolved;
  },
});

after(async () => {
  if (!DATABASE_URL) return;
  const { getPool } = await import("../../packages/db/src/client.ts");
  await getPool().end();
});

const CONFIGURED = { WHATSAPP_APP_SECRET: SECRET, WHATSAPP_ACCESS_TOKEN: undefined };

/** Send `caption` from the cycle's own teacher; return what it was linked to. */
async function linkOf(w: World, caption: string): Promise<{ contextType: string; contextId: string | null }> {
  const { POST } = await route();
  const id = w.wamid();
  const res = await POST(signed(envelope([videoMessage({ id, from: w.teacher.phone, caption })])));
  assert.equal(res.status, 200);
  const sub = await w.submission(id);
  assert.ok(sub, `no submission for caption ${JSON.stringify(caption)}`);
  return { contextType: String(sub.context_type), contextId: (sub.context_id as string | null) ?? null };
}

test("F129: the ways a teacher really writes the cycle code all link the video to the cycle", { skip }, async () => {
  await withEnv(CONFIGURED, () =>
    withWorld(async (w) => {
      const code = w.cycleCode; // e.g. OBS-9123-456
      const rest = code.slice("OBS-".length);
      const captions = [
        code, // the canonical form
        `#${code}`, // a hashtag, as the old help text taught
        code.toLowerCase(),
        `Obs-${rest}`, // what a phone keyboard's auto-capitalise produces
        `OBS ${rest}`, // a space for the dash
        `${code}.`, // a sentence
        `Lesson video ${code}`, // the code not first
        `#cycle- ${code}`, // the old "Open WhatsApp" pre-fill, code typed after it
        `${code} — fractions, grade 5`,
      ];
      const misses: string[] = [];
      for (const caption of captions) {
        const got = await linkOf(w, caption);
        if (got.contextType !== "observation_cycle" || got.contextId !== w.cycleId) {
          misses.push(`${JSON.stringify(caption)} -> ${got.contextType}`);
        }
      }
      assert.deepEqual(misses, [], "each of these names the cycle unambiguously and must reach its observer and mentor");

      // Still conservative: a word that merely contains the letters is not a code.
      assert.equal((await linkOf(w, `Jobs-${rest} observation notes`)).contextType, "generic");
    }),
  );
});

test("F129: the parser reads TB- and MM- ids the same tolerant way, and ignores look-alike words", async () => {
  // Pure: no database, so this runs everywhere.
  const { parseCaption } = await import("../../packages/shared/src/whatsapp/caption.ts");
  const id = "3f2c1a9e-8b7d-4c6e-9a1b-2c3d4e5f6a7b";
  assert.deepEqual(parseCaption(`tb-${id}`), { type: "teach_back", code: id, fullCode: `TB-${id}` });
  assert.deepEqual(parseCaption(`Meeting recording MM ${id}.`), { type: "mentor_meeting", code: id, fullCode: `MM-${id}` });
  assert.deepEqual(parseCaption("OBS: 2026-009"), { type: "observation_cycle", code: "2026-009", fullCode: "OBS-2026-009" });
  for (const miss of ["", "Observation of the fractions lesson", "COMMIT-2026", "jobs-2026-009", "#cycle-", "OBS-"]) {
    assert.equal(parseCaption(miss).type, "generic", JSON.stringify(miss));
  }
});

// ── The guidance, checked against the parser ────────────────────────────────

function signIn(): void {
  const id = randomUUID();
  (globalThis as Record<string, unknown>).__gmlTestSession = {
    user: { id, email: `${id}@example.test`, name: "Teacher", image: null, role: "teacher" },
  };
}

/** The `text=` a wa.me link pre-fills, from rendered HTML. */
function prefills(html: string): Array<{ href: string; text: string }> {
  return [...html.matchAll(/href="(https:\/\/wa\.me\/[^"]+)"/g)].map((m) => {
    const href = m[1]!.replace(/&amp;/g, "&");
    return { href, text: new URL(href).searchParams.get("text") ?? "" };
  });
}

async function renderUploads(ua: string): Promise<string> {
  resetRequest();
  request.headers = { "user-agent": ua };
  signIn();
  const { default: UploadsPage } = await import("../../apps/web/src/app/(authenticated)/uploads/page.tsx");
  return render(withAppRouter(await UploadsPage()));
}

test("F129: the help panel's caption example is a code the webhook links", { skip }, async () => {
  const { HELP } = await import("../../apps/web/src/lib/help.ts");
  const text = HELP.whatsapp_ingest!.long;
  assert.doesNotMatch(text, /#c\d{4}/, "'#c2026-XXX' has never been a caption the webhook understands");
  const example = text.match(/OBS-\d{4}-\d{3}/)?.[0];
  assert.ok(example, `the help must show the cycle code in the form cycles carry (OBS-<year>-<NNN>): ${text}`);
  // And the cycle help must describe the same code.
  assert.match(HELP.cycle!.long, /OBS-\d{4}-\d{3}/);
  await withEnv(CONFIGURED, () =>
    withWorld(async (w) => {
      // The teacher sends her own code in the form the help shows.
      assert.match(w.cycleCode, /^OBS-\d{4}-\d{3}$/);
      const got = await linkOf(w, w.cycleCode);
      assert.equal(got.contextId, w.cycleId);
    }),
  );
});

test("F129: both 'Open WhatsApp' buttons pre-fill a caption the webhook links once the code is typed", { skip }, async () => {
  await withEnv({ ...CONFIGURED, GML_WHATSAPP_NUMBER: "+919999999999" }, async () => {
    const desktop = await renderUploads("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120");
    const mobile = await renderUploads("Mozilla/5.0 (Linux; Android 12) Mobile Chrome/120");
    resetRequest();
    const links = [...prefills(desktop), ...prefills(mobile)];
    assert.equal(links.length, 2, "one WhatsApp button per layout");
    for (const l of links) {
      assert.match(l.href, /^https:\/\/wa\.me\/\d+\?/, `wa.me takes digits only, no '+': ${l.href}`);
    }
    assert.match(desktop, /OBS-\d{4}-\d{3}/, "the desktop card must show the caption format, not only 'your active cycle ID'");

    await withWorld(async (w) => {
      const typed = w.cycleCode.slice("OBS-".length); // what she types after the pre-fill
      for (const l of links) {
        const got = await linkOf(w, `${l.text}${typed}`);
        assert.equal(got.contextId, w.cycleId, `pre-fill ${JSON.stringify(l.text)} + ${typed} must reach the cycle`);
      }
    });
  });
});
