// Execute the app's REAL authentication code: apps/web/src/auth.ts, the login,
// reset and callback modules, lib/supabase/server.ts and proxy.ts.
//
// ./_ui.ts and ./_server-actions.ts replace @/auth wholesale (with a signed-out
// stub, or with whoever the test put on globalThis), which is right for tests
// about what a PAGE does with a session and useless for tests about how the
// session itself is established, refreshed, written to cookies and ended. This
// harness keeps @/auth and everything under it real; the Supabase network peer
// is ./_fake_gotrue.ts, and the only modules replaced are framework boundaries:
//
//   server-only        Next aliases it internally; it is not installable.
//   next/headers       cookies()/headers() need a request. The stub serves the
//                      jar in `request` and records every cookie write with its
//                      attributes.
//   next/cache         revalidatePath() needs Next's static-generation store.
//   next-intl/server   reads the app's real bundles (see _stubs).
//
// Do not import ./_ui.ts or ./_server-actions.ts from a file that imports this
// one: their resolve hooks would put the @/auth stub back.

import { createRequire, registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const WEB_URL = new URL("../../apps/web/", import.meta.url);
const SRC_DIR = fileURLToPath(new URL("src/", WEB_URL));
const STUBS_URL = new URL("./_stubs/", import.meta.url);
const webRequire = createRequire(new URL("package.json", WEB_URL));

export const React = webRequire("react") as typeof import("react");
(globalThis as Record<string, unknown>).React = React;
const ReactDOMServer = webRequire("react-dom/server") as { renderToStaticMarkup: (el: unknown) => string };

const STUB_BY_SPECIFIER: Record<string, string> = {
  "server-only": "empty.ts",
  "next/headers": "next-headers.ts",
  "next/cache": "next-cache.ts",
  "next-intl/server": "next-intl-server.ts",
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const direct = STUB_BY_SPECIFIER[specifier];
    if (direct) return { url: new URL(direct, STUBS_URL).href, shortCircuit: true };
    if (specifier.endsWith(".css")) return { url: new URL("empty.ts", STUBS_URL).href, shortCircuit: true };
    return nextResolve(specifier.startsWith("@/") ? SRC_DIR + specifier.slice(2) : specifier, context);
  },
});

type CookieWrite = { name: string; value: string; options: Record<string, unknown> };
type RequestState = {
  locale: "en" | "hi" | "bo";
  cookies: Record<string, string>;
  headers: Record<string, string>;
  cookieWrites: CookieWrite[];
};

/** The fake request the next/headers stub serves. */
export const request: RequestState = ((globalThis as Record<string, unknown>).__gmlTestRequest ??= {
  locale: "en",
  cookies: {},
  headers: {},
  cookieWrites: [],
}) as RequestState;

/** A fresh browser: no cookies, no headers, nothing written yet. */
export function resetRequest(headers: Record<string, string> = {}): void {
  request.locale = "en";
  request.cookies = {};
  request.headers = headers;
  request.cookieWrites = [];
}

export type Outcome =
  | { kind: "redirect"; location: string }
  | { kind: "notFound" }
  | { kind: "returned"; value: unknown };

/** How an action or page ended; Next's redirect()/notFound() are thrown digests. */
export async function outcome(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { kind: "returned", value: await run() };
  } catch (err) {
    const digest = (err as { digest?: unknown } | null)?.digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) {
      return { kind: "redirect", location: digest.split(";")[2]! };
    }
    if (typeof digest === "string" && digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;404")) return { kind: "notFound" };
    throw err;
  }
}

export function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

export function renderSync(element: unknown): string {
  return ReactDOMServer.renderToStaticMarkup(element);
}

/** Close the app's pg pool(s) so the process exits promptly. */
export async function closeAppDb(): Promise<void> {
  const pools = new Set([
    (webRequire("@gml/db") as { getPool: () => { end: () => Promise<void> } }).getPool(),
    (await import("../../packages/db/src/client.ts")).getPool(),
  ]);
  for (const p of pools) await p.end().catch(() => undefined);
}

export { SRC_DIR, webRequire };
