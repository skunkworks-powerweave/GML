// Spec 163 — Worker structured logger.
//
// Wraps the previous ad-hoc console.log / console.warn / console.error
// usage in apps/worker/src/index.ts in a single helper so:
//
//   1. The output format is consistent and machine-parseable for log
//      shippers (Loki / Promtail in the operations stack — see
//      docs/operations.md). Every line is:
//
//        [worker][<iso-timestamp>][<level>] <message> <fields-json>
//
//      …with the trailing fields-json omitted when no structured fields
//      were passed (so a bare `log.info("online")` reads cleanly to a
//      human tailing the container logs).
//
//   2. Errors are emitted on stderr (level !== "info") so docker-compose
//      log routing and `journalctl -p err` filtering work. The lone
//      `console.log` would have written to stdout for both
//      informational and warning lines — a known pain point flagged by
//      the Workflow Run 15 audit-closure NIT round.
//
//   3. The "[worker]" tag is always present so a contributor grep'ing
//      a multi-process compose log for worker output has a single
//      stable prefix to filter on. Pre-fix some lines carried
//      "[worker]", some "[retention]", some none; the audit treated
//      that drift as a maintenance hazard.
//
// Fields are serialised via JSON.stringify with a try/catch wrapper that
// falls back to `String(fields)` on circular references so a misbehaving
// caller can never crash the worker process. This is defensive against
// the kind of payload that BullMQ jobs occasionally produce (jobs whose
// `data` contains a `Buffer` slice or a Node `Stream` reference).
//
// Used by apps/worker/src/index.ts. Not exported from package — keep
// the surface internal so a future contributor adding new worker
// helpers reaches for this file rather than spinning a parallel one.

type LogLevel = "info" | "warn" | "error";

type Fields = Record<string, unknown> | undefined;

function formatFields(fields: Fields): string {
  if (fields == null) return "";
  try {
    const serialised = JSON.stringify(fields);
    // JSON.stringify can return `undefined` for a fields={} value where
    // every property is `undefined`; treat that the same as no fields.
    if (serialised == null || serialised === "{}") return "";
    return " " + serialised;
  } catch {
    // Circular reference or BigInt — fall back to String() so the log
    // line still gets out rather than crashing the worker.
    return " " + String(fields);
  }
}

function emit(level: LogLevel, message: string, fields?: Fields): void {
  const ts = new Date().toISOString();
  const line = `[worker][${ts}][${level}] ${message}${formatFields(fields)}`;
  // info → stderr too, because docker-compose treats stdout/stderr the
  // same for `docker compose logs` BUT operations stacks split them.
  // Sending everything to stderr keeps the worker chatty on the same
  // channel; level discrimination lives in the bracketed tag, not the
  // file descriptor. This matches the convention used by the Next.js
  // app's server logs.
  process.stderr.write(line + "\n");
}

/**
 * Worker logger. Use instead of console.log / warn / error so output
 * is tagged, timestamped, and routed to stderr consistently.
 *
 * @example
 *   log.info("online", { redis: REDIS_URL, concurrency: 4 });
 *   log.warn("unknown job name", { name: job.name });
 *   log.error("job failed", { id: job.id, err: String(err) });
 */
export const log = {
  info(message: string, fields?: Fields): void {
    emit("info", message, fields);
  },
  warn(message: string, fields?: Fields): void {
    emit("warn", message, fields);
  },
  error(message: string, fields?: Fields): void {
    emit("error", message, fields);
  },
};
