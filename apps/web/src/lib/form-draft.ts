// Spec 072 — Client-side helpers for the form-draft autosave pipeline.
//
// All three helpers wrap the `/api/form-drafts/[id]` route. Exactly one of
// `templateId` / `observationCycleId` must be set; we throw synchronously on
// mis-use because that's a programmer error, not a runtime condition.

export type DraftKey = {
  templateId?: string;
  observationCycleId?: string;
  /**
   * The mentorship pairing a template draft is about. A mentor fills the same
   * form once per mentee, and a draft keyed by template alone was shared by all
   * of them. Ignored for an observation-cycle draft.
   */
  pairingId?: string | null;
};

type ScopedKey = { scope: "template" | "cycle"; id: string; pairingId?: string };

function resolveScope(key: DraftKey): ScopedKey {
  const hasTemplate = typeof key.templateId === "string" && key.templateId.length > 0;
  const hasCycle = typeof key.observationCycleId === "string" && key.observationCycleId.length > 0;
  if (hasTemplate === hasCycle) {
    throw new Error(
      "form-draft: exactly one of { templateId, observationCycleId } must be set — got " +
        JSON.stringify({ hasTemplate, hasCycle }),
    );
  }
  return hasTemplate
    ? { scope: "template", id: key.templateId as string, pairingId: key.pairingId || undefined }
    : { scope: "cycle", id: key.observationCycleId as string };
}

function url(scoped: ScopedKey): string {
  const pairing = scoped.pairingId ? `&pairingId=${encodeURIComponent(scoped.pairingId)}` : "";
  return `/api/form-drafts/${encodeURIComponent(scoped.id)}?scope=${scoped.scope}${pairing}`;
}

/**
 * Returns the draft's `responses` jsonb, or `null` if no draft exists. Throws
 * on network failure or non-2xx server response.
 */
export async function loadDraft(key: DraftKey): Promise<Record<string, unknown> | null> {
  const scoped = resolveScope(key);
  const res = await fetch(url(scoped), { method: "GET", credentials: "same-origin" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`loadDraft: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { responses?: Record<string, unknown> | null };
  return body.responses ?? null;
}

/**
 * Persists the current responses. Caller is responsible for debouncing — this
 * helper always issues a network round-trip. Resolves on 2xx; rejects with a
 * descriptive Error on non-2xx so the renderer can flip its indicator to
 * "Save failed — retrying".
 */
export async function saveDraft(
  args: DraftKey & { responses: Record<string, unknown> },
): Promise<void> {
  const scoped = resolveScope(args);
  const res = await fetch(url(scoped), {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ responses: args.responses }),
  });
  if (!res.ok) {
    // The status travels with the error: the runners retry a 5xx, but not a
    // 401 (session expired) or a 403 (section locked), which repeating cannot
    // fix. A network failure rejects from fetch() itself, with no status.
    throw Object.assign(new Error(`saveDraft: ${res.status} ${await res.text()}`), { status: res.status });
  }
}

/**
 * Removes the draft. Called from the renderer after a successful final
 * submit. Idempotent: 404 is treated as success because the row is already
 * gone.
 */
export async function clearDraft(key: DraftKey): Promise<void> {
  const scoped = resolveScope(key);
  const res = await fetch(url(scoped), { method: "DELETE", credentials: "same-origin" });
  if (!res.ok && res.status !== 404) {
    throw new Error(`clearDraft: ${res.status} ${await res.text()}`);
  }
}
