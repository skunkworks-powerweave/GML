"use server";

// Upload lifecycle server actions.
//
// Two calls bracket a direct upload: `beginUploadAction` reserves the rows and
// hands back an object key, and `completeUploadAction` verifies the bytes
// actually landed before anything is queued. Everything in between happens
// between the browser and Supabase Storage.

import { auth } from "@/auth";
import { actorFrom, assertCanAccessCycle, assertCanAccessPairing } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { hasAnyRole } from "@gml/shared/auth/roles";
import { beginUpload, completeUpload, type UploadContextType } from "@/lib/video/upload";
import { enqueueTranscode } from "@/lib/queue";
import type { SupabaseBrowserConfig } from "@/lib/supabase/browser";

const CONTEXT_TYPES: ReadonlySet<string> = new Set([
  "observation_cycle",
  "teach_back",
  "mentor_meeting",
  "mentee_quarterly",
  "classroom_session",
  "generic",
]);

export type BeginUploadState =
  | {
      ok: true;
      submissionId: string;
      bucket: string;
      objectKey: string;
      chunkBytes: number;
      /**
       * The browser needs the project URL and the publishable key to talk to
       * Storage directly, and it CANNOT read them from process.env: NEXT_PUBLIC_*
       * is inlined at build time and the app image is built with only
       * DATABASE_URL. So they ride back on this response instead, read here at
       * request time where the real environment is visible. See
       * lib/supabase/browser.ts.
       */
      supabase: SupabaseBrowserConfig;
    }
  | { ok: false; error: string };

/**
 * Check that this user may attach a video to this context BEFORE reserving
 * anything.
 *
 * contextId arrives from the browser and is attacker-chosen. Without this, a
 * teacher could attach their upload to another teacher's observation cycle --
 * which is not a read of someone else's data but a WRITE into it, and would
 * then appear in that cycle's evidence.
 */
async function assertContextAllowed(
  actor: NonNullable<ReturnType<typeof actorFrom>>,
  contextType: UploadContextType,
  contextId: string | null,
): Promise<string | null> {
  if (contextType === "generic" || !contextId) return null;

  switch (contextType) {
    case "observation_cycle":
      // Throws notFound() when the actor has no business here.
      await assertCanAccessCycle(actor, contextId);
      return null;
    case "mentor_meeting":
    case "mentee_quarterly": {
      // These carry a pairing id.
      await assertCanAccessPairing(actor, contextId);
      return null;
    }
    case "teach_back":
    case "classroom_session":
      // Not scoped to a per-row owner: a teach-back is the uploader's own work,
      // and a classroom session is programme-wide reference data. The
      // submission still records who uploaded it.
      return null;
    default:
      return "Unknown upload context.";
  }
}

export async function beginUploadAction(input: {
  filename: string;
  sizeBytes: number;
  contentType: string;
  contextType: string;
  contextId?: string | null;
}): Promise<BeginUploadState> {
  const session = await auth();
  const actor = actorFrom(session);
  if (!actor || !session) return { ok: false, error: "Please sign in again." };

  // Checked BEFORE any row is reserved. A misconfigured deployment should say
  // so on the first click rather than leaving a trail of `uploading` rows that
  // the reconciler has to fail 30 minutes later.
  const supabaseConfig = browserSupabaseConfig();
  if (!supabaseConfig) {
    return {
      ok: false,
      error: "Uploads are not configured on this deployment. Please contact your administrator.",
    };
  }

  if (!CONTEXT_TYPES.has(input.contextType)) {
    return { ok: false, error: "Unknown upload context." };
  }
  const contextType = input.contextType as UploadContextType;
  const contextId = input.contextId?.trim() || null;

  const denied = await assertContextAllowed(actor, contextType, contextId);
  if (denied) return { ok: false, error: denied };

  const result = await beginUpload({
    userId: session.user.id,
    filename: input.filename,
    sizeBytes: input.sizeBytes,
    contentType: input.contentType,
    contextType,
    contextId,
  });
  if ("error" in result) return { ok: false, error: result.error };

  void recordAudit({
    action: "video.upload.begin",
    entityType: "video_submission",
    entityId: result.submissionId,
    metadata: {
      contextType,
      contextId,
      sizeBytes: input.sizeBytes,
      // Filename only, never the object key: the key embeds the uploader's uuid
      // and the audit log is readable by every administrator.
      filename: input.filename.slice(0, 120),
    },
  });

  return { ok: true, ...result, supabase: supabaseConfig };
}

/**
 * The two public Supabase values, read server-side at request time.
 *
 * Returns null rather than throwing when either is missing, so a misconfigured
 * deployment produces one clear sentence in the UI instead of an unhandled
 * server-action rejection.
 */
function browserSupabaseConfig(): SupabaseBrowserConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  return url && anonKey ? { url, anonKey } : null;
}

export type CompleteUploadState = { ok: boolean; error?: string };

export async function completeUploadAction(submissionId: string): Promise<CompleteUploadState> {
  const session = await auth();
  if (!session) return { ok: false, error: "Please sign in again." };

  const result = await completeUpload({
    submissionId,
    userId: session.user.id,
    isAdmin: hasAnyRole(session.user.role, ["programme_admin", "super_admin"]),
    enqueue: enqueueTranscode,
  });

  if (!result.ok) {
    const message =
      result.error === "object_missing"
        ? "We could not find the uploaded file. Please try again."
        : result.error === "object_truncated"
          ? "The upload finished early and is incomplete. Please try again."
          : "That upload could not be found.";
    return { ok: false, error: message };
  }

  void recordAudit({
    action: "video.upload.complete",
    entityType: "video_submission",
    entityId: submissionId,
  });

  return { ok: true };
}
