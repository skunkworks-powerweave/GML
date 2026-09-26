"use client";

// Shown the moment a link is tapped, inside the shell, while the next page
// renders on the server. Every authenticated page is dynamic, and without a
// loading boundary Next neither prefetches their shells nor shows anything
// until the whole page has arrived: on 2G a tap looked like it did nothing,
// which invited repeat taps (FR-31).

import { useTranslations } from "next-intl";

export default function Loading() {
  const t = useTranslations("status");
  return (
    <div className="page-body" role="status" aria-live="polite" aria-busy="true">
      <p style={{ color: "var(--ink-3)", fontSize: 13 }}>{t("loading")}</p>
    </div>
  );
}
