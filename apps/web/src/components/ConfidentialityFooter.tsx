// SM-6 enforcement: every protected route renders this footer.
// Frontend prototype declares the policy on multiple pages — we centralize it.
// The watermark variant (user · timestamp) is added by HlsPlayer + PDFViewer
// when they ship; this footer is the document-level disclosure.

type FooterProps = {
  user?: { name?: string | null; email?: string | null } | null;
  compact?: boolean;
};

export function ConfidentialityFooter({ user, compact = false }: FooterProps) {
  const stamp = user?.name ?? user?.email ?? "anonymous";
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
      <strong style={{ color: "var(--ink-2)", fontWeight: 600 }}>Confidential.</strong>{" "}
      All materials on this platform are for internal programme use only. Unauthorized sharing, copying, or distribution is not permitted.
      {!compact ? <> Viewed by <code style={{ fontFamily: "var(--mono)" }}>{stamp}</code>.</> : null}
    </footer>
  );
}
