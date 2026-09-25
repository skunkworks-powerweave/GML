// Confirming a finished upload with the server, from the browser.
//
// Shared by the desktop tray (components/video/UploadProgress.tsx) and the
// mobile runner (components/video/MobileUploadRunner.tsx), which both called
// `void completeUploadAction(...).then(...)` with no .catch. A dropped
// connection on that last small POST -- easy on 2G after an hours-long
// transfer -- was an unhandled rejection: the tray said "transcoding" forever
// and the runner sat at 100%, with no error, no retry, and the completion never
// re-sent. The bytes are already in Storage at that point, so the right answer
// is to ask again, never to upload again: completeUpload is idempotent on the
// submission id.
//
// Retried: a rejected call (the network) and an answer marked `retryable`
// (Storage did not answer). Not retried: any other {ok:false}, which is the
// server's definitive verdict on the upload.

export const CONFIRM_RETRY_DELAYS_MS = [2_000, 5_000, 15_000];

export const UNCONFIRMED_MESSAGE =
  "Your video is uploaded, but we could not confirm it with the server. Check your connection and tap Retry; it will not upload again.";

export type CompleteAnswer = { ok: boolean; error?: string; retryable?: boolean };
export type ConfirmResult = { ok: true } | { ok: false; error: string; retryable: boolean };

export async function confirmUpload(
  complete: () => Promise<CompleteAnswer>,
  delaysMs: readonly number[] = CONFIRM_RETRY_DELAYS_MS,
): Promise<ConfirmResult> {
  for (let attempt = 0; ; attempt++) {
    let answer: CompleteAnswer | null;
    try {
      answer = await complete();
    } catch {
      answer = null;
    }
    if (answer?.ok) return { ok: true };
    if (answer && !answer.retryable) {
      return { ok: false, error: answer.error ?? "Upload could not be confirmed.", retryable: false };
    }
    if (attempt >= delaysMs.length) {
      return { ok: false, error: UNCONFIRMED_MESSAGE, retryable: true };
    }
    await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
  }
}
