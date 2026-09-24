// Execute the app's REAL server actions and server pages, without Next.js.
//
// A "use server" module is an ordinary module with a directive string at the
// top; what stops a plain node test from calling one is only the framework
// around it: auth() needs a Supabase session, and revalidatePath() needs the
// request's static-generation store. Those two are replaced here -- nothing
// else. The action's own guards (requireRole, the section gate, ownership),
// its writes through the app's real @gml/db client (so DATABASE_URL must be
// set, and rows are COMMITTED: tests clean up after themselves), its
// redirect()s and its notFound()s all run exactly as in production.
//
// Builds on ./_ui.ts (the @/ alias, server-only, next/headers, next-intl) and
// swaps its always-signed-out auth stub for one a test can sign in to.

import { createRequire, registerHooks } from "node:module";
import "./_ui.js";

const STUBS_URL = new URL("./_stubs/", import.meta.url);
const UI_AUTH_STUB = new URL("auth.ts", STUBS_URL).href;

// Registered after _ui.ts, so this hook runs first and sees what _ui.ts
// resolved.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/cache") {
      return { url: new URL("next-cache.ts", STUBS_URL).href, shortCircuit: true };
    }
    const resolved = nextResolve(specifier, context);
    if (resolved.url === UI_AUTH_STUB) {
      return { url: new URL("auth-session.ts", STUBS_URL).href, shortCircuit: true };
    }
    return resolved;
  },
});

export type TestUser = { id: string; role: string; name?: string | null; email?: string | null };

/** Sign `user` in for every auth() call until the next signIn(). */
export function signIn(user: TestUser | null): void {
  (globalThis as Record<string, unknown>).__gmlTestSession = user ? { user } : null;
}

export type Outcome =
  | { kind: "redirect"; location: string }
  | { kind: "notFound" }
  | { kind: "returned"; value: unknown };

/**
 * Run an action or page and report how it ended. Next's redirect() and
 * notFound() are thrown control-flow errors whose `digest` carries the
 * outcome; anything else is a real failure and is rethrown.
 */
export async function outcome(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { kind: "returned", value: await run() };
  } catch (err) {
    const digest = (err as { digest?: unknown } | null)?.digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) {
      return { kind: "redirect", location: digest.split(";")[2]! };
    }
    if (typeof digest === "string" && digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;404")) {
      return { kind: "notFound" };
    }
    throw err;
  }
}

/** A FormData from a plain object, as a no-JS browser would post it. */
export function form(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    for (const one of Array.isArray(v) ? v : [v]) fd.append(k, one);
  }
  return fd;
}

/**
 * Close the app's module-level pool so the test process exits promptly rather
 * than waiting out the pool's 30 s idle timeout. tsx loads apps/web as
 * CommonJS, so the pool the app uses is the one require() gives apps/web --
 * not necessarily the instance an ESM import from here would.
 */
export async function closeAppDb(): Promise<void> {
  const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
  const pools = new Set([
    (webRequire("@gml/db") as { getPool: () => { end: () => Promise<void> } }).getPool(),
    (await import("../../packages/db/src/client.ts")).getPool(),
  ]);
  for (const p of pools) await p.end().catch(() => undefined);
}
