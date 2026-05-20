import { NextResponse } from "next/server";
import { pingDb, pingMinio, pingRedis } from "@/lib/health";

// Disable Next.js caching for this route — health must reflect current state.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const [db, redis, minio] = await Promise.all([pingDb(), pingRedis(), pingMinio()]);
  const ok = true; // the route itself responding ⇒ app is up; sub-systems reported separately
  return NextResponse.json({
    ok,
    app: true,
    db: db.ok,
    redis: redis.ok,
    minio: minio.ok,
    details: { db, redis, minio },
    ts: new Date().toISOString(),
  });
}
