// A PDF uploaded from the admin grid's form, checked and stored where the PDF
// viewer reads it: the `pdfs` bucket (BUCKETS.pdfs), which /api/media/pdf/[id]
// streams to the watermarked viewer. The route is
// app/api/admin/data/[entity]/upload/route.ts; the form's picker is
// app/(authenticated)/admin/data/[entity]/pdf-upload-field.tsx.
//
// ── THE LIMIT ────────────────────────────────────────────────────────────────
//
// The bucket takes 50 MiB (migration _post/005) and Caddy 25 MB, but the
// request passes through proxy.ts, and Next buffers the body of any request
// proxy.ts runs on to 10 MiB and passes the TRUNCATED rest on without an error
// (see the matcher there, which exempts the SCORM upload for this reason). So
// a PDF may be at most 9 MiB here, the body is refused past that by its
// declared length, and a body that arrives cut short anyway is caught by the
// check that a PDF ends with its %%EOF marker. Raising the limit means adding
// this route to proxy.ts's exemptions.

import "server-only";
import { randomUUID } from "node:crypto";
import { storage, BUCKETS } from "@/lib/video/storage";

export const PDF_MAX_BYTES = 9 * 1024 * 1024;

/** The body: the PDF plus the multipart framing. */
export const PDF_MAX_BODY_BYTES = PDF_MAX_BYTES + 64 * 1024;

export type PdfRefusal = "no_file" | "too_large" | "not_pdf" | "truncated";

/**
 * Is this a whole PDF? It must begin with the `%PDF-` header -- the bucket
 * only takes application/pdf, and the viewer serves the object as one, so an
 * HTML file renamed .pdf must not get in -- and carry the `%%EOF` marker in
 * its last kilobyte (a PDF ends with one; incremental saves add more, the last
 * one at the end), which a body cut short by the proxy does not.
 */
export function checkPdf(bytes: Uint8Array): PdfRefusal | null {
  if (bytes.byteLength === 0) return "no_file";
  if (bytes.byteLength > PDF_MAX_BYTES) return "too_large";
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  if (!head.startsWith("%PDF-")) return "not_pdf";
  const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.byteLength - 1024))).toString("latin1");
  if (!tail.includes("%%EOF")) return "truncated";
  return null;
}

/**
 * Store the PDF under a new key and return the key. A new key per upload, so
 * replacing a resource's file never changes the bytes behind a key another
 * row, an export or an audit row already names. Throws on a Storage error.
 */
export async function storePdf(bytes: Uint8Array, folder: string): Promise<string> {
  const key = `${folder}/${randomUUID()}.pdf`;
  await storage.put(BUCKETS.pdfs, key, bytes, "application/pdf");
  return key;
}
