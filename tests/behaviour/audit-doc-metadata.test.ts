// docs/audit-actions.md says, for each action, what its metadata holds. It is
// what an operator reads to query audit_log, so a key it names that nothing
// writes is a filter that silently matches nothing, and a key it omits is data
// nobody knows is there.
//
// ── W3-24 / W3-06 / W3-25 / W3-27 ────────────────────────────────────────────
//
// Several non-auth rows described metadata the code never wrote:
//
//   helpdesk.ticket_opened       `ticketId`, `userId`, `category`  (writes topic, pageSlug, deliveredTo)
//   helpdesk.ticket_rate_limited `userId`, `ipMasked`              (writes retryAfterMs)
//
// Executed: the real handlers, as a signed-in user, against Postgres; each
// row they write is compared with its documented row, both ways.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture, type Fixture } from "./_admin-fixture.js";
import { closeAppPool } from "./_mentorship.js";

const skip = needsDatabase();
after(closeAppPool);

const DOC = readFileSync(new URL("../../docs/audit-actions.md", import.meta.url), "utf8");

/** The taxonomy's table row for `action`: its "fires when" text and its metadata cell. */
function docRow(action: string): { firesWhen: string; metadata: string; line: string } {
  const line = DOC.split("\n").find((l) => l.startsWith(`| \`${action}\` |`));
  assert.ok(line, `${action} is written by the code and missing from docs/audit-actions.md`);
  const cells = line.split("|").slice(1, -1).map((s) => s.trim());
  assert.equal(cells.length, 3, `${action}: expected | action | fires when | metadata |, got ${cells.length} cells`);
  return { firesWhen: cells[1]!, metadata: cells[2]!, line };
}

/** Every `backticked` name in a metadata cell: the keys the doc says are there. */
const documentedKeys = (cell: string) => new Set([...cell.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)].map((m) => m[1]!));

type Row = { action: string; entity_type: string | null; metadata: Record<string, unknown> };

/** This user's rows for `action`, once the voided recordAudit() inserts have landed. */
async function rowsOf(c: Client, userId: string, action: string, atLeast = 1): Promise<Row[]> {
  let rows: Row[] = [];
  for (let i = 0; i < 40; i++) {
    rows = (
      await c.query<Row>(`SELECT action, entity_type, metadata FROM audit_log WHERE user_id = $1 AND action = $2`, [
        userId,
        action,
      ])
    ).rows;
    if (rows.length >= atLeast) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(rows.length >= atLeast, `the scenario should have written ${action}`);
  return rows;
}

/**
 * The row's metadata keys are exactly the ones documented: none undocumented,
 * and none documented that the code does not write. `optional` names keys the
 * doc lists that this particular row may leave out.
 */
function assertDocumented(row: Row, optional: string[] = []): void {
  const { metadata, line } = docRow(row.action);
  const documented = documentedKeys(metadata);
  const written = Object.keys(row.metadata);
  for (const key of written) {
    assert.ok(documented.has(key), `${row.action}: metadata key \`${key}\` is written and not documented`);
  }
  for (const key of documented) {
    if (optional.includes(key)) continue;
    assert.ok(written.includes(key), `${row.action}: docs/audit-actions.md documents \`${key}\`, which the code does not write`);
  }
  if (row.entity_type) {
    assert.ok(line.includes(`\`${row.entity_type}\``), `${row.action}: entity_type ${row.entity_type} is not documented`);
  }
}

async function signedIn(f: Fixture, role: string): Promise<string> {
  const id = await f.user(role, role);
  f.defer(`DELETE FROM rate_limits WHERE key LIKE $1`, [`%:${id}`]);
  f.defer(`DELETE FROM notifications WHERE entity_type = 'helpdesk' AND body LIKE $1`, [`%${id}%`]);
  actAs(id, role);
  return id;
}

// ── helpdesk.* ───────────────────────────────────────────────────────────────

test("W3-06/W3-24 helpdesk.*: the ticket and the throttle rows hold what the taxonomy says", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("doc-hd"));
    try {
      const me = await signedIn(f, "teacher");
      const { POST } = await import("../../apps/web/src/app/api/helpdesk/tickets/route.ts");
      const post = () =>
        POST(
          new Request("http://x/api/helpdesk/tickets", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ topic: "login", pageSlug: "/dashboard", message: `help ${me}` }),
          }),
        );
      assert.equal((await post()).status, 200);
      const [opened] = await rowsOf(c, me, "helpdesk.ticket_opened");
      assertDocumented(opened!);

      // Spend the rest of the hour's tickets, then one refused.
      await c.query(`UPDATE rate_limits SET count = 5 WHERE key = $1`, [`helpdesk:${me}`]);
      assert.equal((await post()).status, 429);
      const [limited] = await rowsOf(c, me, "helpdesk.ticket_rate_limited");
      assertDocumented(limited!);
    } finally {
      await f.cleanup();
    }
  });
});
