"use server";

// Upload lifecycle server actions.
//
// Two calls bracket a direct upload: `beginUploadAction` reserves the rows and
// hands back an object key, and `completeUploadAction` verifies the bytes
// actually landed before anything is queued. Everything in between happens
// between the browser and Supabase Storage.

import { auth } from "@/auth";
import { actorFrom } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { hasAnyRole } from "@gml/shared/auth/roles";
import { beginUpload, completeUpload } from "@/lib/video/upload";
import type { SupabaseBrowserConfig } from "@/lib/supabase/browser";
import { assertContextAllowed } from "./context";

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

export async function beginUploadAction(input: {
  filename: string;
  sizeBytes: number;
  contentType: string;
  contextType: string;
  contextId?: string | null;
  /** 1 or 4, for a mentee's quarterly video; nothing else takes one. */
  quarter?: number | null;
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

  // Who may attach to what, and what each context id means: ./context.ts.
  // Throws notFound() for a target this user may not see.
  const allowed = await assertContextAllowed(actor, {
    contextType: input.contextType,
    contextId: input.contextId,
    quarter: input.quarter,
  });
  if (!allowed.ok) return { ok: false, error: allowed.error };
  const { contextType, contextId, quarter } = allowed.target;

  const result = await beginUpload({
    userId: session.user.id,
    filename: input.filename,
    sizeBytes: input.sizeBytes,
    contentType: input.contentType,
    contextType,
    contextId,
    contextQuarter: quarter,
  });
  if ("error" in result) return { ok: false, error: result.error };

  void recordAudit({
    action: "video.upload.begin",
    entityType: "video_submission",
    entityId: result.submissionId,
    metadata: {
      contextType,
      contextId,
      quarter,
      sizeBytes: input.sizeBytes,
      // A picked-again file continues its earlier reservation (beginUpload).
      resumed: result.resumed,
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

/** `retryable`: the file is stored; asking again later can still confirm it. */
export type CompleteUploadState = { ok: boolean; error?: string; retryable?: boolean };

export async function completeUploadAction(
  submissionId: string,
  // The uploader's note. Stored on the observation_evidence row, which is what
  // the observer reads on the cycle page.
  caption?: string,
): Promise<CompleteUploadState> {
  const session = await auth();
  if (!session) return { ok: false, error: "Please sign in again." };

  const result = await completeUpload({
    submissionId,
    userId: session.user.id,
    isAdmin: hasAnyRole(session.user.role, ["programme_admin", "super_admin"]),
    caption,
  });

  if (!result.ok) {
    if (result.error === "storage_unavailable") {
      return { ok: false, error: "Storage did not answer. Your video is uploaded; try confirming it again.", retryable: true };
    }
    const message =
      result.error === "object_missing"
        ? "We could not find the uploaded file. Please try again."
        : result.error === "object_truncated"
          ? "The upload finished early and is incomplete. Please try again."
          : result.error === "object_too_large"
            ? "That file is larger than it was declared and was refused."
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
