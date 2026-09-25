// Stands in for apps/web/src/lib/video/tus-upload.ts when the upload UI
// components are driven by tests/behaviour/upload-confirm.test.ts. The transfer
// itself is executed for real in direct-upload.test.ts; here it is the
// boundary: the bytes "land" at once and onSuccess fires, which is the moment
// the components must confirm the upload with the server.

import { uploadScript } from "./upload-actions.ts";

export type UploadHandle = { abort: () => void };

export async function startResumableUpload(opts: { onSuccess: () => void }): Promise<UploadHandle | null> {
  uploadScript().calls.push("tus");
  opts.onSuccess();
  return { abort: () => undefined };
}
