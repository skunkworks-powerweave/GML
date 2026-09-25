// A fake Supabase Storage, in-process: the handful of HTTP calls the worker
// and apps/web's buildSignedPlaylist make, answered from memory.
//
// It exists so a transcode can run END TO END in a test -- the real worker
// downloading a real source, a real ffmpeg, the real uploads, the real rows --
// without a Supabase project. The routes are the ones @supabase/storage-js
// 2.x calls (sign, signed GET, upload, download, list, sign-many), with the
// response shapes it parses; nothing else is implemented, so a new call shows
// up as a 404 here rather than passing silently.

import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export type StoredObject = { body: Buffer; contentType: string };

export type FakeStorage = {
  /** What to give the worker as NEXT_PUBLIC_SUPABASE_URL. */
  url: string;
  put(bucket: string, key: string, body: Buffer, contentType?: string): void;
  get(bucket: string, key: string): StoredObject | undefined;
  /** Every key in a bucket under a prefix, sorted. */
  keys(bucket: string, prefix?: string): string[];
  close(): Promise<void>;
};

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function startFakeStorage(): Promise<FakeStorage> {
  const objects = new Map<string, StoredObject>();
  const id = (bucket: string, key: string) => `${bucket}/${key}`;

  const server = createServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const notFound = () => json(400, { statusCode: "404", error: "not_found", message: "Object not found" });
    const u = new URL(req.url ?? "/", "http://fake");
    const parts = u.pathname.replace(/^\/storage\/v1\//, "").split("/").map(decodeURIComponent);
    const body = await readBody(req);

    // POST object/sign/<bucket>            sign many: { paths, expiresIn }
    // POST object/sign/<bucket>/<key...>   sign one
    // GET  object/sign/<bucket>/<key...>   the signed URL itself
    if (parts[0] === "object" && parts[1] === "sign") {
      const bucket = parts[2]!;
      const key = parts.slice(3).join("/");
      if (req.method === "POST" && key === "") {
        const { paths } = JSON.parse(body.toString() || "{}") as { paths: string[] };
        return json(
          200,
          paths.map((p) =>
            objects.has(id(bucket, p))
              ? { path: p, signedURL: `/object/sign/${bucket}/${p}?token=fake`, error: null }
              : { path: p, signedURL: null, error: "Object not found" },
          ),
        );
      }
      const obj = objects.get(id(bucket, key));
      if (!obj) return notFound();
      if (req.method === "POST") return json(200, { signedURL: `/object/sign/${bucket}/${key}?token=fake` });
      res.writeHead(200, { "content-type": obj.contentType, "content-length": obj.body.length });
      return res.end(obj.body);
    }

    // POST object/list/<bucket>  { prefix, search, limit }
    if (parts[0] === "object" && parts[1] === "list" && req.method === "POST") {
      const bucket = parts[2]!;
      const { prefix = "", search = "" } = JSON.parse(body.toString() || "{}") as { prefix?: string; search?: string };
      const dir = prefix ? `${prefix.replace(/\/$/, "")}/` : "";
      const names = new Set<string>();
      for (const k of objects.keys()) {
        if (!k.startsWith(`${bucket}/${dir}`)) continue;
        const rest = k.slice(bucket.length + 1 + dir.length);
        if (!rest.includes("/") && rest.includes(search)) names.add(rest);
      }
      return json(
        200,
        [...names].sort().map((name) => {
          const o = objects.get(id(bucket, dir + name))!;
          return { name, id: name, metadata: { size: o.body.length, mimetype: o.contentType } };
        }),
      );
    }

    // POST|PUT object/<bucket>/<key...>  upload     GET  download
    // DELETE object/<bucket>             remove { prefixes }
    if (parts[0] === "object") {
      const bucket = parts[1]!;
      const key = parts.slice(2).join("/");
      if ((req.method === "POST" || req.method === "PUT") && key) {
        objects.set(id(bucket, key), {
          body,
          contentType: String(req.headers["content-type"] ?? "application/octet-stream"),
        });
        return json(200, { Key: id(bucket, key), Id: key });
      }
      if (req.method === "GET" && key) {
        const obj = objects.get(id(bucket, key));
        if (!obj) return notFound();
        res.writeHead(200, { "content-type": obj.contentType, "content-length": obj.body.length });
        return res.end(obj.body);
      }
      if (req.method === "DELETE" && !key) {
        const { prefixes = [] } = JSON.parse(body.toString() || "{}") as { prefixes?: string[] };
        for (const p of prefixes) objects.delete(id(bucket, p));
        return json(200, []);
      }
    }
    json(404, { statusCode: "404", error: "not_implemented", message: `${req.method} ${u.pathname}` });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    put: (bucket, key, body, contentType = "application/octet-stream") =>
      objects.set(id(bucket, key), { body, contentType }),
    get: (bucket, key) => objects.get(id(bucket, key)),
    keys: (bucket, prefix = "") =>
      [...objects.keys()]
        .filter((k) => k.startsWith(`${bucket}/${prefix}`))
        .map((k) => k.slice(bucket.length + 1))
        .sort(),
    close: () => new Promise((r) => server.close(() => r())),
  };
}
