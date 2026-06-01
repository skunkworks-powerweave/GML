// MinIO S3-compatible client. Lazy-init, env-driven.
// Buckets:
//   - gml-videos-original  (kind='video_original')
//   - gml-videos-hls       (HLS master playlists + segments)
//   - gml-posters
//   - gml-pdfs             (resources, signed PDFs)
//
// Bucket policies are PRIVATE (no public access). All reads go through the
// signed-URL helper (signed-url.ts) and the /api/media/[token] proxy.

import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

let _client: S3Client | null = null;

export function getMinio(): S3Client {
  if (_client) return _client;
  const endpoint = process.env.MINIO_ENDPOINT ?? "http://minio:9000";
  const accessKeyId = process.env.MINIO_ROOT_USER ?? "minioadmin";
  const secretAccessKey = process.env.MINIO_ROOT_PASSWORD ?? "minioadmin";
  _client = new S3Client({
    endpoint,
    region: "us-east-1", // MinIO ignores; required by SDK
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true, // MinIO requires path-style
  });
  return _client;
}

export const BUCKETS = {
  videosOriginal: "gml-videos-original",
  videosHls: "gml-videos-hls",
  posters: "gml-posters",
  pdfs: "gml-pdfs",
} as const;

/** Stream an object to a Buffer. Used by API routes that proxy MinIO content. */
export async function fetchObject(bucket: string, objectKey: string): Promise<{ body: ReadableStream<Uint8Array>; contentType?: string }> {
  const r = await getMinio().send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
  if (!r.Body) throw new Error(`object ${bucket}/${objectKey} has no body`);
  return { body: r.Body.transformToWebStream(), contentType: r.ContentType };
}

/** Upload an object (used by the WhatsApp webhook + transcode worker). */
export async function putObject(bucket: string, objectKey: string, body: Buffer | Uint8Array, contentType: string): Promise<void> {
  await getMinio().send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: body, ContentType: contentType }));
}

/** Object exists check (used by SM-3 deletion guard). */
export async function objectExists(bucket: string, objectKey: string): Promise<boolean> {
  try {
    await getMinio().send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
    return true;
  } catch {
    return false;
  }
}
