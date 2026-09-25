// Governance test for spec 126 — WhatsApp ingest log page.
//
// Closes the LMS GML Frontend/videos.jsx:33 affordance. Three files are
// under audit:
//
//   1. apps/web/src/app/(authenticated)/admin/whatsapp-log/page.tsx
//      — server component, programme_admin + super_admin gate, queries
//        video_submissions where source='whatsapp', joins audit_log to
//        surface sender phone, filter form for parsing + date range,
//        Resend transcode CTA per stuck row.
//   2. apps/web/src/app/(authenticated)/admin/whatsapp-log/actions.ts
//      — "use server", exports resendTranscodeAction, role gate,
//        transcodeQueue.add, recordAudit('whatsapp.transcode.resent'),
//        revalidatePath + redirect.
//   3. apps/web/src/app/(authenticated)/videos/page.tsx
//      — header button Link points at /admin/whatsapp-log, gated behind
//        hasAnyRole(programme_admin, super_admin).
//
// Plus the five spec-kit files under specs/126-whatsapp-ingest-log-page/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const PAGE_PATH = "apps/web/src/app/(authenticated)/admin/whatsapp-log/page.tsx";
const ACTIONS_PATH = "apps/web/src/app/(authenticated)/admin/whatsapp-log/actions.ts";
const VIDEOS_PAGE = "apps/web/src/app/(authenticated)/videos/page.tsx";
const SPEC_DIR = "specs/126-whatsapp-ingest-log-page";

test("spec 126 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the WhatsApp ingest log spec`,
    );
  }
});

test("spec 126 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  assert.match(
    src,
    /admin\/whatsapp-log\/page\.tsx/,
    "plan.md must call out the new admin page in CREATED",
  );
  assert.match(
    src,
    /admin\/whatsapp-log\/actions\.ts/,
    "plan.md must call out the new server action in CREATED",
  );
  assert.match(
    src,
    /videos\/page\.tsx/,
    "plan.md must call out the videos library page in EDITED",
  );
});

test("spec 126 — /admin/whatsapp-log/page.tsx exists and is a server component", () => {
  assert.ok(existsSync(resolve(root, PAGE_PATH)), `${PAGE_PATH} must exist`);
  const src = read(PAGE_PATH);
  // No 'use client' directive — the page is a pure server component.
  assert.ok(
    !/^\s*["']use client["']/m.test(src),
    "whatsapp-log page must stay a server component — Resend uses a server action, not a client handler",
  );
  // Marked dynamic so the table reflects fresh ingest rows on every render.
  assert.match(
    src,
    /export const dynamic\s*=\s*"force-dynamic"/,
    "page must opt out of caching so newly-arrived WhatsApp rows show up immediately",
  );
});

test("spec 126 — page calls requireRole with programme_admin + super_admin", () => {
  const src = read(PAGE_PATH);
  assert.match(src, /from\s+"@\/lib\/guards"/, "page must import requireRole from @/lib/guards");
  // The role list must include both privileged tiers and no lower role.
  const m = src.match(/requireRole\(\s*\[([^\]]*)\]/);
  assert.ok(m, "page must call requireRole with a role list");
  const list = m[1];
  assert.match(list, /"programme_admin"/, "role list must include programme_admin");
  assert.match(list, /"super_admin"/, "role list must include super_admin");
  assert.doesNotMatch(list, /"teacher"/, "teacher must not be in the role list");
  assert.doesNotMatch(list, /"observer"/, "observer must not be in the role list");
  assert.doesNotMatch(list, /"mentor"/, "mentor must not be in the role list");
});

test("spec 126 — page queries video_submissions filtered to source='whatsapp'", () => {
  const src = read(PAGE_PATH);
  assert.match(src, /from\(videoSubmissions\)/, "must select from videoSubmissions table");
  // The source='whatsapp' filter is the load-bearing piece — anything else
  // would render direct-upload rows here.
  assert.match(
    src,
    /eq\(videoSubmissions\.source,\s*"whatsapp"\)/,
    "must filter source='whatsapp' to scope the surface to WhatsApp ingest only",
  );
  // Limit + ordering — newest first, capped at 100 per the spec brief.
  assert.match(
    src,
    /desc\(videoSubmissions\.createdAt\)/,
    "must order by createdAt DESC so the latest hit is on top",
  );
  assert.match(src, /\.limit\(\s*(100|PAGE_LIMIT)\s*\)/, "must cap the surface at 100 rows");
});

test("spec 126 — page joins audit_log for sender phone via metadata.from", () => {
  const src = read(PAGE_PATH);
  // F98: the submission row now carries the phone (whatsapp_from, migration
  // 0031) and the page reads it first. The audit join was keyed on entity_id,
  // which the webhook never wrote, so it showed "—" for every row; it remains
  // only for rows older than 0031, keyed on the message id the row does carry.
  // tests/behaviour/whatsapp-log.test.ts renders both cases.
  assert.match(src, /videoSubmissions\.whatsappFrom/, "page must read the sender stored on the submission");
  assert.doesNotMatch(src, /inArray\(auditLog\.entityId/, "the entity_id join could never match; the webhook never set it");
  assert.match(src, /from\(auditLog\)/, "page must query auditLog to surface sender phone");
  assert.match(
    src,
    /eq\(auditLog\.action,\s*"whatsapp\.message\.received"\)/,
    "page must filter audit_log to action='whatsapp.message.received'",
  );
  // metadata.from is the phone — must be extracted from the jsonb metadata.
  assert.match(
    src,
    /md\.from/,
    "page must extract metadata.from from the audit row to display the sender phone",
  );
});

test("spec 126 — page renders the filter form with parsing + date range", () => {
  const src = read(PAGE_PATH);
  // The filter form is a plain <form method="get"> — no client component.
  assert.match(src, /method="get"/, "filter form must use method=get so search params drive the filter");
  // Parsing select with matched + unmatched options.
  assert.match(src, /name="parsing"/, "page must expose a parsing select named 'parsing'");
  assert.match(src, />\s*matched\s*</, "parsing select must offer the 'matched' option");
  assert.match(src, />\s*unmatched\s*</, "parsing select must offer the 'unmatched' option");
  // Date-range inputs (HTML5 type=date keeps it server-rendered).
  assert.match(src, /name="from"/, "page must expose a 'from' date input");
  assert.match(src, /name="to"/, "page must expose a 'to' date input");
  assert.match(src, /type="date"/, "date inputs must be HTML5 date pickers");
});

test("spec 126 — page renders a Resend transcode CTA wired to the server action", () => {
  const src = read(PAGE_PATH);
  assert.match(
    src,
    /from\s+"\.\/actions"/,
    "page must import from co-located ./actions module",
  );
  assert.match(
    src,
    /resendTranscodeAction/,
    "page must reference the resendTranscodeAction export",
  );
  assert.match(
    src,
    /action=\{resendTranscodeAction\}/,
    "page must bind the Resend form to the server action (no client onClick)",
  );
  assert.match(
    src,
    /name="submissionId"/,
    "Resend form must POST a submissionId hidden input so the action knows which row to re-enqueue",
  );
  assert.match(
    src,
    />\s*Resend transcode\s*</,
    "the CTA label must read 'Resend transcode' — surfaces what the click does",
  );
});

test("spec 126 — page hides Resend for finalised rows", () => {
  const src = read(PAGE_PATH);
  // The page must not render the Resend button for ready / reviewed /
  // review_pending statuses — re-encoding a finalised stream risks SM-3.
  assert.match(
    src,
    /RESENDABLE_STATUSES/,
    "page must lift the resend-allowed status set into a const so the gate is explicit",
  );
  // The set must include the four stuck states and exclude the three
  // finalised ones — defensive read of the literal Set body.
  const setMatch = src.match(/RESENDABLE_STATUSES\s*=\s*new Set\(\s*\[([\s\S]*?)\]/);
  assert.ok(setMatch, "RESENDABLE_STATUSES must be declared with literal status strings");
  const setBody = setMatch[1];
  assert.match(setBody, /"received"/, "received state must be resendable");
  assert.match(setBody, /"queued"/, "queued state must be resendable");
  assert.match(setBody, /"transcoding"/, "transcoding state must be resendable");
  assert.match(setBody, /"failed"/, "failed state must be resendable");
  assert.doesNotMatch(setBody, /"ready"/, "ready state must NOT be resendable");
  assert.doesNotMatch(setBody, /"reviewed"/, "reviewed state must NOT be resendable");
});

test("spec 126 — actions.ts exists and declares use-server", () => {
  assert.ok(existsSync(resolve(root, ACTIONS_PATH)), `${ACTIONS_PATH} must exist`);
  const src = read(ACTIONS_PATH);
  assert.match(src, /^\s*"use server"/m, "actions.ts must declare 'use server' at the top of the file");
});

test("spec 126 — actions.ts exports resendTranscodeAction with the correct shape", () => {
  const src = read(ACTIONS_PATH);
  assert.match(
    src,
    /export async function resendTranscodeAction/,
    "actions.ts must export an async resendTranscodeAction function",
  );
  // Same role gate as the page — defence in depth.
  assert.match(src, /from\s+"@\/lib\/guards"/, "actions.ts must import requireRole from @/lib/guards");
  assert.match(
    src,
    /requireRole\(\s*\[\s*"programme_admin",\s*"super_admin"\s*\]\s*\)/,
    "resendTranscodeAction must gate on programme_admin + super_admin",
  );
  // Must read the submissionId hidden input from formData.
  assert.match(
    src,
    /formData\.get\(\s*"submissionId"\s*\)/,
    "action must read submissionId from formData (matches the hidden input on the page)",
  );
});

test("spec 126 — actions.ts re-enqueues via enqueueTranscode with the webhook payload shape", () => {
  // INVERTED on two counts, both consequences of BullMQ being removed.
  //
  //   1. The import moved from "@gml/worker/queues" to "@/lib/queue". The
  //      producer used to live inside the consumer's package, which is why
  //      apps/web declared `"@gml/worker": "workspace:*"` and shipped BullMQ,
  //      ioredis and the whole worker tree in its container image. The queue is
  //      a Postgres table now, so the shared code sits in @gml/db and the web
  //      app's thin wrapper over it sits in @/lib/queue.
  //
  //   2. The payload no longer declares `source: "whatsapp"`. The old
  //      assertion's own wording -- "so the worker takes the WhatsApp branch"
  //      -- names the defect: that branch stream-copied with `-c copy`, which
  //      fails on arbitrary phone-camera output and, when it works, hands a
  //      multi-megabit rendition to exactly the low-bandwidth users the 480p
  //      ladder exists for. Every source is re-encoded now, so nothing may
  //      branch on provenance and the payload must not offer it the chance.
  const src = read(ACTIONS_PATH);
  assert.match(
    src,
    /import\s*\{\s*enqueueTranscode\s*\}\s*from\s*"@\/lib\/queue"/,
    "actions.ts must import enqueueTranscode from @/lib/queue",
  );
  const call = src.match(/enqueueTranscode\(\s*\{([\s\S]*?)\}\s*\)/);
  assert.ok(call, "action must call enqueueTranscode({ ... }) to enqueue the re-encode");
  const payload = call[1];
  for (const field of ["videoSubmissionId", "fileId", "bucket", "objectKey"]) {
    assert.match(payload, new RegExp(`\\b${field}\\s*[:,}]`), `payload must include ${field}`);
  }
  assert.ok(
    !/\bsource\b/.test(payload),
    "the payload must not carry a `source` discriminator -- the worker re-encodes every source identically",
  );

  // The row-level `source === "whatsapp"` guard above the enqueue is a
  // DIFFERENT thing and must survive: it stops a hand-crafted POST from this
  // page acting on a direct-upload submission. Authorisation, not encoding.
  assert.match(
    src,
    /row\.source\s*!==\s*"whatsapp"/,
    "the action must still refuse non-WhatsApp submissions -- that guard is about " +
      "what this page is allowed to touch, not about how the video gets encoded",
  );
});

test("spec 126 — actions.ts audits the resend via recordAudit", () => {
  const src = read(ACTIONS_PATH);
  assert.match(src, /from\s+"@\/lib\/audit"/, "actions.ts must import recordAudit");
  assert.match(src, /recordAudit\(/, "action must call recordAudit to log the resend event");
  assert.match(
    src,
    /action:\s*"whatsapp\.transcode\.resent"/,
    "audit row must use the dotted action 'whatsapp.transcode.resent'",
  );
  // Previous status carried as metadata so the audit log tells "why" not just "what".
  assert.match(
    src,
    /previousStatus/,
    "audit metadata must carry previousStatus so the audit log explains why the resend was needed",
  );
});

test("spec 126 — actions.ts revalidates and redirects back to /admin/whatsapp-log", () => {
  const src = read(ACTIONS_PATH);
  assert.match(src, /revalidatePath\(/, "action must call revalidatePath so the page rerenders with the new state");
  assert.match(
    src,
    /\/admin\/whatsapp-log/,
    "redirect target must point at /admin/whatsapp-log so the operator stays in context",
  );
  assert.match(src, /redirect\(/, "action must redirect after enqueuing (server action contract)");
});

test("spec 126 — videos/page.tsx rewires the WhatsApp ingest log button to /admin/whatsapp-log", () => {
  const src = read(VIDEOS_PAGE);
  // The old broken URL must no longer be a link target (it's still
  // permitted to appear in a comment explaining the migration).
  assert.ok(
    !/href="\/admin\/audit\?action=whatsapp\./.test(src),
    "videos page must NOT still link the button to /admin/audit?action=whatsapp. — that URL matched zero audit rows",
  );
  // The new URL must be wired.
  assert.match(
    src,
    /href="\/admin\/whatsapp-log"/,
    "videos page must link the 'WhatsApp ingest log' button to /admin/whatsapp-log",
  );
  // The label must still say what it does.
  assert.match(
    src,
    />\s*WhatsApp ingest log\s*</,
    "videos page must keep the 'WhatsApp ingest log' label so the affordance reads the same as the prototype",
  );
});

test("spec 126 — videos/page.tsx gates the button behind hasAnyRole(programme_admin, super_admin)", () => {
  const src = read(VIDEOS_PAGE);
  // hasAnyRole import — the page is the only call site so this is load-bearing.
  assert.match(
    src,
    /hasAnyRole/,
    "videos page must import hasAnyRole to gate the WhatsApp ingest log button",
  );
  // The role list must contain both privileged tiers.
  assert.match(
    src,
    /"programme_admin"/,
    "role list must include programme_admin",
  );
  assert.match(
    src,
    /"super_admin"/,
    "role list must include super_admin",
  );
  // The button must be rendered behind a canSeeWhatsappLog gate.
  assert.match(
    src,
    /canSeeWhatsappLog/,
    "videos page must lift the role check into a canSeeWhatsappLog flag so the JSX is readable",
  );
});

test("spec 126 — no TODO / FIXME / placeholder markers leaked into shipped source", () => {
  for (const path of [PAGE_PATH, ACTIONS_PATH, VIDEOS_PAGE]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});
