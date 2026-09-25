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

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export type UploadOutcome = { ok: true; id: string } | { ok: false; message: string; paths?: string[] };

export async function sendScormUpload(
  form: FormData,
  opts: { maxBytes: number; fetch?: (url: string, init: RequestInit) => Promise<Response> },
): Promise<UploadOutcome> {
  const file = form.get("file");
  if (file instanceof Blob && file.size > opts.maxBytes) {
    return { ok: false, message: `This file is larger than ${opts.maxBytes / 1024 / 1024} MB, the most a package can be.` };
  }
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)("/api/scorm/packages", { method: "POST", body: form, credentials: "same-origin" });
  } catch {
    return { ok: false, message: "The upload did not reach the server. Check the connection and try again." };
  }
  const body = (await res.json().catch(() => null)) as { id?: string; error?: { message?: string; paths?: string[] } | string } | null;
  if (res.status === 201 && body?.id) return { ok: true, id: body.id };
  const error = typeof body?.error === "object" ? body.error : null;
  return {
    ok: false,
    message: error?.message ?? `The upload was refused (HTTP ${res.status}).`,
    ...(error?.paths?.length ? { paths: error.paths } : {}),
  };
}

export function UploadScormForm({ subjects, maxBytes }: { subjects: Array<{ id: string; label: string }>; maxBytes: number }) {
  const router = useRouter();
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<{ message: string; paths?: string[] } | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSending(true);
    setProblem(null);
    const outcome = await sendScormUpload(new FormData(e.currentTarget), { maxBytes });
    if (outcome.ok) {
      router.push(`/admin/scorm/${outcome.id}`);
      return;
    }
    setSending(false);
    setProblem(outcome);
  }

  return (
    <form onSubmit={onSubmit} className="card card-hi" style={{ padding: 14, display: "grid", gap: 10, maxWidth: 640 }}>
      <div style={{ fontWeight: 600, fontSize: 13 }}>Upload a package</div>
      <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
        RTT subject
        <select name="rttSubjectId" required defaultValue="">
          <option value="" disabled>
            Choose the subject it belongs to
          </option>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
        {`SCORM 1.2 package (.zip, one SCO, up to ${maxBytes / 1024 / 1024} MB)`}
        <input type="file" name="file" accept=".zip,application/zip" required />
      </label>
      <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
        Title (optional; the package&apos;s own title otherwise)
        <input type="text" name="title" maxLength={240} />
      </label>
      <div>
        <button type="submit" className="btn btn-sm btn-primary" disabled={sending}>
          {sending ? "Uploading and checking…" : "Upload package"}
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
