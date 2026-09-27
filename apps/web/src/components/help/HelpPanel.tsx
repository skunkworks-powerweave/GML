"use client";

// Spec 122 — slide-out help panel + global ⌘? / ? keyboard shortcut.
//
// Ports the prototype's HelpPanel (LMS GML Frontend/help.jsx lines 370-458)
// to a TypeScript client component. The panel:
//   • opens on demand via a custom `gml:open-help` window event so every
//     entry point shares the same shell. The entry points that actually
//     ship are the top bar's HelpButton and the mobile ? FAB; HelpTip,
//     HelpDot and HelpHeadbtn dispatch it too but have no call sites yet;
//   • renders the current topic's title + short + long + related-chips, or
//     the full grouped browse list when no topic is set;
//   • includes a search input that filters the dictionary live;
//   • carries the "Talk to a person" card with three real, wired buttons:
//     WhatsApp deep-link, mailto, and a POST to /api/helpdesk/tickets that
//     drops a notification on programme_admin role users (spec 122 wiring,
//     replacing the prototype's three inert <button> stubs);
//   • listens for the `?` keyboard shortcut globally so any authenticated
//     route can call it without re-mounting state;
//   • mounts a portal-free fixed-position aside so it overlays both the
//     desktop shell (sidebar + topbar) and the mobile shell (bottom tabs).
//
// The panel itself is a 'use client' island; the layout that mounts it stays
// a server component (see app/(authenticated)/layout.tsx).
//
// Every word is the reader's language: the articles are help.entries.<slug>,
// fetched when the panel first opens (useHelpEntries: they are most of the
// namespace and most visits never open the panel, so they are not sent with
// every page), the panel's own copy help.client.panel and
// help.client.human (lib/help.ts holds only the dictionary's structure). The
// text a user sends from here -- the WhatsApp and email prefill -- is theirs,
// so it is in their language too. The helpdesk ticket carries no sentence at
// all: its reader is an administrator, and /api/helpdesk/tickets writes it in
// each administrator's language.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { HELP, HELP_GROUPS, helpFor, searchHelp, type HelpText } from "@/lib/help";
import { useHelpEntries } from "./useHelpEntries";

/**
 * Custom DOM event the rest of the app can dispatch to open the panel on a
 * specific topic. Components like HelpTip and HelpHeadbtn fire it; HelpPanel
 * listens once at the window level so there's no ref-passing churn.
 */
export type HelpOpenEventDetail = { topic?: string | null };
export const HELP_OPEN_EVENT = "gml:open-help";

export function openHelp(topic?: string | null): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<HelpOpenEventDetail>(HELP_OPEN_EVENT, { detail: { topic: topic ?? null } }),
  );
}

type HelpdeskContact = {
  /** E.164-without-plus phone for wa.me. Pulled from GML_HELPDESK_PHONE. */
  whatsappPhone?: string | null;
  /** mailto target for the programme admin. Pulled from GML_HELPDESK_EMAIL. */
  email?: string | null;
};

type HelpPanelProps = {
  contact: HelpdeskContact;
  /** Optional starting topic, e.g. when a deep-link query string sets ?help=cycle. */
  initialTopic?: string | null;
};

// Spec 169 — assertEnv() in (authenticated)/layout.tsx passes a null
// whatsappPhone when the env value was missing OR set-but-invalid (e.g.
// the operator typo'd the country prefix). In both cases we HIDE the
// WhatsApp action row entirely rather than showing a "(number not
// configured)" disabled stub: a broken wa.me link launches WhatsApp into
// an error screen with no useful context. Email + in-app helpdesk-ticket
// paths remain visible. `isUsableWhatsappContact` is the single gate.
function isUsableWhatsappContact(phone: string | null | undefined): boolean {
  if (!phone) return false;
  const trimmed = phone.trim();
  if (trimmed.length === 0) return false;
  return /^\+?\d{8,15}$/.test(trimmed);
}

export function HelpPanel({ contact, initialTopic = null }: HelpPanelProps) {
  const t = useTranslations("help.client");
  const tAction = useTranslations("action");
  const [open, setOpen] = useState(false);
  // Fetched the first time the panel opens; null until then.
  const entries = useHelpEntries(open);
  const [topic, setTopic] = useState<string | null>(initialTopic);
  const [query, setQuery] = useState("");
  const [ticketState, setTicketState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);

  // Global open via custom event
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<HelpOpenEventDetail>).detail;
      setTopic(detail?.topic ?? null);
      setOpen(true);
    };
    window.addEventListener(HELP_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(HELP_OPEN_EVENT, onOpen);
  }, []);

  // ? / Shift+/ / ⌘? toggles. Skip while user is typing in inputs.
  //
  // Spec 156 (Run 14 audit-closure MEDIUM): pre-fix this only checked the
  // direct target's tagName + isContentEditable, which missed nested
  // contenteditable widgets (e.g. a rich-text comment box where the editing
  // happens in a deeper <p>/<span> inside a contenteditable container).
  // Using closest() walks the DOM tree so any ancestor input / textarea /
  // [contenteditable="true"] suppresses the shortcut. Mirrors the
  // browser's own behaviour for built-in shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      const isQuestion = e.key === "?" || (e.shiftKey && e.key === "/") || (e.metaKey && e.key === "?");
      if (!isQuestion) return;
      e.preventDefault();
      setOpen((prev) => !prev);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Focus management: restore focus to whatever triggered the open when we close.
  useEffect(() => {
    if (open) {
      lastFocusedRef.current = (document.activeElement as HTMLElement) ?? null;
      // Defer focus into the search input so the panel feels responsive.
      const t = setTimeout(() => searchInputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
    lastFocusedRef.current?.focus?.();
    return undefined;
  }, [open]);

  // Escape to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  /** A topic's words in the reader's language. */
  const textOf = useCallback(
    (k: string): HelpText => {
      const e = entries?.[k];
      return { title: e?.title ?? "", short: e?.short ?? "", long: e?.long || undefined };
    },
    [entries],
  );
  const entry = topic ? helpFor(topic) : null;
  const words = topic && entry && entries ? textOf(topic) : null;
  const results = useMemo(
    () => (entries && query.trim().length > 0 ? searchHelp(query, textOf) : []),
    [entries, query, textOf],
  );

  const handleJump = useCallback((k: string | null) => {
    setTopic(k);
    setQuery("");
  }, []);

  const pageSlug = typeof window !== "undefined" ? window.location.pathname : "/";

  const onSendTicket = useCallback(async () => {
    setTicketState("sending");
    try {
      const res = await fetch("/api/helpdesk/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // No `message`: the route writes the ticket in each administrator's
        // language from the topic and the page (it used to be an English
        // sentence built here, whatever language either side used).
        body: JSON.stringify({
          topic: topic ?? null,
          pageSlug,
        }),
      });
      setTicketState(res.ok ? "sent" : "error");
    } catch {
      setTicketState("error");
    }
  }, [pageSlug, topic]);

  if (!open) return null;

  const contextHint = words
    ? t("panel.contactTopic", { title: words.title, page: pageSlug })
    : t("panel.contactPage", { page: pageSlug });
  // Spec 169 — only build the wa.me href when assertEnv() certified
  // the phone format. Invalid / unset → null → HumanHelpCard hides the
  // row entirely (no "(number not configured)" stub).
  const waHref = isUsableWhatsappContact(contact.whatsappPhone)
    ? `https://wa.me/${encodeURIComponent((contact.whatsappPhone as string).replace(/[^0-9]/g, ""))}?text=${encodeURIComponent(
        contextHint,
      )}`
    : null;
  const mailHref = contact.email
    ? `mailto:${contact.email}?subject=${encodeURIComponent(t("panel.mailSubject", { page: pageSlug }))}&body=${encodeURIComponent(contextHint)}`
    : null;

  return (
    <>
      <div
        data-help-backdrop
        onClick={() => setOpen(false)}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(28,24,22,0.42)",
          zIndex: 40,
        }}
      />
      <aside
        role="dialog"
        aria-label={tAction("help")}
        data-help-panel
        style={{
          position: "fixed",
          right: 0,
          top: 0,
          bottom: 0,
          width: "min(380px, 100vw)",
          background: "var(--paper)",
          borderLeft: "1px solid var(--line)",
          boxShadow: "var(--shadow-3, 0 20px 50px rgba(28,24,22,0.2))",
          zIndex: 41,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <header
          style={{
            padding: "14px 16px 10px",
            borderBottom: "1px solid var(--line)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <div>
            <div
              style={{
                fontSize: 10,
                color: "var(--ink-3)",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
              }}
            >
              {tAction("help")}
            </div>
            <h2
              style={{
                fontFamily: "var(--serif)",
                fontSize: 20,
                letterSpacing: "-0.01em",
                margin: "2px 0 0",
              }}
            >
              {words ? words.title : t("panel.browse")}
            </h2>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label={t("panel.closeLabel")}
            style={{
              border: "1px solid var(--line)",
              background: "var(--card-hi)",
              padding: "4px 8px",
              borderRadius: "var(--r-2)",
              cursor: "pointer",
              fontSize: 13,
              color: "var(--ink-2)",
            }}
          >
            {t("panel.close")}
          </button>
        </header>

        <div style={{ padding: "10px 16px 0" }}>
          <input
            ref={searchInputRef}
            type="search"
            placeholder={t("panel.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t("panel.searchLabel")}
            data-help-search
            style={{
              width: "100%",
              padding: "8px 10px",
              border: "1px solid var(--line)",
              background: "var(--paper)",
              borderRadius: "var(--r-2)",
              fontSize: 13,
              color: "var(--ink)",
            }}
          />
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px 16px", minHeight: 0 }}>
          {!entries ? (
            <p role="status" style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 4 }}>
              {t("panel.loading")}
            </p>
          ) : query.trim().length > 0 ? (
            <div>
              <div
                style={{
                  fontSize: 10,
                  color: "var(--ink-3)",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  marginBottom: 6,
                }}
              >
                {t("panel.results", { count: results.length })}
              </div>
              {results.map(({ key, text: e }) => (
                <button
                  key={key}
                  type="button"
                  data-help-result
                  onClick={() => handleJump(key)}
                  style={{
                    display: "block",
                    textAlign: "left",
                    width: "100%",
                    padding: "8px 10px",
                    border: "1px solid transparent",
                    background: "transparent",
                    borderRadius: "var(--r-2)",
                    cursor: "pointer",
                    color: "var(--ink)",
                  }}
                >
                  <div style={{ fontWeight: 500, fontSize: 13 }}>{e.title}</div>
                  <div style={{ fontSize: 12, color: "var(--ink-2)", lineHeight: 1.4 }}>{e.short}</div>
                </button>
              ))}
              {results.length === 0 && (
                <div style={{ fontSize: 12, color: "var(--ink-3)", padding: 8 }}>
                  {t("panel.noResults")}
                </div>
              )}
            </div>
          ) : entry && words ? (
            <>
              <p style={{ fontSize: 13, color: "var(--ink-2)", margin: 0, lineHeight: 1.55 }}>{words.short}</p>
              {words.long ? (
                <p style={{ fontSize: 13, color: "var(--ink-2)", marginTop: 10, lineHeight: 1.6 }}>{words.long}</p>
              ) : null}

              {entry.related && entry.related.length > 0 ? (
                <>
                  <div
                    style={{
                      fontSize: 10,
                      color: "var(--ink-3)",
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                      marginTop: 16,
                      marginBottom: 6,
                    }}
                  >
                    {t("panel.related")}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {entry.related.map((rk) =>
                      helpFor(rk) ? (
                        <button
                          key={rk}
                          type="button"
                          data-help-related
                          onClick={() => handleJump(rk)}
                          style={{
                            padding: "4px 10px",
                            border: "1px solid var(--line)",
                            background: "var(--card-hi)",
                            borderRadius: 99,
                            fontSize: 12,
                            color: "var(--ink-2)",
                            cursor: "pointer",
                          }}
                        >
                          {textOf(rk).title}
                        </button>
                      ) : null,
                    )}
                  </div>
                </>
              ) : null}

              <hr style={{ border: "none", borderTop: "1px solid var(--line)", margin: "16px 0" }} />
              <button
                type="button"
                onClick={() => handleJump(null)}
                style={{
                  border: "1px solid var(--line)",
                  background: "var(--card-hi)",
                  padding: "6px 10px",
                  borderRadius: "var(--r-2)",
                  fontSize: 12,
                  color: "var(--ink-2)",
                  cursor: "pointer",
                }}
              >
                {t("panel.back")}
              </button>

              <HumanHelpCard
                waHref={waHref}
                mailHref={mailHref}
                onSendTicket={onSendTicket}
                ticketState={ticketState}
              />
            </>
          ) : (
            <>
              <p style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 4 }}>
                {/* This promised "dotted-underline words anywhere on the page";
                    no page renders one (HelpTip has no call sites). */}
                {t("panel.intro")}
              </p>
              <HumanHelpCard
                waHref={waHref}
                mailHref={mailHref}
                onSendTicket={onSendTicket}
                ticketState={ticketState}
              />
              {HELP_GROUPS.map((g) => (
                <div key={g.id} style={{ marginTop: 16 }}>
                  <div
                    style={{
                      fontSize: 10,
                      color: "var(--ink-3)",
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                      marginBottom: 4,
                    }}
                  >
                    {t(`groups.${g.id}`)}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    {g.keys.map((k) =>
                      HELP[k] ? (
                        <button
                          key={k}
                          type="button"
                          data-help-row
                          onClick={() => handleJump(k)}
                          style={{
                            display: "block",
                            textAlign: "left",
                            width: "100%",
                            padding: "6px 8px",
                            border: "1px solid transparent",
                            background: "transparent",
                            borderRadius: "var(--r-2)",
                            cursor: "pointer",
                            color: "var(--ink)",
                          }}
                        >
                          <div style={{ fontSize: 12.5, fontWeight: 500 }}>{textOf(k).title}</div>
                          <div style={{ fontSize: 11.5, color: "var(--ink-3)", lineHeight: 1.4 }}>
                            {textOf(k).short}
                          </div>
                        </button>
                      ) : null,
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        <footer
          style={{
            padding: "10px 16px",
            borderTop: "1px solid var(--line)",
            fontSize: 11,
            color: "var(--ink-3)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>
            {t.rich("panel.shortcut", {
              kbd: (chunks) => (
                <kbd
                  style={{
                    padding: "1px 6px",
                    border: "1px solid var(--line)",
                    borderRadius: 4,
                    background: "var(--card-hi)",
                    fontFamily: "var(--mono, monospace)",
                    fontSize: 10,
                  }}
                >
                  {chunks}
                </kbd>
              ),
            })}
          </span>
        </footer>
      </aside>
    </>
  );
}

// ── "Talk to a person" card ──────────────────────────────────────────────────
// Three real, wired buttons. The prototype's stubs (help.jsx lines 641-655) are
// replaced with: a wa.me deep-link with a pre-filled context message; a mailto
// link with the page slug in the subject; and a POST to /api/helpdesk/tickets
// that drops a notification on programme_admin role users.

function HumanHelpCard({
  waHref,
  mailHref,
  onSendTicket,
  ticketState,
}: {
  waHref: string | null;
  mailHref: string | null;
  onSendTicket: () => void | Promise<void>;
  ticketState: "idle" | "sending" | "sent" | "error";
}) {
  const t = useTranslations("help.client.human");
  return (
    <div
      data-help-human
      style={{
        background: "var(--lichen-soft, var(--card-hi))",
        border: "1px solid var(--line)",
        borderRadius: "var(--r-3, 8px)",
        padding: 14,
        marginTop: 18,
        display: "grid",
        gap: 8,
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 13 }}>{t("title")}</div>
      <div style={{ fontSize: 12, color: "var(--ink-2)", lineHeight: 1.5 }}>
        {t("body")}
      </div>
      <div style={{ display: "grid", gap: 6, marginTop: 4 }}>
        {/* Spec 169 — when assertEnv() rejected GML_HELPDESK_PHONE the
            WhatsApp row is HIDDEN, not rendered as a disabled stub. A
            misconfigured deep-link is worse than no link: it would
            launch WhatsApp into a broken state with no recourse. The
            email and in-app helpdesk-ticket paths remain available. */}
        {waHref ? (
          <a
            href={waHref}
            target="_blank"
            rel="noopener noreferrer"
            data-help-action="whatsapp"
            style={btnStyle}
          >
            {t("whatsapp")}
          </a>
        ) : null}
        {mailHref ? (
          <a href={mailHref} data-help-action="email" style={btnStyle}>
            {t("email")}
          </a>
        ) : (
          <button type="button" disabled style={{ ...btnStyle, opacity: 0.6 }} data-help-action="email-disabled">
            {t("emailMissing")}
          </button>
        )}
        <button
          type="button"
          onClick={() => void onSendTicket()}
          disabled={ticketState === "sending" || ticketState === "sent"}
          data-help-action="ticket"
          style={{ ...btnStyle, opacity: ticketState === "sending" ? 0.6 : 1 }}
        >
          {ticketState === "sent"
            ? t("ticketSent")
            : ticketState === "sending"
              ? t("ticketSending")
              : ticketState === "error"
                ? t("ticketRetry")
                : t("ticketOpen")}
        </button>
      </div>
    </div>
  );
}

const btnStyle = {
  display: "block",
  textAlign: "left" as const,
  padding: "8px 10px",
  border: "1px solid var(--line)",
  background: "var(--paper)",
  borderRadius: "var(--r-2, 6px)",
  fontSize: 12.5,
  color: "var(--ink)",
  cursor: "pointer",
  textDecoration: "none" as const,
};
