// Committed fixtures for tests that call the admin grid's REAL server actions
// and route handlers.
//
// Those run on the app's own pool (@gml/db), not on a transaction a test could
// roll back, so every row made here is tagged and removed again by `cleanup`,
// children first. audit_log rows are the exception: the table is append-only
// by design (SM-1), so they are tagged by entity and left behind.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { signIn, request, resetRequest } from "./_ui.js";

export type Fixture = {
  c: Client;
  /** INSERT ... RETURNING id, registering a DELETE for cleanup. */
  row: (table: string, values: Record<string, unknown>) => Promise<string>;
  /** A users row with this role. */
  user: (role: string, label?: string) => Promise<string>;
  /** Run the registered DELETEs in reverse order. */
  cleanup: () => Promise<void>;
  /** Register an extra cleanup statement (runs before earlier registrations). */
  defer: (sql: string, params: unknown[]) => void;
};

export function fixture(c: Client, t: string): Fixture {
  const undo: Array<[string, unknown[]]> = [];
  const row = async (table: string, values: Record<string, unknown>): Promise<string> => {
    const keys = Object.keys(values);
    const cols = keys.map((k) => `"${k}"`).join(", ");
    const params = keys.map((_, i) => `$${i + 1}`).join(", ");
    const { rows } = await c.query(
      `INSERT INTO ${table} (${cols}) VALUES (${params}) RETURNING id`,
      keys.map((k) => values[k]),
    );
    const id = rows[0].id as string;
    undo.push([`DELETE FROM ${table} WHERE id = $1`, [id]]);
    return id;
  };
  return {
    c,
    row,
    // public.users.id normally comes from auth.users; a test database has no
    // auth schema, so _post/003 skips that FK and the id is made up here.
    user: (role, label = role) =>
      row("users", { id: randomUUID(), email: `${label}.${t}@example.test`, name: `${label} ${t}`, role }),
    defer: (sql, params) => void undo.push([sql, params]),
    cleanup: async () => {
      for (const [sql, params] of undo.reverse()) {
        await c.query(sql, params).catch((err: unknown) => {
          // A leftover row is a leak, not a test failure; say so and move on.
          console.warn(`[fixture] cleanup "${sql}" failed: ${String(err)}`);
        });
      }
      resetRequest();
    },
  };
}

/** Sign the fake request in as an existing user. */
export function actAs(id: string, role: string): void {
  signIn(id, role);
}

/**
 * Await a server action and report where it redirected, or null if it
 * returned normally. next/navigation's redirect() throws an error whose digest
 * is `NEXT_REDIRECT;<type>;<url>;<status>;`.
 */
export async function redirectOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    const digest = (err as { digest?: unknown }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) {
      return digest.split(";")[2] ?? "";
    }
    throw err;
  }
}

export function form(values: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) {
    if (Array.isArray(v)) for (const x of v) fd.append(k, x);
    else fd.set(k, v);
  }
  return fd;
}

export { request };
