// The administration screens speak the reader's language -- executed.
//
// ── THE DEFECT (UAT, 2026-09-27) ─────────────────────────────────────────────
//
// A programme administrator who picked Hindi or Bhoti got a translated menu
// over English admin pages: /admin/users (its create form, every row's
// buttons, and the messages its actions return), /admin/gates and its rotate
// panel, /admin/audit, /admin/system-settings (headings, the notification
// categories, and a refused save's reason, which travelled through the URL
// as zod's English), /admin/transcode-jobs and /admin/whatsapp-log (and the
// refusals their actions redirect back with). All of it was written into the
// components in English.
//
// What is rendered here is the real page, component or server action, with
// next-intl's real translator over the app's own bundles (tests/behaviour/
// _ui.ts), in Hindi and in Bhoti. Each check pairs a string from the admin
// namespace that must appear with its English original that must not. What
// the log records -- action names such as dashboard.viewed, e-mail addresses
// -- stays as stored.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { render, renderSync, request, mount, textOf, decodeEntities, elements, attr, h } from "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture } from "./_admin-fixture.js";
import { closeAppPool } from "./_mentorship.js";
import { loadMessages } from "../../apps/web/src/i18n/config.ts";

/** A role's Hindi name, from the bundle (wording is a reviewer's call, not this test's). */
const hiRole = (role: string) => ((loadMessages("hi").admin as { client: { roles: Record<string, string> } }).client.roles[role])!;

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppPool();
});

const APP = "../../apps/web/src/app/(authenticated)/admin";

/** Run `body` with the fake request in `locale`, back to English afterwards. */
async function inLocale<T>(locale: "hi" | "bo", body: () => Promise<T> | T): Promise<T> {
  request.locale = locale;
  try {
    return await body();
  } finally {
    request.locale = "en";
  }
}

const text = (html: string) => decodeEntities(html.replace(/<!-- -->/g, "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");

/** Every `shown` string appears in `out`, and no `hidden` one does. */
function speaks(out: string, pairs: Array<[shown: string, hidden: string]>): void {
  for (const [shown, hidden] of pairs) {
    assert.ok(out.includes(shown), `"${shown}" is shown`);
    assert.ok(!out.includes(hidden), `"${hidden}" is not`);
  }
}

// ── client components (no database) ──────────────────────────────────────────

const ROW = {
  id: "44444444-4444-4444-8444-444444444444",
  email: "o@example.test",
  name: "Otsal Dorje",
  role: "observer" as const,
  active: true,
  phone: null,
  deleted: false,
  lastSeenAt: "2026-09-20T08:00:00.000Z",
};

test("a user row's buttons, hints and role picker are Hindi; the person's name and address stay as stored", async () => {
  const { UserRow } = await import(`${APP}/users/user-row.tsx`);
  const html = await inLocale("hi", () =>
    renderSync(h(UserRow as never, { user: ROW, roleLabel: "अवलोकनकर्ता", actorRole: "super_admin", isSelf: false } as never)),
  );
  const out = text(html);
  speaks(out, [
    ["भूमिका तय करें", "Set role"],
    ["निष्क्रिय करें", "Deactivate"],
    ["पासवर्ड सेट करें", "Set password"],
    ["नंबर सहेजें", "Save number"],
    ["अंतिम बार देखा गया 2026-09-20", "last seen"],
    ["गेट पासवर्ड इसी नंबर पर भेजे जाते हैं", "Gate passwords are shared to it"],
  ]);
  // The role picker names each role instead of showing its enum code.
  const options = elements(html, "option").map((o) => o.text.trim());
  assert.ok(options.includes(hiRole("programme_admin")) && options.includes(hiRole("super_admin")), options.join(", "));
  assert.ok(!options.includes("programme_admin"), "no enum code is offered as a role name");
  assert.match(html, /placeholder="WhatsApp नंबर"/);
  assert.ok(out.includes("Otsal Dorje") && out.includes("o@example.test"), "data is shown as stored");
});

test("the create-account form is Bhoti", async () => {
  const { CreateUserForm } = await import(`${APP}/users/create-user-form.tsx`);
  const m = mount(
    CreateUserForm as (p: unknown) => unknown,
    { actorRole: "super_admin", unlinkedTeachers: [], unlinkedMentors: [] },
    { intl: "bo" },
  );
  const out = textOf(m.tree);
  speaks(out, [
    ["མིང་ཆ་ཚང་།", "Full name"],
    ["ཐོག་མའི་གསང་ཨང་།", "Initial password"],
    ["འབྲེལ་མཐུད།", "Link to"],
    ["དགེ་རྒན་གྱི་ཐོ་འགོད།", "A teacher record"],
    ["རྩིས་ཐོ་གསར་བཟོ།", "Create account"],
    ["ལས་གཞིའི་འགན་འཛིན།", "Programme admin"],
  ]);
});

test("the gate rotate button is Bhoti", async () => {
  const { RotateControls } = await import(`${APP}/gates/rotate-controls.tsx`);
  const m = mount(RotateControls as (p: unknown) => unknown, { slug: "mentorship", label: "ལམ་སྟོན།", recipients: [] }, { intl: "bo" });
  speaks(textOf(m.tree), [["གསང་ཨང་བརྗེ་སྒྱུར།", "Rotate password"]]);
});

// ── server actions ───────────────────────────────────────────────────────────

test("a users action answers in the administrator's language", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("i18n-admin-act"));
    try {
      actAs(await f.user("super_admin", "sadmin"), "super_admin");
      const { setPhoneAction } = await import(`${APP}/users/actions.ts`);
      const form = new FormData();
      form.set("userId", ROW.id);
      form.set("phone", "not a number");
      const bo = await inLocale("bo", () => setPhoneAction(undefined, form));
      assert.ok(bo.error?.includes("ཁ་པར་ཨང་གྲངས་འབྲི་རོགས།"), bo.error);
      assert.ok(!bo.error?.includes("Enter a mobile number"), bo.error);
      const hi = await inLocale("hi", () => setPhoneAction(undefined, form));
      assert.ok(hi.error?.startsWith("मोबाइल नंबर दर्ज करें"), hi.error);
    } finally {
      await f.cleanup();
    }
  });
});

// ── server-rendered pages ────────────────────────────────────────────────────

test("the admin index is Hindi, and names roles instead of showing their codes", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("i18n-admin-index"));
    try {
      actAs(await f.user("programme_admin", "padmin"), "programme_admin");
      const { default: AdminIndexPage } = await import(`${APP}/page.tsx`);
      const out = text(await inLocale("hi", async () => render(await AdminIndexPage())));
      speaks(out, [
        ["बिना कोड के डेटा प्रबंधन", "No-code data management"],
        ["सिस्टम सेटिंग्स", "System settings"],
        ["वीडियो प्रोसेसिंग कार्य", "Transcode jobs"],
        ["खाते बनाएँ, भूमिकाएँ तय करें", "Create accounts, set roles"],
        [`भूमिकाएँ: ${hiRole("programme_admin")}, ${hiRole("super_admin")}`, "roles: programme_admin"],
      ]);
      // (Each data table's title is the grid's, adminData.entities.<slug>.label,
      // which tests/behaviour for the grid covers.)
    } finally {
      await f.cleanup();
    }
  });
});

test("/admin/users is Hindi, including the client form and rows inside it", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("i18n-admin-users"));
    try {
      actAs(await f.user("super_admin", "sadmin"), "super_admin");
      const { default: UsersPage } = await import(`${APP}/users/page.tsx`);
      const out = text(await inLocale("hi", async () => render(await UsersPage())));
      speaks(out, [
        ["प्रशासन", "Administration"],
        ["खाता बनाएँ", "Create an account"],
        ["सभी खाते", "All accounts"],
        ["सक्रिय खात", "active account"],
        ["प्रारंभिक पासवर्ड", "Initial password"],
        ["नया बनाएँ", "Generate"],
        // The signed-in administrator's own row.
        ["(आप)", "(you)"],
      ]);
      // Each row's role is named, not shown as its enum code.
      assert.ok(out.includes("सुपर एडमिन"), "the super admin's role is named in Hindi");
    } finally {
      await f.cleanup();
    }
  });
});

test("/admin/audit is Hindi; the action names it records stay codes", { skip }, async () => {
  await withClient(async (c) => {
    const t = tag("i18n-admin-audit");
    const f = fixture(c, t);
    try {
      const admin = await f.user("super_admin", "sadmin");
      await c.query(`INSERT INTO audit_log (user_id, action, entity_type, metadata) VALUES ($1, 'dashboard.viewed', $2, '{}')`, [admin, t]);
      actAs(admin, "super_admin");
      const { default: AuditViewer } = await import(`${APP}/audit/page.tsx`);
      const html = await inLocale("hi", async () =>
        render(await AuditViewer({ searchParams: Promise.resolve({ user: `sadmin.${t}@example.test` }) })),
      );
      const out = text(html);
      speaks(out, [
        ["ऑडिट लॉग", "Audit log"],
        ["उपयोगकर्ता (ईमेल या id)", "User (email or id)"],
        ["फ़िल्टर करें", "Filter"],
        ["CSV निर्यात करें", "Export CSV"],
        ["कार्रवाई", "Action"],
        ["पृष्ठ 1", "Page 1"],
      ]);
      assert.ok(out.includes("dashboard.viewed"), "an audit action name is shown as the code it is");

      // A user filter that matches nobody says so, in Hindi, around the typed value.
      const rejected = await inLocale("hi", async () =>
        render(await AuditViewer({ searchParams: Promise.resolve({ user: "nobody-at-all" }) })),
      );
      const p = elements(rejected, "p").find((e) => attr(e.open, "data-testid") === "audit-user-filter-rejected");
      assert.ok(p, "the rejection is shown");
      assert.ok(p.text.includes("उपयोगकर्ता फ़िल्टर अनदेखा किया गया") && p.inner.includes("<code>nobody-at-all</code>"), p.inner);
    } finally {
      await f.cleanup();
    }
  });
});

test("/admin/gates is Bhoti, down to each gate's card and its rotate button", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("i18n-admin-gates"));
    try {
      actAs(await f.user("super_admin", "sadmin"), "super_admin");
      const { default: GatesPage } = await import(`${APP}/gates/page.tsx`);
      const out = text(await inLocale("bo", async () => render(await GatesPage())));
      speaks(out, [
        ["ས་ཁོངས་སྒོ།", "Section gates"],
        ["འཛིན་གྲྭའི་བལྟ་ཞིབ།", "Classroom Observation"],
        ["མཐའ་མར་བརྗེ་སྒྱུར་བྱས་པ།", "Last rotated"],
        ["ཞུགས་བཞིན་པའི་འཛུལ་ཆོག", "Active grants"],
        ["གསང་ཨང་བརྗེ་སྒྱུར།", "Rotate password"],
      ]);
    } finally {
      await f.cleanup();
    }
  });
});

test("/admin/system-settings is Bhoti, and a refused save says why in Bhoti", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("i18n-admin-settings"));
    try {
      actAs(await f.user("super_admin", "sadmin"), "super_admin");
      const { default: SystemSettingsPage } = await import(`${APP}/system-settings/page.tsx`);
      const raw = await inLocale("bo", async () =>
        render(await SystemSettingsPage({ searchParams: Promise.resolve({ error: "academicYear" }) })),
      );
      const out = text(raw);
      speaks(out, [
        ["ལམ་ལུགས་སྒྲིག་འགོད།", "System settings"],
        ["བརྙན་ཕབ་བཟོ་བཅོས་རིམ་པ།", "Video pipeline"],
        ["རོགས་རམ་རེ་ཞུ།", "Help request"],
        ["བསྒྱུར་བཅོས་ཉར་ཚགས།", "Save changes"],
        ["གྲབས་ཉར་དང་སླར་གསོའི་གནས་སྟངས།", "Backup & restore status"],
      ]);
      const alert = elements(raw, "div").find((d) => attr(d.open, "data-testid") === "settings-error");
      assert.ok(alert, "the refusal is shown");
      speaks(decodeEntities(alert.text), [
        ["གང་ཡང་ཉར་ཚགས་བྱས་མེད།", "Nothing was saved."],
        ["སློབ་ལོ་ YYYY-YY", "Academic year must be"],
      ]);
      // The 720p option still says, in words, why it cannot be chosen.
      const option = elements(raw, "option").find((o) => attr(o.open, "value") === "720p");
      assert.ok(option && attr(option.open, "disabled") !== null && /480p/.test(option.text));
    } finally {
      await f.cleanup();
    }
  });
});

test("/admin/transcode-jobs is Hindi, and its refusals too; an inherited name is an unknown code", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("i18n-admin-dlq"));
    try {
      actAs(await f.user("programme_admin", "padmin"), "programme_admin");
      const { default: Page } = await import(`${APP}/transcode-jobs/page.tsx`);
      const view = (error?: string) =>
        inLocale("hi", async () => render(await Page({ searchParams: Promise.resolve(error ? { error } : {}) })));
      const alertOf = (html: string) => elements(html, "p").find((p) => attr(p.open, "data-testid") === "dlq-error")?.text.trim();

      const out = text(await view());
      speaks(out, [
        ["वीडियो प्रोसेसिंग कार्य", "Transcode jobs"],
        ["रुके हुए कार्य, सभी कतारें", "Dead jobs, every queue"],
        ["हाल के (24 घंटे)", "Recent (24h)"],
        ["सबसे हाल के 100 वीडियो प्रोसेसिंग कार्य दिखाए जा रहे हैं", "Showing the most recent"],
      ]);

      const live = alertOf(await view("job_live"));
      assert.ok(live?.startsWith("उस वीडियो की प्रोसेसिंग पहले से कतार में है"), live);
      const unknown = alertOf(await view("no_such_code"));
      assert.equal(unknown, "वह कार्रवाई पूरी नहीं हो सकी।");
      for (const inherited of ["__proto__", "constructor", "toString"]) {
        assert.equal(alertOf(await view(inherited)), unknown, `?error=${inherited}`);
      }
    } finally {
      await f.cleanup();
    }
  });
});

test("/admin/whatsapp-log is Bhoti, and its refusals too; an inherited name is an unknown code", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("i18n-admin-wa"));
    try {
      actAs(await f.user("programme_admin", "padmin"), "programme_admin");
      const { default: Page } = await import(`${APP}/whatsapp-log/page.tsx`);
      // A range with no submissions in it: the table is the empty state, not
      // other tests' captions (which are data, and may be English).
      const EMPTY = { from: "2099-01-01", to: "2099-01-02" };
      const view = (error?: string) =>
        inLocale("bo", async () => render(await Page({ searchParams: Promise.resolve(error ? { ...EMPTY, error } : EMPTY) })));
      const alertOf = (html: string) => elements(html, "p").find((p) => attr(p.open, "data-testid") === "action-error")?.text.trim();

      const out = text(await view());
      speaks(out, [
        ["WhatsApp འབྱོར་ཐོ།", "WhatsApp ingest log"],
        ["མཆན་བྱང་།", "Caption"],
        ["མཐུན་སྒྲིག་མ་བྱུང་།", "unmatched"],
        ["འདེམས་སྒྲུག", "Filter"],
        ["བསྐྱར་སྒྲིག", "Reset"],
        ["ད་ལྟའི་འདེམས་སྒྲུག་དང་མཐུན་པའི་ WhatsApp ཕུལ་བ་མེད།", "No WhatsApp ingest events match"],
      ]);

      const noMedia = alertOf(await view("no_media_id"));
      assert.ok(noMedia?.includes("ཡང་བསྐྱར་ལེན་མི་ཐུབ།") && !noMedia.includes("cannot be fetched"), noMedia);
      const unknown = alertOf(await view("no_such_code"));
      assert.equal(unknown, "བྱ་སྤྱོད་དེ་མཇུག་སྒྲིལ་མ་ཐུབ།");
      for (const inherited of ["__proto__", "constructor", "toString"]) {
        assert.equal(alertOf(await view(inherited)), unknown, `?error=${inherited}`);
      }
    } finally {
      await f.cleanup();
    }
  });
});
