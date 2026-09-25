// Clearing the "must change password" flag once its holder has chosen their own
// password. See lib/password-policy.ts for what the flag is and who sets it.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MUST_CHANGE_PASSWORD } from "@/lib/password-policy";
import { supabaseAdmin } from "@/lib/supabase/server";

/**
 * Clear the flag for `userId`, then re-mint `session`'s access token so the
 * browser that just changed the password stops carrying it (proxy.ts reads
 * the claim, not the database). Never throws: a failure leaves the person sent
 * to /settings again, where changing the password retries this.
 */
export async function clearMustChangePassword(userId: string, session: SupabaseClient): Promise<void> {
  try {
    // A null value deletes the key: GoTrue merges app_metadata key by key.
    const { error } = await supabaseAdmin().auth.admin.updateUserById(userId, {
      app_metadata: { [MUST_CHANGE_PASSWORD]: null },
    });
    if (error) throw error;
    await session.auth.refreshSession();
  } catch (err) {
    console.error(`[auth] could not clear ${MUST_CHANGE_PASSWORD} for ${userId}:`, err);
  }
}
