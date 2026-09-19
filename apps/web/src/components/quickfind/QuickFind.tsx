"use client";

// Spec 121 — Quick-Find overlay (⌘K / Ctrl+K).
//
// Cross-entity keyboard-driven search modal. Revives the JSX prototype's
// `WikiQuickFind` overlay (LMS GML Frontend/shell.jsx line 187 trigger;
// LMS GML Frontend/app.jsx lines 21,62-70,275-288 global plumbing).
//
// Behavior contract:
//   - Cmd+K (mac) / Ctrl+K (win) toggles the overlay open. Esc closes.
//   - Listener is attached once at mount (window scope) and cleaned up on
//     unmount — no leaks across HMR.
//   - Background click and result selection both close.
//   - Result list supports Arrow-Up / Arrow-Down / Enter for keyboard nav.
//   - Debounced fetch (~180ms) to GET /api/quickfind?q=…; min 2 chars.
//   - Recently-viewed: top 5 most recent selections persisted to
//     localStorage keyed by the current user id ("gml.quickfind.recent.<uid>").
//     Rendered when the search box is empty.
//   - Cross-fades the recents card and the results card so the user always
//     sees something useful inside the overlay.
//
// SM-9 (PII): the API never returns learner rows; this component therefore
// never has to filter on the client. If a future spec exposes learners, the
// API gate is the right place to add it — never trust the client to redact.

import { QUICKFIND_OPEN_EVENT } from "./events";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

// Mirror of the QuickFindResult type exported by the API route. Kept inline so
// the client component doesn't have to import server-only code.
export type QuickFindResult = {
  kind:
    | "teacher"
    | "school"
    | "class"
    | "subject"
    | "observation_cycle"
    | "mentor_pairing"
    | "outline"
    | "session";
  id: string;
  label: string;
  sublabel: string;
  href: string;
};

type QuickFindProps = {
  /** The currently signed-in user's id. Used to namespace the recents key. */
  userId: string;
};

const DEBOUNCE_MS = 180;
const RECENTS_CAP = 5;
const MIN_QUERY = 2;

const KIND_LABEL: Record<QuickFindResult["kind"], string> = {
  teacher: "Teacher",
  school: "School",
  class: "Class",
  subject: "Subject",
  observation_cycle: "Observation",
  mentor_pairing: "Mentor pairing",
  outline: "Outline",
  session: "Session",
};

function recentsKey(userId: string): string {
  return `gml.quickfind.recent.${userId}`;
}

/**
 * Spec 169 — clear ALL QuickFind recents from localStorage. Called from the
 * sign-out path (Topbar user-pill form) before the server action fires so a
 * shared-device handoff (teacher A logs out, teacher B logs in on the same
 * tablet) doesn't surface teacher A's recently-viewed entities to teacher B
 * via the empty-state recents card.
 *
 * Wipes the canonical key prefix (`gml.quickfind.recent.`) — both the
 * current user's row and any orphaned rows from previous accounts that
 * touched this device. Best-effort; failures (private browsing / quota /
 * localStorage disabled) are swallowed because we cannot block the
 * sign-out path on a client-storage hiccup.
 */
export function clearAllQuickFindRecents(): void {
  if (typeof window === "undefined") return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith("gml.quickfind.recent.")) keys.push(k);
    }
    for (const k of keys) {
      window.localStorage.removeItem(k);
    }
  } catch {
    // localStorage quota / disabled / private-browsing — nothing to do.
  }
}

function readRecents(userId: string): QuickFindResult[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(recentsKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Defensive shape filter — discard anything that doesn't have the four required fields.
    return parsed
      .filter((r): r is QuickFindResult => {
        return (
          typeof r === "object" &&
          r !== null &&
          typeof (r as QuickFindResult).id === "string" &&
          typeof (r as QuickFindResult).kind === "string" &&
          typeof (r as QuickFindResult).label === "string" &&
          typeof (r as QuickFindResult).href === "string"
        );
      })
      .slice(0, RECENTS_CAP);
  } catch {
    return [];
  }
}

function writeRecents(userId: string, recents: QuickFindResult[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      recentsKey(userId),
      JSON.stringify(recents.slice(0, RECENTS_CAP)),
    );
  } catch {
    // localStorage quota exceeded / disabled → silent. Recents are best-effort.
  }
}

/** Never-changing subscription for the client-only `mounted` snapshot below. */
const NOOP_SUBSCRIBE = (): (() => void) => () => {};

export default function QuickFind({ userId }: QuickFindProps): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<QuickFindResult[]>([]);
  // Lazy initialiser rather than a mount effect. Reading localStorage here is
  // safe because this component renders nothing until `open`, so the server and
  // first client render agree (both null) and there is no hydration mismatch.
  const [recents, setRecents] = useState<QuickFindResult[]>(() =>
    typeof window === "undefined" ? [] : readRecents(userId),
  );
  const [activeIdx, setActiveIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Client-only flag for the createPortal call (document is undefined on the
  // server). useSyncExternalStore returns the server snapshot (false) during
  // SSR and the client snapshot (true) from the first browser render, with no
  // setState-in-effect and therefore no cascading re-render.
  const mounted = useSyncExternalStore(
    NOOP_SUBSCRIBE,
    () => true,
    () => false,
  );

  // Open/close are user actions, so their side effects belong here rather than
  // in an effect keyed on `open`.
  const openPanel = useCallback(() => {
    // Re-read recents on every open: a sibling tab may have written to the
    // same localStorage key since this component mounted.
    setRecents(readRecents(userId));
    setOpen(true);
  }, [userId]);

  const closePanel = useCallback(() => {
    setOpen(false);
    setQuery("");
    setResults([]);
    setActiveIdx(0);
  }, []);

  // Global Cmd+K / Ctrl+K → toggle; Esc → close.
  useEffect(() => {
    if (typeof window === "undefined") return;

    function onKeyDown(event: KeyboardEvent): void {
      const k = event.key;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && (k === "k" || k === "K")) {
        event.preventDefault();
        if (open) closePanel();
        else openPanel();
        return;
      }
      if (k === "Escape") {
        closePanel();
      }
    }

    // An event any component can dispatch to open the panel. QuickFind is
    // mounted once in the authenticated layout, so a button elsewhere in the
    // tree -- particularly one inside an async Server Component, which cannot
    // carry an onClick at all -- has no other way to reach it. /repo's "Find a
    // record" button was exactly that: a bare <button type="button"> with no
    // handler, which did nothing when clicked.
    function onOpenRequest(): void {
      if (!open) openPanel();
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(QUICKFIND_OPEN_EVENT, onOpenRequest);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(QUICKFIND_OPEN_EVENT, onOpenRequest);
    };
  }, [open, openPanel, closePanel]);

  // Focus the input after the panel paints. This effect only schedules a
  // timeout -- the state transitions that used to live here (clearing the
  // query on close, reloading recents on open) now happen in openPanel /
  // closePanel, because they are consequences of a user action rather than of
  // rendering. Driving them from an effect meant every open and close cost an
  // extra render pass (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(id);
  }, [open]);

  // Debounced fetch.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    // Below the minimum length there is nothing to fetch and nothing to clear:
    // `list` already falls back to `recents` whenever `showRecents` is true, so
    // stale `results` are unreachable, and the loading indicator below is gated
    // on `!showRecents`. Clearing them here was writing state in an effect to
    // produce a value that is simply derived (react-hooks/set-state-in-effect).
    if (q.length < MIN_QUERY) return;
    const ctrl = new AbortController();
    const timer = window.setTimeout(async () => {
      // Flipped here rather than synchronously in the effect body. Previously
      // the spinner appeared on the first keystroke and stayed up for the whole
      // debounce window with no request in flight; now it tracks the actual
      // fetch. (Also resolves react-hooks/set-state-in-effect.)
      setLoading(true);
      try {
        const res = await fetch(
          `/api/quickfind?q=${encodeURIComponent(q)}`,
          { signal: ctrl.signal, credentials: "same-origin" },
        );
        if (!res.ok) {
          setResults([]);
        } else {
          const data = (await res.json()) as {
            results?: QuickFindResult[];
          };
          setResults(Array.isArray(data.results) ? data.results : []);
        }
      } catch {
        // AbortError or network blip → leave the last results in place.
      } finally {
        setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [query, open]);

  // The list currently being navigated — results when there's a query,
  // recents when the input is empty.
  const showRecents = query.trim().length < MIN_QUERY;
  const list = useMemo<QuickFindResult[]>(
    () => (showRecents ? recents : results),
    [showRecents, recents, results],
  );

  // Derived, not stored. Clamping in an effect meant a render with an
  // out-of-range index always painted first, then a second render corrected it.
  // Computing it during render makes the out-of-range state unrepresentable.
  const safeIdx = list.length === 0 ? 0 : Math.min(activeIdx, list.length - 1);

  const handleSelect = useCallback(
    (item: QuickFindResult) => {
      // Write to recents (front, deduped, capped).
      const next = [item, ...recents.filter((r) => !(r.kind === item.kind && r.id === item.id))]
        .slice(0, RECENTS_CAP);
      setRecents(next);
      writeRecents(userId, next);
      closePanel();
    },
    [recents, userId, closePanel],
  );

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIdx(Math.min(list.length - 1, safeIdx + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIdx(Math.max(0, safeIdx - 1));
    } else if (event.key === "Enter") {
      const item = list[safeIdx];
      if (item) {
        event.preventDefault();
        handleSelect(item);
        // Navigate manually since handleSelect closes the modal — the <Link>
        // would unmount before its click handler fires.
        window.location.assign(item.href);
      }
    }
  }

  if (!mounted || !open) return null;

  // Spec 156 (Run 14 audit-closure MEDIUM): createPortal can throw on SSR
  // hydration mismatch or if document.body has been transiently removed
  // (rare, but possible during print-preview / extension shenanigans). We
  // wrap the call in a try/catch so a single render miss never crashes the
  // whole authenticated route tree — the overlay just won't render that
  // tick, and the next state update will retry the portal cleanly.
  const overlay = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Quick find"
      onClick={closePanel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(20, 14, 10, 0.45)",
        zIndex: 9000,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "12vh",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(640px, calc(100vw - 32px))",
          background: "var(--paper)",
          border: "1px solid var(--line)",
          borderRadius: 10,
          boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 14px",
            borderBottom: "1px solid var(--line)",
            background: "var(--paper-2)",
          }}
        >
          <span aria-hidden style={{ color: "var(--ink-3)", fontSize: 13 }}>
            ⌕
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search teachers, schools, sessions…"
            aria-label="Quick find search"
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              background: "transparent",
              fontSize: 14,
              color: "var(--ink)",
            }}
          />
          <span
            className="kbd"
            style={{
              fontSize: 10,
              padding: "1px 5px",
              border: "1px solid var(--line)",
              borderRadius: 3,
              color: "var(--ink-3)",
            }}
          >
            Esc
          </span>
        </div>

        <div style={{ maxHeight: "55vh", overflowY: "auto" }}>
          {showRecents ? (
            recents.length === 0 ? (
              <EmptyHint primary="Recently viewed" secondary="Start typing to search across the repository." />
            ) : (
              <ResultList
                heading="Recently viewed"
                items={recents}
                activeIdx={safeIdx}
                onSelect={handleSelect}
              />
            )
          ) : loading && !showRecents && results.length === 0 ? (
            <EmptyHint primary="Searching…" secondary={`Query: "${query.trim()}"`} />
          ) : results.length === 0 ? (
            <EmptyHint
              primary="No matches"
              secondary={query.trim().length < MIN_QUERY ? "Type at least 2 characters." : `No results for "${query.trim()}"`}
            />
          ) : (
            <ResultList
              heading={`Results · ${results.length}`}
              items={results}
              activeIdx={safeIdx}
              onSelect={handleSelect}
            />
          )}
        </div>
      </div>
    </div>
  );

  try {
    return createPortal(overlay, document.body);
  } catch {
    return null;
  }
}

function EmptyHint({ primary, secondary }: { primary: string; secondary: string }) {
  return (
    <div style={{ padding: "24px 18px", color: "var(--ink-3)" }}>
      <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ink-2)" }}>{primary}</div>
      <div style={{ fontSize: 12, marginTop: 4 }}>{secondary}</div>
    </div>
  );
}

function ResultList({
  heading,
  items,
  activeIdx,
  onSelect,
}: {
  heading: string;
  items: QuickFindResult[];
  activeIdx: number;
  onSelect: (item: QuickFindResult) => void;
}) {
  return (
    <ul role="listbox" aria-label={heading} style={{ listStyle: "none", margin: 0, padding: 0 }}>
      <li
        style={{
          padding: "8px 14px",
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--ink-3)",
          background: "var(--paper-2)",
        }}
        aria-hidden
      >
        {heading}
      </li>
      {items.map((item, idx) => {
        const isActive = idx === activeIdx;
        return (
          <li key={`${item.kind}-${item.id}`} role="option" aria-selected={isActive}>
            <Link
              href={item.href}
              onClick={() => onSelect(item)}
              prefetch={false}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                padding: "10px 14px",
                textDecoration: "none",
                color: "var(--ink)",
                background: isActive ? "var(--card-hi)" : "transparent",
                borderBottom: "1px solid var(--line)",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {item.label}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--ink-3)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {item.sublabel}
                </div>
              </div>
              <span
                style={{
                  fontSize: 10,
                  padding: "2px 7px",
                  borderRadius: 99,
                  background: "var(--paper-2)",
                  color: "var(--ink-2)",
                  border: "1px solid var(--line)",
                  whiteSpace: "nowrap",
                }}
              >
                {KIND_LABEL[item.kind]}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
