import { NextResponse } from "next/server";
import { pingDb, pingMigrations, pingMinio, pingRedis } from "@/lib/health";

// Disable Next.js caching for this route — health must reflect current state.
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Liveness: is this process up and serving? Deliberately has NO dependency
 * checks, so a database blip cannot cause the orchestrator to restart a web
 * container that is perfectly capable of serving the login page.
 */
export async function HEAD(): Promise<Response> {
  return new Response(null, { status: 200 });
}

/**
 * Readiness.
 *
 * Returns 503 when any dependency is down. This previously always returned
 * HTTP 200 and expressed failure only in the JSON body (`{"ok": false}`), which
 * made every probe in the stack decorative: the Docker HEALTHCHECK and
 * `scripts/deploy.sh`'s `curl -fsS` both inspect the status code only. A stack
 * with no schema, no object storage and 0-of-22 migrations applied reported
 * itself healthy. See docs/verification.md (B13).
 *
 * `details` is omitted for anonymous callers. The per-check `detail` strings are
 * raw driver messages -- they carry internal hostnames, ports and auth-failure
 * text, and this endpoint is public and unauthenticated. Set HEALTH_DEBUG=1 (or
 * run outside production) to include them.
 */
export async function GET(): Promise<Response> {
  const [db, redis, minio, migrations] = await Promise.all([
    pingDb(),
    pingRedis(),
    pingMinio(),
    pingMigrations(),
  ]);

  const ok = db.ok && redis.ok && minio.ok && migrations.ok;
  const verbose =
    process.env.HEALTH_DEBUG === "1" || process.env.NODE_ENV !== "production";

  return NextResponse.json(
    {
      ok,
      app: true,
      db: db.ok,
      redis: redis.ok,
      minio: minio.ok,
      migrations: migrations.ok,
      // Always safe to expose: a bare count tells an operator "the schema is not
      // applied" without revealing anything about the deployment's internals.
      migrationsApplied: migrations.applied ?? null,
      migrationsExpected: migrations.expected ?? null,
      ...(verbose ? { details: { db, redis, minio, migrations } } : {}),
      ts: new Date().toISOString(),
    },
    {
      status: ok ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
