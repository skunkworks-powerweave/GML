// /admin/gates reads its per-gate numbers in one grouped query per table.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// The page ran, for EACH gate, the latest section_gates row, a count of
// active grants, a 30-day count of attempts over audit_log and a second
// 30-day count of failures over audit_log -- four round trips chained per
// gate, twelve per render, re-reading the same 30 days of gate-attempt rows
// six times, on a table that only grows. Its comment said "three queries per
// render ... (5 gates)".
//
// ── WHAT IS EXECUTED ─────────────────────────────────────────────────────────
//
// The real page, rendered as a super_admin against Postgres, with the app
// pool's statements recorded. Each card's numbers are checked against the
// database's own count, taken around the render.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { render } from "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture } from "./_admin-fixture.js";

const skip = needsDatabase();
// The pool the app's modules use (tsx loads apps/web as CommonJS).
const appPool = () =>
  (createRequire(new URL("../../apps/web/package.json", import.meta.url))("@gml/db") as {
    getPool: () => { query: (...args: unknown[]) => unknown; end: () => Promise<void> };
  }).getPool();
after(async () => {
  if (!skip) await appPool().end().catch(() => undefined);
});

const SLUGS = ["observation", "mentorship", "admin"] as const;

type Card = { grants: number; attempts: number; failures: number };

/** Each gate card's Active grants / Attempts (30d) / Failures (30d). */
function cards(html: string): Record<string, Card> {
  const out: Record<string, Card> = {};
  for (const m of html.matchAll(/<article[^>]*data-gate-slug="([a-z]+)"[^>]*>([\s\S]*?)<\/article>/g)) {
    const dd = [...m[2]!.matchAll(/<dd[^>]*>([\s\S]*?)<\/dd>/g)].map((d) => d[1]!.replace(/<[^>]*>/g, "").trim());
    // Last rotated, Version, Active grants, Attempts (30d), "Failures · rotated by".
    out[m[1]!] = { grants: Number(dd[2]), attempts: Number(dd[3]), failures: Number(dd[4]!.split(" ")[0]) };
  }
  return out;
}

test("the gate cards' counts come from one grouped query per table, and are right", { skip }, async () => {
  const { default: GatesPage } = await import("../../apps/web/src/app/(authenticated)/admin/gates/page.tsx");
  const pool = appPool();
  await withClient(async (c) => {
    const t = tag("gate-stats");
    const f = fixture(c, t);
    const admin = await f.user("super_admin", "sadmin");
    const other = await f.user("mentor", "mentor");
    try {
      // Attempts inside and outside the 30-day window. audit_log is
      // append-only, so these stay; they are what make the numbers non-zero
      // whatever else the database holds. Only the current action names:
      // a planted legacy gate_pass / gate_fail row would stay in the log for
      // good and change the order of /admin/audit's action filter, which
      // admin-audit-lookups.test.ts checks (the truth query below still
      // counts both spellings, as the page does).
      const planted: Array<[string, string, string]> = [
        ["gate.attempt.fail", "mentorship", "1 day"],
        ["gate.attempt.fail", "mentorship", "2 days"],
        ["gate.attempt.success", "mentorship", "3 days"],
        ["gate.attempt.fail", "mentorship", "4 days"],
        ["gate.attempt.fail", "mentorship", "31 days"],
        ["gate.attempt.success", "admin", "5 days"],
        ["gate.attempt.success", "admin", "40 days"],
      ];
      for (const [action, slug, ago] of planted) {
        await c.query(
          `INSERT INTO audit_log (action, entity_type, entity_id, user_id, created_at) VALUES ($1, 'section_gate', $2, $3, now() - $4::interval)`,
          [action, slug, other, ago],
        );
      }
      await f.row("section_gate_grants", { user_id: other, gate_slug: "mentorship", expires_at: new Date(Date.now() + 3600_000) });
      await f.row("section_gate_grants", { user_id: admin, gate_slug: "mentorship", expires_at: new Date(Date.now() + 3600_000) });
      await f.row("section_gate_grants", { user_id: other, gate_slug: "observation", expires_at: new Date(Date.now() - 60_000) });

      const truth = async (): Promise<Record<string, Card>> => {
        const out: Record<string, Card> = {};
        for (const slug of SLUGS) {
          const { rows: [r] } = await c.query(
            `SELECT
               (SELECT count(*)::int FROM section_gate_grants WHERE gate_slug::text = $1 AND expires_at > now()) AS grants,
               (SELECT count(*)::int FROM audit_log WHERE entity_id = $1 AND created_at > now() - interval '30 days'
                  AND action IN ('gate.attempt.success', 'gate.attempt.fail', 'gate_pass', 'gate_fail')) AS attempts,
               (SELECT count(*)::int FROM audit_log WHERE entity_id = $1 AND created_at > now() - interval '30 days'
                  AND action IN ('gate.attempt.fail', 'gate_fail')) AS failures`,
            [slug],
          );
          out[slug] = r as Card;
        }
        return out;
      };

      actAs(admin, "super_admin");
      const statements: string[] = [];
      const original = pool.query;
      pool.query = function (this: unknown, ...args: unknown[]) {
        const q = args[0] as string | { text?: string };
        statements.push(typeof q === "string" ? q : (q?.text ?? ""));
        return original.apply(this, args);
      };
      // Other tests write gate attempts too; retry until nothing moved
      // while the page was rendering.
      let shown: Record<string, Card> = {};
      let expected: Record<string, Card> = {};
      try {
        for (let i = 0; i < 5; i++) {
          const before = await truth();
          statements.length = 0;
          shown = cards(await render(await GatesPage()));
          expected = await truth();
          if (JSON.stringify(before) === JSON.stringify(expected)) break;
        }
      } finally {
        pool.query = original;
      }

      assert.deepEqual(shown, expected, "each card shows the database's own counts");
      assert.ok(expected.mentorship!.attempts >= 4 && expected.mentorship!.failures >= 3 && expected.mentorship!.grants >= 2);

      const reads = (table: string) =>
        statements.filter((s) => /^\s*select/i.test(s) && new RegExp(`from "${table}"`).test(s)).length;
      assert.deepEqual(
        { audit_log: reads("audit_log"), section_gate_grants: reads("section_gate_grants"), section_gates: reads("section_gates") },
        { audit_log: 1, section_gate_grants: 1, section_gates: 1 },
        `one grouped read per table for all ${SLUGS.length} gates:\n${statements.join("\n")}`,
      );
    } finally {
      await f.cleanup();
    }
  });
});
