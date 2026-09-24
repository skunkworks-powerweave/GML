// Run the REAL worker entrypoint (apps/worker/src/index.ts) as a child process,
// against a schema of its own.
//
// ── WHY A CHILD PROCESS ──────────────────────────────────────────────────────
//
// Some worker defects are properties of the PROCESS, not of any one function:
// a consumer loop that ends while the process stays up and healthy, or an idle
// pooled connection whose error kills the process outright. Neither can be
// observed by calling a function; both are observed here exactly as an operator
// would see them -- is the process alive, and does it still claim work.
//
// ── WHY ITS OWN SCHEMA ───────────────────────────────────────────────────────
//
// The worker claims ANY runnable job in `jobs`, and other test files enqueue
// onto the same queues concurrently; a real worker pointed at the shared table
// would run their jobs and fail their assertions. So the child connects with
// `search_path = wl_<tag>, public`, where wl_<tag> holds its own `jobs` plus
// empty copies of every table its periodic sweeps write (the upload
// reconciler, the retention sweep). Everything else falls through to public.
// The copies are LIKE ... INCLUDING ALL, so defaults, CHECKs and the partial
// unique indexes behave as they do in the real table.
//
// The child runs with its cwd in a fresh temporary directory, so `dotenv` finds
// no .env to load, and with a Storage URL on a closed port: nothing it does can
// reach anything but the test database.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";
import { DATABASE_URL, tag } from "./_harness.js";

const WORKER_ENTRY = fileURLToPath(new URL("../../apps/worker/src/index.ts", import.meta.url));
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

/** Tables the worker writes outside `jobs`, shadowed so its sweeps touch nothing shared. */
const SHADOWED = ["jobs", "files", "video_submissions", "transcode_jobs", "notifications", "rate_limits"];

export type WorkerProcess = {
  child: ChildProcess;
  /** Everything the child has written to stderr so far (the logger's channel). */
  output(): string;
  alive(): boolean;
  /** Resolves with the exit code (or signal name) once the child has exited. */
  exited: Promise<number | string | null>;
  kill(): Promise<void>;
};

export type WorkerWorld = {
  schema: string;
  /** Connection string that resolves `jobs` (and the shadows) to this world's schema. */
  url: string;
  q<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
  spawnWorker(env?: Record<string, string>): WorkerProcess;
};

/** A world with its own schema; everything is torn down afterwards. */
export async function withWorkerWorld(body: (w: WorkerWorld) => Promise<void>): Promise<void> {
  const schema = tag("wl").replace(/-/g, "_");
  const admin = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  for (const t of SHADOWED) {
    await admin.query(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING ALL)`);
  }
  const sep = DATABASE_URL!.includes("?") ? "&" : "?";
  const url =
    `${DATABASE_URL}${sep}application_name=${schema}` +
    `&options=${encodeURIComponent(`-c search_path=${schema},public`)}`;
  const q = async <R,>(sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows as R[];

  const procs: WorkerProcess[] = [];
  const cwd = mkdtempSync(join(tmpdir(), "gml-worker-test-"));
  const spawnWorker = (env: Record<string, string> = {}): WorkerProcess => {
    const child = spawn(process.execPath, ["--import", TSX_LOADER, WORKER_ENTRY], {
      cwd,
      env: {
        ...process.env,
        DATABASE_URL: url,
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9",
        SUPABASE_SECRET_KEY: "test-dummy",
        WORKER_CONCURRENCY: "1",
        HOSTNAME: schema,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout!.on("data", (c) => (out += c.toString()));
    child.stderr!.on("data", (c) => (out += c.toString()));
    let running = true;
    const exited = new Promise<number | string | null>((resolve) =>
      child.on("exit", (code, signal) => {
        running = false;
        resolve(code ?? signal);
      }),
    );
    const proc: WorkerProcess = {
      child,
      output: () => out,
      alive: () => running,
      exited,
      kill: async () => {
        if (running) child.kill("SIGKILL");
        await exited;
      },
    };
    procs.push(proc);
    return proc;
  };

  try {
    await body({ schema, url, q, spawnWorker });
  } finally {
    for (const p of procs) await p.kill();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** Poll `probe` until it returns a truthy value, or give up after `ms`. */
export async function waitFor<T>(probe: () => Promise<T | null | undefined | false>, ms: number, every = 250): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, every));
  }
}
