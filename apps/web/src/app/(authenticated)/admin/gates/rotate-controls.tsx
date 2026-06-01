"use client";

// Spec 115 (Workflow Run 9 Tier A) — interactive controls for the
// /admin/gates surface. Wraps the "Rotate" button per row in a small client
// component that, on click:
//   1. POSTs to /api/admin/gates/<slug>/rotate
//   2. Renders the returned plaintext password in an inline reveal block
//      (NOT a separate modal component — the dialog is local to the row so
//      the rest of the table stays readable while the admin copies/shares)
//   3. Offers a "Copy" button that writes to navigator.clipboard
//   4. Offers a "Share via WhatsApp" button that POSTs to /share and then
//      window.open()s the returned wa.me URL
//
// Native confirm() guards both the rotate (destructive — invalidates every
// active grant for the slug) and the share (re-confirm before opening the
// WhatsApp tab). Matches the spec-114 ConfirmModal pattern.

import { useState, useTransition, type FormEvent } from "react";

type Recipient = { id: string; label: string };

type RotateResponse = { ok: true; plaintext: string; version: number };
type ShareResponse = { ok: true; url: string };

type Props = {
  slug: string;
  label: string;
  recipients: Recipient[];
};

export function RotateControls({ slug, label, recipients }: Props) {
  const [pending, startTransition] = useTransition();
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recipientId, setRecipientId] = useState<string>(
    recipients[0]?.id ?? "",
  );

  const handleRotate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = `Rotate the ${label} gate password? Every active grant will be invalidated and every user will need to re-unlock with the new password.`;
    if (typeof window !== "undefined" && !window.confirm(message)) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/admin/gates/${slug}/rotate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          setError(body.error ?? `Rotation failed (HTTP ${res.status}).`);
          return;
        }
        const data = (await res.json()) as RotateResponse;
        setPlaintext(data.plaintext);
        setVersion(data.version);
      } catch (err) {
        setError(`Rotation failed: ${(err as Error).message}`);
      }
    });
  };

  const handleCopy = async () => {
    if (!plaintext) return;
    try {
      await navigator.clipboard.writeText(plaintext);
    } catch {
      // Older browsers / clipboard permission denied — fall back to selection.
      const node = document.getElementById(`gate-plaintext-${slug}`);
      if (node) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
  };

  const handleShare = async () => {
    if (!plaintext || !recipientId) return;
    const recipient = recipients.find((r) => r.id === recipientId);
    if (!recipient) return;
    const confirmMsg = `Share the ${label} password with ${recipient.label} via WhatsApp? The plaintext will appear in both your WhatsApp history.`;
    if (typeof window !== "undefined" && !window.confirm(confirmMsg)) {
      return;
    }
    setError(null);
    try {
      const res = await fetch(`/api/admin/gates/${slug}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipientUserId: recipientId,
          channel: "whatsapp",
          plaintext,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Share failed (HTTP ${res.status}).`);
        return;
      }
      const data = (await res.json()) as ShareResponse;
      window.open(data.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(`Share failed: ${(err as Error).message}`);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <form onSubmit={handleRotate} className="inline">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium hover:border-neutral-500 disabled:opacity-50"
        >
          {pending ? "Rotating…" : "Rotate password"}
        </button>
      </form>

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800"
        >
          {error}
        </div>
      ) : null}

      {plaintext ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-amber-800">
            New password (v{version}) — shown ONCE
          </div>
          <div className="mt-2 flex items-center gap-2">
            <code
              id={`gate-plaintext-${slug}`}
              className="select-all rounded-md bg-white px-2 py-1 font-mono text-sm"
            >
              {plaintext}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs hover:border-neutral-500"
            >
              Copy
            </button>
          </div>
          {recipients.length > 0 ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <label className="flex items-center gap-2">
                <span className="text-neutral-600">Share with:</span>
                <select
                  value={recipientId}
                  onChange={(e) => setRecipientId(e.target.value)}
                  className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs"
                >
                  {recipients.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={handleShare}
                className="rounded-md border border-emerald-400 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100"
              >
                Share via WhatsApp
              </button>
            </div>
          ) : (
            <div className="mt-3 text-xs text-neutral-500">
              No staff with a phone number on file — share manually.
            </div>
          )}
          <p className="mt-3 text-xs text-neutral-600">
            The password is not stored anywhere we can show it again. Capture
            it now, then close this panel.
          </p>
        </div>
      ) : null}
    </div>
  );
}
