// SM-6 enforcement: every protected route renders this footer.
// Frontend prototype declares the policy on multiple pages — we centralize it.
// The watermark variant (user · timestamp) is added by HlsPlayer + PDFViewer
// when they ship; this footer is the document-level disclosure.
//
// In the user's language (home.chrome.footer.*): the notice and the "Viewed by"
// stamp are one message each, so a language that puts the name elsewhere can.

import { getTranslations } from "next-intl/server";

type FooterProps = {
  user?: { name?: string | null; email?: string | null } | null;
  compact?: boolean;
};

export async function ConfidentialityFooter({ user, compact = false }: FooterProps) {
  const t = await getTranslations("home.chrome.footer");
  const stamp = user?.name ?? user?.email ?? t("anonymous");
  const tags = {
    strong: (chunks: React.ReactNode) => <strong style={{ color: "var(--ink-2)", fontWeight: 600 }}>{chunks}</strong>,
    code: (chunks: React.ReactNode) => <code style={{ fontFamily: "var(--mono)" }}>{chunks}</code>,
  };
  return (
    <footer
      style={{
        padding: compact ? "10px 16px" : "14px 28px 18px",
        borderTop: "1px solid var(--line)",
        background: "var(--paper)",
        fontSize: 10,
        color: "var(--ink-3)",
        lineHeight: 1.5,
      }}
    >
      {compact ? t.rich("compact", tags) : t.rich("full", { ...tags, stamp })}
    </footer>
  );
}
