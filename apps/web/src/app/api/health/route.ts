import { NextResponse } from "next/server";
import { pingDb, pingMigrations, pingMinio, pingRedis } from "@/lib/health";

// Disable Next.js caching for this route — health must reflect current state.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const [db, redis, minio, migrations] = await Promise.all([
    pingDb(),
    pingRedis(),
    pingMinio(),
    pingMigrations(),
  ]);
  const ok = db.ok && redis.ok && minio.ok && migrations.ok;
  return NextResponse.json({
    ok,
    app: true,
    db: db.ok,
    redis: redis.ok,
    minio: minio.ok,
    migrations: migrations.ok,
    details: { db, redis, minio, migrations },
    ts: new Date().toISOString(),
  });
}
