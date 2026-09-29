"use client";

// A form field that holds an uploaded PDF's Storage key (resources.fileKey;
// admin/types.ts `upload: "pdf"`). Choosing a file uploads it at once to
// /api/admin/data/<slug>/upload, and the key the route answers goes into a
// hidden input of the field's name -- so the row form posts exactly what it
// posted when the key was typed, and the create or update validates and
// audits it as before. Nothing is written to the row until the form is saved.
//
// Words: adminData.client.pdfUpload, with each refusal the route can answer
// said in the user's language.

import { useState, type ChangeEvent } from "react";
import { useTranslations } from "next-intl";

/** The refusals the upload route answers with their own words. */
const KNOWN_ERRORS = ["not_pdf", "too_large", "no_file", "truncated", "storage", "forbidden"] as const;

type Props = {
  entitySlug: string;
  field: string;
  /** The stored key, or what a refused save posted back. */
  initial: string;
  invalid?: boolean;
};

export function PdfUploadField({ entitySlug, field, initial, invalid = false }: Props) {
  const t = useTranslations("adminData.client");
  const [fileKey, setFileKey] = useState(initial);
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "done" | "removed" | "error"; text?: string }>({
    kind: "idle",
  });

  const errorText = (code: unknown, maxBytes?: unknown): string => {
    const known = (KNOWN_ERRORS as readonly unknown[]).includes(code) ? (code as string) : "unknown";
    const mb = typeof maxBytes === "number" ? Math.floor(maxBytes / 1024 / 1024) : 9;
    return t(`pdfUpload.errors.${known}`, { mb });
  };

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setStatus({ kind: "busy" });
    const body = new FormData();
    body.set("file", file, file.name);
    try {
      const res = await fetch(`/api/admin/data/${encodeURIComponent(entitySlug)}/upload?field=${encodeURIComponent(field)}`, {
        method: "POST",
        body,
      });
      const json = (await res.json().catch(() => ({}))) as { fileKey?: string; error?: string; maxBytes?: number };
      if (res.ok && typeof json.fileKey === "string") {
        setFileKey(json.fileKey);
        setStatus({ kind: "done", text: t("pdfUpload.uploaded", { name: file.name }) });
      } else {
        setStatus({ kind: "error", text: errorText(res.status === 403 && !json.error ? "forbidden" : json.error, json.maxBytes) });
      }
    } catch {
      setStatus({ kind: "error", text: errorText("unknown") });
    }
    // The same file can be chosen again after a refusal.
    event.target.value = "";
  };

  const remove = () => {
    setFileKey("");
    setStatus({ kind: "removed", text: t("pdfUpload.removed") });
  };

  return (
    <span className="flex flex-col gap-1" data-pdf-upload={field}>
      <input type="hidden" name={field} value={fileKey} />
      {fileKey && status.kind === "idle" ? (
        <span className="text-[11px] text-neutral-600">{t("pdfUpload.current")}</span>
      ) : null}
      <input
        type="file"
        accept="application/pdf,.pdf"
        aria-label={t("pdfUpload.choose")}
        aria-invalid={invalid ? "true" : undefined}
        disabled={status.kind === "busy"}
        onChange={upload}
        className="w-full max-w-full text-xs file:mr-2 file:rounded-md file:border file:border-neutral-300 file:bg-white file:px-2 file:py-1"
      />
      {status.kind === "busy" ? <span className="text-[11px] text-neutral-500">{t("pdfUpload.uploading")}</span> : null}
      {status.kind === "done" || status.kind === "removed" ? (
        <span className="text-[11px] text-emerald-700" role="status">
          {status.text}
        </span>
      ) : null}
      {status.kind === "error" ? (
        <span className="text-[11px] text-red-700" role="alert">
          {status.text}
        </span>
      ) : null}
      {fileKey ? (
        <button type="button" onClick={remove} className="self-start text-[11px] text-red-700 hover:underline">
          {t("pdfUpload.remove")}
        </button>
      ) : null}
    </span>
  );
}
