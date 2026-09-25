// Render the application's REAL React components to HTML, without Next.js.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// Every UI defect in the 2026-09 freeze was invisible to the governance suite,
// because that suite reads .tsx files as text. The Bhoti language button showed
// two ARABIC letters while its aria-label said "Bhoti"; a regex over the source
// passed, and a regex over a COMMENT kept passing after the button was fixed in
// one copy and not the other. Nothing short of rendering the component and
// reading what comes out would have caught it.
//
// So this module imports the components themselves -- the same files the app
// ships -- and renders them with react-dom. No database is involved, so these
// tests run everywhere, not only in CI.
//
// ── WHAT IS STUBBED, AND WHY THAT IS HONEST ──────────────────────────────────
//
// Only FRAMEWORK and SERVER boundaries are replaced, never the component under
// test:
//   - next-intl/server   getTranslations() needs Next's request scope. The stub
//                        reads the app's own locale bundles through the app's
//                        own loadMessages(), so the strings are the real ones.
//   - next/headers       cookies() / headers() need a request. The stub serves
//                        whatever the test put in `request`.
//   - next/font/google   a build-time transform; outside `next build` it throws.
//   - next/cache         revalidatePath() needs Next's work store; the stub
//                        records the call instead.
//   - *.css              Node cannot import a stylesheet.
//   - server-only        Next aliases this internally; it is not installable.
//   - @/auth, the login server actions, @/lib/chrome-counts
//                        these open Supabase / Postgres connections at import
//                        time. The components only pass them through (a form
//                        action, a badge formatter), so a stub changes nothing
//                        the assertions look at.
//   - @/lib/supabase/browser
//                        reads the session from document.cookie; the upload
//                        module only takes a bearer token from it.
//
// ── MECHANICS ────────────────────────────────────────────────────────────────
//
// The repo root has no tsconfig.json, so tsx compiles JSX with the classic
// runtime (React.createElement). The app's files do not import React for JSX
// -- they rely on Next's automatic runtime -- so React is published as a global
// here. Output is identical either way.
//
// `@/` is the app's tsconfig path alias; tsx only honours the tsconfig in the
// working directory, so a module hook maps it to apps/web/src. The same hook
// installs the stubs above. module.registerHooks is synchronous and applies to
// require() as well as import, which matters because tsx loads apps/web's .tsx
// files as CommonJS (apps/web/package.json has no "type": "module").

import { createRequire, registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const WEB_URL = new URL("../../apps/web/", import.meta.url);
const SRC_DIR = fileURLToPath(new URL("src/", WEB_URL));
const STUBS_URL = new URL("./_stubs/", import.meta.url);

// react and react-dom are dependencies of apps/web, not of the repo root, so
// resolve them from there. This is the same copy the components import.
const webRequire = createRequire(new URL("package.json", WEB_URL));
export const React = webRequire("react") as typeof import("react");
const ReactDOMStatic = webRequire("react-dom/static") as {
  prerender: (el: unknown) => Promise<{ prelude: ReadableStream<Uint8Array> }>;
};
const ReactDOMServer = webRequire("react-dom/server") as {
  renderToStaticMarkup: (el: unknown) => string;
};
(globalThis as Record<string, unknown>).React = React;

/** Bare specifiers replaced wholesale. */
const STUB_BY_SPECIFIER: Record<string, string> = {
  "server-only": "empty.ts",
  "next-intl/server": "next-intl-server.ts",
  "next/headers": "next-headers.ts",
  "next/font/google": "next-font-google.ts",
  // revalidatePath needs Next's work store; a server action run by a test only
  // needs the call recorded (see _stubs/next-cache.ts).
  "next/cache": "next-cache.ts",
};

/** App modules replaced by path (after @/ and relative resolution). */
const STUB_BY_APP_PATH: Array<[RegExp, string]> = [
  [/\/apps\/web\/src\/auth\.ts$/, "auth.ts"],
  [/\/apps\/web\/src\/app\/login\/(actions|email-actions)\.ts$/, "login-actions.ts"],
  [/\/apps\/web\/src\/lib\/chrome-counts\.ts$/, "chrome-counts.ts"],
  [/\/apps\/web\/src\/lib\/supabase\/browser\.ts$/, "supabase-browser.ts"],
];

registerHooks({
  resolve(specifier, context, nextResolve) {
    const direct = STUB_BY_SPECIFIER[specifier];
    if (direct) return { url: new URL(direct, STUBS_URL).href, shortCircuit: true };
    if (specifier.endsWith(".css")) {
      return { url: new URL("empty.ts", STUBS_URL).href, shortCircuit: true };
    }
    const target = specifier.startsWith("@/") ? SRC_DIR + specifier.slice(2) : specifier;
    const resolved = nextResolve(target, context);
    const normalised = resolved.url.replace(/\\/g, "/");
    for (const [pattern, stub] of STUB_BY_APP_PATH) {
      if (pattern.test(normalised)) {
        return { url: new URL(stub, STUBS_URL).href, shortCircuit: true };
      }
    }
    return resolved;
  },
});

type RequestState = {
  locale: "en" | "hi" | "bo";
  cookies: Record<string, string>;
  headers: Record<string, string>;
};

/**
 * The fake request the stubs read. Tests set it before rendering; `reset`
 * restores the English, cookie-less default.
 */
export const request: RequestState = ((globalThis as Record<string, unknown>).__gmlTestRequest ??= {
  locale: "en",
  cookies: {},
  headers: {},
}) as RequestState;

export function resetRequest(): void {
  request.locale = "en";
  request.cookies = {};
  request.headers = {};
}

/** Synchronous render for client components and plain trees. */
export function renderSync(element: unknown): string {
  return ReactDOMServer.renderToStaticMarkup(element);
}

/**
 * Full render that awaits async server components (Sidebar, BottomTabs,
 * Topbar and the layouts are all `async function`s).
 */
export async function render(element: unknown): Promise<string> {
  const { prelude } = await ReactDOMStatic.prerender(element);
  const reader = prelude.getReader();
  const decoder = new TextDecoder();
  let html = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
  }
  return html + decoder.decode();
}

export const h = React.createElement;

/**
 * Wrap a client tree in the app-router context that next/navigation's hooks
 * require (useRouter throws "invariant expected app router to be mounted"
 * without it). `refresh` is recorded so a test can see a picker fire it.
 */
export function withAppRouter(child: unknown, calls: string[] = []): unknown {
  const { AppRouterContext } = webRequire(
    "next/dist/shared/lib/app-router-context.shared-runtime",
  ) as { AppRouterContext: import("react").Context<unknown> };
  const router = {
    back: () => calls.push("back"),
    forward: () => calls.push("forward"),
    refresh: () => calls.push("refresh"),
    push: (href: string) => calls.push(`push:${href}`),
    replace: (href: string) => calls.push(`replace:${href}`),
    prefetch: () => undefined,
  };
  return h(AppRouterContext.Provider, { value: router }, child as never);
}

/** The app's real client-side i18n provider, fed the app's real bundle. */
export async function withIntl(child: unknown, locale: RequestState["locale"]): Promise<unknown> {
  // Resolved from apps/web (the repo root does not depend on next-intl), and
  // through require so it is the same module instance the components load.
  const { NextIntlClientProvider } = webRequire("next-intl") as {
    NextIntlClientProvider: import("react").ComponentType<{
      locale: string;
      messages: unknown;
      children?: unknown;
    }>;
  };
  const { loadMessages } = await import("../../apps/web/src/i18n/config.ts");
  // timeZone only silences next-intl's ENVIRONMENT_FALLBACK notice; nothing
  // rendered here formats a date.
  return h(
    NextIntlClientProvider as never,
    { locale, messages: loadMessages(locale), timeZone: "Asia/Kolkata" },
    child as never,
  );
}

// ── Interaction without a DOM ────────────────────────────────────────────────
//
// A static render shows the first frame only: it can prove an option says
// aria-pressed="false", never that clicking it makes it "true". There is no DOM
// library in this repo (and adding one means a lockfile change), so `mount`
// calls a component function directly under a minimal hook dispatcher that
// keeps state between calls. The test then finds a host element in the
// returned tree, invokes its real handler, and re-renders.
//
// Scope, deliberately narrow: ONE component's own hooks. Child components are
// left as unexpanded elements. Effects do not run unless the test asks for
// them (`{ effects: true }`): then useEffect/useLayoutEffect bodies run after
// each render whose deps changed, as React's commit would, and unmount() runs
// their cleanups -- which a test using them must call, or a timer an effect
// started keeps the process alive. It reaches into React's
// documented-as-internal dispatcher slot, so a React major upgrade will break
// it LOUDLY -- `mount` throws if the slot is missing rather than silently
// rendering nothing.

type AnyElement = { type: unknown; props: Record<string, unknown> };

export function mount<P>(component: (props: P) => unknown, props: P, opts: { effects?: boolean } = {}) {
  const internals = (React as unknown as Record<string, { H: unknown } | undefined>)
    .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  if (!internals || !("H" in internals)) {
    throw new Error("mount(): React's hook dispatcher slot moved; update tests/behaviour/_ui.ts");
  }
  const slots: unknown[] = [];
  let cursor = 0;
  const slot = <T>(init: () => T): [number, T] => {
    const k = cursor++;
    if (!(k in slots)) slots[k] = init();
    return [k, slots[k] as T];
  };
  // Effects, keyed by hook position like state; only with opts.effects.
  type EffectSlot = { deps: readonly unknown[] | undefined; cleanup: (() => void) | undefined };
  const effectSlots = new Map<number, EffectSlot>();
  let pendingEffects: Array<() => void> = [];
  const effect = (fn: () => unknown, deps?: readonly unknown[]) => {
    const k = cursor++;
    if (!opts.effects) return;
    const prev = effectSlots.get(k);
    const unchanged =
      prev && deps && prev.deps && deps.length === prev.deps.length && deps.every((d, i) => Object.is(d, prev.deps![i]));
    if (unchanged) return;
    pendingEffects.push(() => {
      prev?.cleanup?.();
      const cleanup = fn();
      effectSlots.set(k, { deps, cleanup: typeof cleanup === "function" ? (cleanup as () => void) : undefined });
    });
  };
  const dispatcher = {
    useState<T>(initial: T | (() => T)) {
      const [k, value] = slot(() => (typeof initial === "function" ? (initial as () => T)() : initial));
      const set = (next: T | ((prev: T) => T)) => {
        slots[k] = typeof next === "function" ? (next as (p: T) => T)(slots[k] as T) : next;
      };
      return [value, set];
    },
    useReducer<S, A>(reducer: (s: S, a: A) => S, initial: S) {
      const [k, value] = slot(() => initial);
      return [value, (a: A) => (slots[k] = reducer(slots[k] as S, a))];
    },
    useRef<T>(initial: T) {
      return slot(() => ({ current: initial }))[1];
    },
    useEffect: effect,
    useLayoutEffect: effect,
    useInsertionEffect() { cursor++; },
    useCallback<T>(fn: T) { cursor++; return fn; },
    useMemo<T>(fn: () => T) { cursor++; return fn(); },
    useTransition() { cursor++; return [false, (fn: () => void) => fn()]; },
    useDeferredValue<T>(v: T) { cursor++; return v; },
    useId() { return `mount-id-${cursor++}`; },
    useContext(ctx: { _currentValue: unknown }) { return ctx._currentValue; },
    useSyncExternalStore<T>(_s: unknown, get: () => T, getServer?: () => T) {
      cursor++;
      return (getServer ?? get)();
    },
    useActionState<S>(_a: unknown, initial: S) { cursor++; return [initial, () => undefined, false]; },
    useOptimistic<S>(v: S) { cursor++; return [v, () => undefined]; },
    useDebugValue() {},
  };
  const renderOnce = (): AnyElement => {
    const previous = internals.H;
    internals.H = dispatcher;
    cursor = 0;
    let out: AnyElement;
    try {
      out = component(props) as AnyElement;
    } finally {
      internals.H = previous;
    }
    const run = pendingEffects;
    pendingEffects = [];
    for (const e of run) e();
    return out;
  };
  let tree = renderOnce();
  return {
    get tree() { return tree; },
    rerender() { tree = renderOnce(); return tree; },
    /** Run every effect's cleanup, as unmounting would. */
    unmount() {
      for (const e of effectSlots.values()) e.cleanup?.();
      effectSlots.clear();
    },
  };
}

/** Host (string-typed) elements in a returned tree, depth-first. */
export function hostElements(node: unknown, out: AnyElement[] = []): AnyElement[] {
  if (Array.isArray(node)) {
    for (const n of node) hostElements(n, out);
  } else if (node && typeof node === "object" && "props" in (node as object)) {
    const el = node as AnyElement;
    if (typeof el.type === "string") out.push(el);
    hostElements(el.props.children, out);
  }
  return out;
}

/** Plain text of an element subtree (host text only). */
export function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && "props" in (node as object)) return textOf((node as AnyElement).props.children);
  return "";
}

/**
 * A window stand-in for code that dispatches CustomEvents on `window` (the
 * help panel's open event). Node 22 ships EventTarget and CustomEvent.
 */
export function withFakeWindow<T>(body: (win: EventTarget) => T): T {
  const g = globalThis as Record<string, unknown>;
  const had = "window" in g;
  const previous = g.window;
  const win = new EventTarget();
  g.window = win;
  try {
    return body(win);
  } finally {
    if (had) g.window = previous;
    else delete g.window;
  }
}

// ── Reading the output ────────────────────────────────────────────────────────

/** Every opening tag of `tag` in the markup, with its raw attribute text. */
export function openingTags(html: string, tag: string): string[] {
  return html.match(new RegExp(`<${tag}\\b[^>]*>`, "g")) ?? [];
}

/** The value of one attribute in an opening tag, HTML entities decoded. */
export function attr(openingTag: string, name: string): string | null {
  const m = openingTag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? decodeEntities(m[1]) : null;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Each <button>…</button> (or other element) with its opening tag and its
 * visible text content, in document order. Good enough for the flat markup
 * these components produce; nested elements of the same tag are not expected.
 */
export function elements(html: string, tag: string): Array<{ open: string; text: string; inner: string }> {
  const out: Array<{ open: string; text: string; inner: string }> = [];
  const re = new RegExp(`(<${tag}\\b[^>]*>)([\\s\\S]*?)</${tag}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.push({ open: m[1], inner: m[2], text: decodeEntities(m[2].replace(/<[^>]*>/g, "")) });
  }
  return out;
}

export { SRC_DIR };
