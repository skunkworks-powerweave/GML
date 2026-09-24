// Governance test for spec 149 — Mobile runners async / race fixes
// (Workflow Run 13 audit-closure, HIGH severity).
//
// Two files under audit:
//
//   1. apps/web/src/components/forms/MobileFormRunner.tsx (EDITED)
//      — onSubmitClick switches from sync `void flushSave()` to
//        async `await flushSave()` to mirror the desktop
//        FormRenderer.tsx::onSubmitForm closure (spec 072 line 534).
//
//   2. apps/web/src/components/video/MobileUploadRunner.tsx (EDITED)
//      — adds mountedRef + redirectTimerRef closure-discipline guards;
//        the three tus callbacks (onError / onProgress / onSuccess)
//        short-circuit on unmount; onSuccess wraps router.push in a
//        try/catch and stores the 1200 ms timer handle so unmount
//        can cancel it; unmount cleanup flips the mount flag, clears
//        the timer, sets the "Upload cancelled — try again" error
//        message, then aborts the tus instance.
//
// Plus the five spec-kit files under specs/149-mobile-runners-async-fixes/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const FORM_PATH = "apps/web/src/components/forms/MobileFormRunner.tsx";
const UPLOAD_PATH = "apps/web/src/components/video/MobileUploadRunner.tsx";
const SPEC_DIR = "specs/149-mobile-runners-async-fixes";

// ---------- Spec-kit + plan.md contract ----------

test("spec 149 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the mobile-runners-async-fixes spec`,
    );
  }
});

test("spec 149 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  assert.match(
    src,
    /MobileFormRunner\.tsx/,
    "plan.md must call out the MobileFormRunner edit",
  );
  assert.match(
    src,
    /MobileUploadRunner\.tsx/,
    "plan.md must call out the MobileUploadRunner edit",
  );
});

// ---------- MobileFormRunner — flushSave / requestSubmit race ----------

test("spec 149 — MobileFormRunner.onSubmitClick is async and awaits flushSave", () => {
  const src = read(FORM_PATH);
  // The handler must be declared async — otherwise the await below is a
  // syntax error and the file wouldn't compile, but pinning the declaration
  // shape also catches a sloppy refactor that drops the keyword.
  assert.match(
    src,
    /const\s+onSubmitClick\s*=\s*useCallback\(\s*async\s*\(\s*\)\s*=>/,
    "MobileFormRunner.onSubmitClick must be declared as `async () =>` inside useCallback",
  );
  // The literal `await flushSave()` MUST appear inside the body — this is
  // the contract that closes the autosave/submit race documented in spec
  // 149 and in FormRenderer.tsx::onSubmitForm.
  assert.match(
    src,
    /await\s+flushSave\(\)/,
    "MobileFormRunner.onSubmitClick must await flushSave() before requestSubmit",
  );
  // The await must be followed by a requestSubmit call — order matters: the
  // draft row must land on the server BEFORE the FormData is posted.
  assert.match(
    src,
    /await\s+flushSave\(\)[\s\S]{0,300}formRef\.current\?\.requestSubmit\(\)/,
    "MobileFormRunner must call formRef.current?.requestSubmit() AFTER awaiting flushSave",
  );
});

test("spec 149 — MobileFormRunner no longer fire-and-forgets flushSave with void at the submit call site", () => {
  const src = read(FORM_PATH);
  // The pre-fix shape was `void flushSave()` — a fire-and-forget that raced
  // the form post. We pin its ABSENCE at the call site (lines following
  // setSubmitting) so a future contributor can't silently revert the fix.
  // Note: the literal "void flushSave()" CAN appear in a code-comment as
  // a documentation reference to the pre-fix shape — we only forbid it
  // outside comment lines. The regex below splits on newlines and rejects
  // lines that contain the pattern OUTSIDE a leading `//` comment marker.
  const lines = src.split(/\r?\n/);
  const offendingLine = lines.find((line) => {
    const stripped = line.trim();
    if (stripped.startsWith("//") || stripped.startsWith("*")) return false;
    return /void\s+flushSave\s*\(\s*\)/.test(line);
  });
  assert.equal(
    offendingLine,
    undefined,
    `MobileFormRunner must not contain \`void flushSave()\` as live code — the spec 149 fix replaced it with \`await flushSave()\` (offending line: ${offendingLine ?? "<none>"})`,
  );
});

// Widened in the 2026-09 freeze (fix brief D_ui #10). Only the mobile file was
// pinned, so the DESKTOP FormRenderer kept the exact `void flushSave()` shape
// that MobileFormRunner's spec-149 comment calls the bug -- while that comment
// claimed the two runners mirrored each other. This is a source-text pin only;
// the race itself is executed in tests/behaviour/ui-forms.test.ts (D10).
test("spec 149 — the desktop FormRenderer does not fire-and-forget flushSave either", () => {
  const src = read("apps/web/src/components/forms/FormRenderer.tsx");
  const offendingLine = src.split(/\r?\n/).find((line) => {
    const stripped = line.trim();
    if (stripped.startsWith("//") || stripped.startsWith("*")) return false;
    return /void\s+flushSave\s*\(\s*\)/.test(line);
  });
  assert.equal(offendingLine, undefined, `FormRenderer must not contain \`void flushSave()\` as live code (offending line: ${offendingLine ?? "<none>"})`);
  assert.match(
    src,
    /await\s+flushSave\(\)[\s\S]{0,400}form\.requestSubmit\(\)/,
    "FormRenderer's server-action path must await the final flushSave before re-submitting the form",
  );
  assert.match(src, /flushedRef/, "the re-submit must be guarded (requestSubmit re-enters the same onSubmit handler)");
});

// ---------- MobileUploadRunner — mountedRef + redirect timer refs ----------

test("spec 149 — MobileUploadRunner declares mountedRef and redirectTimerRef", () => {
  const src = read(UPLOAD_PATH);
  // The two new refs MUST be declared at the top of the component body
  // (the spec mandates them by name so a refactor can't quietly rename
  // them and break the closure-discipline contract).
  assert.match(
    src,
    /const\s+mountedRef\s*=\s*useRef\(\s*true\s*\)/,
    "MobileUploadRunner must declare `const mountedRef = useRef(true)` for the closure-discipline guard",
  );
  assert.match(
    src,
    /const\s+redirectTimerRef\s*=\s*useRef</,
    "MobileUploadRunner must declare `const redirectTimerRef = useRef<...>(null)` for the success-redirect cancellation token",
  );
});

test("spec 149 — every tus callback in MobileUploadRunner guards on mountedRef.current", () => {
  const src = read(UPLOAD_PATH);
  // onError must short-circuit on unmount — pre-fix it would setState on
  // an unmounted component and React would log a warning.
  assert.match(
    src,
    /onError:\s*\([^)]*\)\s*=>\s*\{\s*(?:\/\/[^\n]*\n\s*)*if\s*\(\s*!\s*mountedRef\.current\s*\)\s*return/,
    "MobileUploadRunner.onError must early-return when !mountedRef.current",
  );
  // onProgress must short-circuit on unmount — same reason. The progress
  // bar setState would otherwise log a warning on every chunk after
  // unmount.
  assert.match(
    src,
    /onProgress:\s*\([^)]*\)\s*=>\s*\{\s*if\s*\(\s*!\s*mountedRef\.current\s*\)\s*return/,
    "MobileUploadRunner.onProgress must early-return when !mountedRef.current",
  );
  // onSuccess must short-circuit on unmount — the success screen never
  // renders if the component is gone.
  assert.match(
    src,
    /onSuccess:\s*\(\)\s*=>\s*\{\s*(?:\/\/[^\n]*\n\s*)*if\s*\(\s*!\s*mountedRef\.current\s*\)\s*return/,
    "MobileUploadRunner.onSuccess must early-return when !mountedRef.current",
  );
});

// ---------- MobileUploadRunner — onSuccess redirect try/catch + timer ----------

test("spec 149 — MobileUploadRunner.onSuccess stores the redirect timer and try/catches the router.push", () => {
  const src = read(UPLOAD_PATH);
  // The setTimeout handle must be ASSIGNED to redirectTimerRef.current so
  // the unmount cleanup can clear it. The previous shape called
  // `window.setTimeout(...)` and threw away the handle.
  assert.match(
    src,
    /redirectTimerRef\.current\s*=\s*setTimeout\(/,
    "MobileUploadRunner.onSuccess must store the setTimeout handle in redirectTimerRef.current so unmount can cancel it",
  );
  // The redirect itself must be inside a try/catch so a router teardown
  // (push rejects) doesn't leave the user stuck on the success screen.
  // Whitespace + linebreaks between `try {`, the call, and `} catch` are
  // tolerated; the contract is just that the push is wrapped.
  assert.match(
    src,
    /try\s*\{[\s\S]{0,80}router\.push\(\s*"\/uploads"\s*\)\s*;?\s*\}\s*catch/,
    "MobileUploadRunner.onSuccess must wrap router.push('/uploads') in a try/catch",
  );
  // The catch branch must surface an error AND switch the step to "failed"
  // so the user sees a Back / Retry pair instead of a frozen success
  // screen.
  assert.match(
    src,
    /catch\s*\([^)]*\)\s*\{[\s\S]{0,300}setErrorMsg\(/,
    "MobileUploadRunner.onSuccess catch branch must call setErrorMsg(...) so the failure is visible",
  );
  assert.match(
    src,
    /catch\s*\([^)]*\)\s*\{[\s\S]{0,400}setStep\(\s*"failed"\s*\)/,
    "MobileUploadRunner.onSuccess catch branch must switch step to 'failed' so the Back / Retry pair renders",
  );
});

// ---------- MobileUploadRunner — unmount cleanup ----------

test("spec 149 — MobileUploadRunner unmount cleanup flips the mount flag and clears the timer", () => {
  const src = read(UPLOAD_PATH);
  // The cleanup body MUST flip mountedRef.current to false — without this
  // every in-flight tus callback's mountedRef guard is meaningless.
  assert.match(
    src,
    /return\s*\(\)\s*=>\s*\{[\s\S]{0,1500}mountedRef\.current\s*=\s*false/,
    "MobileUploadRunner unmount cleanup must flip mountedRef.current to false",
  );
  // The cleanup MUST clear the pending redirect timer — without this a
  // late-firing setTimeout would call router.push on an unmounted
  // component (React would log a warning and the navigation would race
  // the user's next click).
  assert.match(
    src,
    /return\s*\(\)\s*=>\s*\{[\s\S]{0,1500}clearTimeout\(\s*redirectTimerRef\.current\s*\)/,
    "MobileUploadRunner unmount cleanup must clearTimeout(redirectTimerRef.current)",
  );
});

test("spec 149 — MobileUploadRunner unmount cleanup surfaces the cancelled error and aborts the tus instance", () => {
  const src = read(UPLOAD_PATH);
  // The literal error message — pinning the exact string so a future
  // contributor can't silently soften "Upload cancelled — try again" into
  // a less actionable phrase. The em-dash is intentional (matches the
  // surrounding LMS error-message voice, e.g. spec 135 "Try WhatsApp
  // instead.").
  assert.match(
    src,
    /setErrorMsg\(\s*"Upload cancelled — try again"\s*\)/,
    "MobileUploadRunner unmount cleanup must call setErrorMsg('Upload cancelled — try again') so the user sees why their video didn't reach the server",
  );
  // The setErrorMsg must be GUARDED on uploadRef.current — without the
  // guard a clean teardown (user pressed Cancel first, which nulled the
  // ref) would set a stale error message that the user never asked for.
  assert.match(
    src,
    /if\s*\(\s*uploadRef\.current\s*\)\s*\{[\s\S]{0,300}setErrorMsg\(\s*"Upload cancelled — try again"\s*\)/,
    "MobileUploadRunner unmount cleanup must guard the setErrorMsg call on uploadRef.current being truthy",
  );
  // The abort + null sequence — abort the tus instance, then drop the
  // ref so a subsequent unmount (StrictMode) doesn't double-abort.
  assert.match(
    src,
    /uploadRef\.current\.abort\(\)/,
    "MobileUploadRunner unmount cleanup must call uploadRef.current.abort()",
  );
  assert.match(
    src,
    /uploadRef\.current\s*=\s*null/,
    "MobileUploadRunner unmount cleanup must null uploadRef.current after aborting",
  );
});

// ---------- No-regression / hygiene ----------

test("spec 149 — no TODO / FIXME / placeholder markers leaked into shipped source", () => {
  for (const path of [FORM_PATH, UPLOAD_PATH]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});

test("spec 149 — no new dependencies were introduced (no abort-controller polyfill, no react-use-async)", () => {
  // The fix is pure closure / ref hygiene. No animation library, no
  // promise-cancellation library, no AbortController polyfill should
  // have crept into apps/web/package.json as a side-effect.
  const pkg = read("apps/web/package.json");
  assert.ok(
    !/abort-controller/.test(pkg),
    "apps/web must not depend on abort-controller — the fix uses a mountedRef pattern instead",
  );
  assert.ok(
    !/react-use-async/.test(pkg),
    "apps/web must not depend on react-use-async — the fix uses raw refs and useEffect cleanup",
  );
  assert.ok(
    !/p-cancelable/.test(pkg),
    "apps/web must not depend on p-cancelable — the redirect cancellation is a stored setTimeout handle",
  );
});

test("spec 149 — the fix is documented inline so future contributors don't quietly revert it", () => {
  // The inline comments in both files reference Spec 149 by number so a
  // future refactor reading the file knows to consult the spec before
  // reverting the `await` / the ref guards. This is a soft contract but
  // it's the LMS pattern across all the previous race-condition fixes.
  const formSrc = read(FORM_PATH);
  assert.match(
    formSrc,
    /Spec 149/,
    "MobileFormRunner must carry an inline `Spec 149` reference so the fix is self-documenting",
  );
  const uploadSrc = read(UPLOAD_PATH);
  assert.match(
    uploadSrc,
    /Spec 149/,
    "MobileUploadRunner must carry an inline `Spec 149` reference so the fix is self-documenting",
  );
});
