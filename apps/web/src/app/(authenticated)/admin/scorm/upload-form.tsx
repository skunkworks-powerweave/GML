"use client";

// Upload a SCORM 1.2 package (super_admin only; the page does not render
// this for anyone else, and the route refuses them regardless).
//
// It posts to /api/scorm/packages rather than a server action: a package can
// be 20 MB, a server action's body is capped at 1 MB, and proxy.ts would
// truncate anything past 10 MB (see the route). The limit is checked here
// first, so an oversized file is refused before minutes of uploading on a
// slow link, and the server's refusal -- which names the offending files --
// is shown as it came.
//
// The limit arrives as a prop: lib/scorm/package.ts reads zip archives with
// node:zlib and must not be pulled into the browser bundle.
//
// Words: adminData.client.scormUpload, in the viewer's language. A refusal the
// server explains is shown as the server wrote it.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

export type UploadOutcome = { ok: true; id: string } | { ok: false; message: string; paths?: string[] };

/** A translator over adminData.client.scormUpload (the form's useTranslations). */
export type UploadText = (key: "tooLarge" | "offline" | "refused", values: Record<string, string | number>) => string;

export async function sendScormUpload(
  form: FormData,
  opts: { maxBytes: number; text: UploadText; fetch?: (url: string, init: RequestInit) => Promise<Response> },
): Promise<UploadOutcome> {
  const file = form.get("file");
  if (file instanceof Blob && file.size > opts.maxBytes) {
    return { ok: false, message: opts.text("tooLarge", { mb: opts.maxBytes / 1024 / 1024 }) };
  }
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)("/api/scorm/packages", { method: "POST", body: form, credentials: "same-origin" });
  } catch {
    return { ok: false, message: opts.text("offline", {}) };
  }
  const body = (await res.json().catch(() => null)) as { id?: string; error?: { message?: string; paths?: string[] } | string } | null;
  if (res.status === 201 && body?.id) return { ok: true, id: body.id };
  const error = typeof body?.error === "object" ? body.error : null;
  return {
    ok: false,
    message: error?.message ?? opts.text("refused", { status: String(res.status) }),
    ...(error?.paths?.length ? { paths: error.paths } : {}),
  };
}

export function UploadScormForm({ subjects, maxBytes }: { subjects: Array<{ id: string; label: string }>; maxBytes: number }) {
  const router = useRouter();
  const t = useTranslations("adminData.client");
  const text: UploadText = (key, values) => t(`scormUpload.${key}`, values);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<{ message: string; paths?: string[] } | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSending(true);
    setProblem(null);
    const outcome = await sendScormUpload(new FormData(e.currentTarget), { maxBytes, text });
    if (outcome.ok) {
      router.push(`/admin/scorm/${outcome.id}`);
      return;
    }
    setSending(false);
    setProblem(outcome);
  }

  return (
    <form onSubmit={onSubmit} className="card card-hi" style={{ padding: 14, display: "grid", gap: 10, maxWidth: 640 }}>
      <div style={{ fontWeight: 600, fontSize: 13 }}>{t("scormUpload.heading")}</div>
      <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
        {t("scormUpload.subject")}
        <select name="rttSubjectId" required defaultValue="">
          <option value="" disabled>
            {t("scormUpload.chooseSubject")}
          </option>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
        {t("scormUpload.file", { mb: maxBytes / 1024 / 1024 })}
        <input type="file" name="file" accept=".zip,application/zip" required />
      </label>
      <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
        {t("scormUpload.titleLabel")}
        <input type="text" name="title" maxLength={240} />
      </label>
      <div>
        <button type="submit" className="btn btn-sm btn-primary" disabled={sending}>
          {sending ? t("scormUpload.sending") : t("scormUpload.submit")}
        </button>
      </div>
      {problem ? (
        <div role="alert" style={{ fontSize: 12, color: "var(--rust)" }}>
          {problem.message}
          {problem.paths ? (
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
              {problem.paths.map((p) => (
                <li key={p}>
                  <code>{p}</code>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
