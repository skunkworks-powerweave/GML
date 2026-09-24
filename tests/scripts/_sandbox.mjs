// A sandbox for EXECUTING the operator shell scripts without letting them reach
// anything real.
//
// ── THE BOUNDARY, AND WHY IT IS STRUCTURAL ───────────────────────────────────
//
// tests/scripts/deploy-sh.test.mjs records, in its header, two earlier tests
// that ran the real deploy path because they guarded with the ENVIRONMENT.
// This helper does not rely on the environment. It builds a PATH that contains
// exactly one directory — the sandbox's own bin/ — and puts two kinds of file
// in it:
//
//   passthroughs  ordinary text/file tools (awk, sed, grep, date, gzip, ...)
//                 that `exec` the real binary by ABSOLUTE path. None of them
//                 can touch a container, a database or the network.
//   stubs         logging fakes for everything that could: docker, node,
//                 pnpm, curl, psql, pg_dump, pg_restore, rclone, aws. A test
//                 installs the ones it needs; the rest are simply ABSENT.
//
// The real docker/node/curl/psql binaries live in directories that are not on
// the sandbox PATH at all, so a script that resolves commands through PATH —
// which every script in scripts/ does; none of them uses an absolute path —
// cannot reach them. `assertContained()` proves that before each run instead
// of trusting it: every dangerous name either fails to resolve or resolves
// inside this sandbox's bin/, or the test fails before the script starts.
//
// The script under test is a COPY rooted in a temp directory, and every
// script in scripts/ does `cd "$(dirname "$0")/.."`, so it roots itself in
// that directory: it sees the fake .env a test writes there and never the
// repository's. The environment handed to it is built from nothing — the
// parent's DATABASE_URL, Supabase keys and the like are never inherited.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const isWin = process.platform === "win32";
const BACKSLASH = String.fromCharCode(92);

/** A Windows path in the forward-slash form MSYS accepts everywhere. */
export const posixish = (p) => p.split(BACKSLASH).join("/");

/** Names that must never resolve to a real binary inside the sandbox. */
export const DANGEROUS = [
  "docker", "node", "pnpm", "npm", "npx", "corepack", "curl", "wget",
  "psql", "pg_dump", "pg_restore", "pg_isready", "rclone", "aws",
  "git", "ssh", "scp", "sudo", "systemctl", "apt-get",
];

/** Harmless tools the scripts need, passed through by absolute path. */
const PASSTHROUGH = [
  "awk", "sed", "grep", "head", "tail", "cut", "tr", "sort", "uniq", "wc",
  "cat", "dirname", "basename", "date", "mkdir", "rm", "mv", "cp", "ls",
  "find", "stat", "df", "uname", "base64", "gzip", "gunzip", "sleep", "env",
  "tee", "mktemp", "touch", "chmod", "numfmt", "od", "xargs", "id", "expr",
  "seq", "getent", "true", "false",
];

let cachedBash;
let cachedTools;

/** Absolute path of bash, in the form spawnSync can execute directly. */
export function bashExe() {
  if (cachedBash) return cachedBash;
  const r = spawnSync(
    "bash",
    ["-c", 'if command -v cygpath >/dev/null 2>&1; then cygpath -w "$BASH"; else printf %s "$BASH"; fi'],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (r.status !== 0 || !r.stdout.trim()) {
    throw new Error(`cannot locate bash (Git Bash on Windows): ${r.error?.message ?? r.stderr}`);
  }
  cachedBash = r.stdout.trim();
  return cachedBash;
}

/** name -> absolute POSIX path, for every PASSTHROUGH tool this host has. */
function passthroughTools() {
  if (cachedTools) return cachedTools;
  const script = `for t in ${PASSTHROUGH.join(" ")}; do p="$(command -v "$t" 2>/dev/null)" || continue; case "$p" in /*) printf '%s=%s\\n' "$t" "$p" ;; esac; done`;
  const r = spawnSync(bashExe(), ["-c", script], { encoding: "utf8", timeout: 30_000 });
  cachedTools = new Map(
    (r.stdout ?? "")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  for (const bad of DANGEROUS) cachedTools.delete(bad); // belt and braces
  return cachedTools;
}

/**
 * Create a sandbox. `files` are repo-relative paths copied in at the same
 * relative location. Returns helpers; always call cleanup() in a finally.
 */
export function makeSandbox({ files = [], prefix = "gml-sh-" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "invocations.log");
  writeFileSync(log, "");

  for (const [name, path] of passthroughTools()) {
    const w = join(bin, name);
    writeFileSync(w, `#!/bin/sh\nexec '${path}' "$@"\n`, { mode: 0o755 });
    chmodSync(w, 0o755);
  }

  const sb = {
    dir,
    bin,

    /** Copy a repo file into the sandbox at the same relative path. */
    copy(rel) {
      const dst = join(dir, rel);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(resolve(root, rel), dst);
      return dst;
    },

    /** Write a file (relative to the sandbox root). */
    write(rel, content) {
      const dst = join(dir, rel);
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, content);
      return dst;
    },

    read(rel) {
      return readFileSync(join(dir, rel), "utf8");
    },

    exists(rel) {
      return existsSync(join(dir, rel));
    },

    /**
     * Install a stub (replacing any passthrough of the same name). Every call
     * is appended to the invocation log as "<name> <args>" before `body`
     * (POSIX sh) runs.
     */
    stub(name, body = "exit 0") {
      const p = join(bin, name);
      writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "$SANDBOX_LOG"\n${body}\n`, {
        mode: 0o755,
      });
      chmodSync(p, 0o755);
    },

    /** Every stub invocation so far, in order. */
    invocations() {
      return readFileSync(log, "utf8").split(/\r?\n/).filter(Boolean);
    },

    env(extra = {}) {
      const base = {
        PATH: bin,
        HOME: dir,
        TMPDIR: posixish(dir),
        LANG: "C",
        LC_ALL: "C",
        SANDBOX_LOG: posixish(log),
        SANDBOX_DIR: posixish(dir),
      };
      if (isWin) {
        for (const k of ["SYSTEMROOT", "SystemRoot", "WINDIR", "TEMP", "TMP"]) {
          if (process.env[k]) base[k] = process.env[k];
        }
      }
      return { ...base, ...extra };
    },

    /** Prove no dangerous name resolves outside this sandbox. */
    assertContained(extraEnv = {}) {
      const script = `for t in ${DANGEROUS.join(" ")}; do p="$(command -v "$t" 2>/dev/null)" && printf '%s=%s\\n' "$t" "$p"; done; exit 0`;
      const r = spawnSync(bashExe(), ["-c", script], {
        encoding: "utf8",
        timeout: 30_000,
        env: sb.env(extraEnv),
      });
      const marker = posixish(dir).split("/").filter(Boolean).pop();
      for (const line of (r.stdout ?? "").split(/\r?\n/).filter(Boolean)) {
        const [name, path] = [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)];
        if (!path.includes(marker) || !path.endsWith(`/bin/${name}`)) {
          throw new Error(
            `SANDBOX BREACH: \`${name}\` resolves to ${path}, outside the sandbox. ` +
              `Refusing to run a script that could reach a real ${name}.`,
          );
        }
      }
    },

    /** Run a sandboxed copy of a script. */
    run(rel, { env = {}, input, timeout = 60_000, args = [] } = {}) {
      sb.assertContained(env);
      const r = spawnSync(bashExe(), [join(dir, rel), ...args], {
        cwd: dir,
        encoding: "utf8",
        timeout,
        input,
        env: sb.env(env),
      });
      if (r.error) throw new Error(`could not execute ${rel}: ${r.error.message}`);
      return r;
    },

    /** Run an inline bash snippet inside the sandbox (for sourcing a lib). */
    bash(snippet, { env = {}, timeout = 30_000 } = {}) {
      sb.assertContained(env);
      const r = spawnSync(bashExe(), ["-c", snippet], {
        cwd: dir,
        encoding: "utf8",
        timeout,
        env: sb.env(env),
      });
      if (r.error) throw new Error(`could not execute snippet: ${r.error.message}`);
      return r;
    },

    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
  for (const f of files) sb.copy(f);
  return sb;
}

/**
 * A curl stub that behaves like this stack's Caddy for /api/health.
 *
 * docker/Caddyfile has exactly one site block, {$DOMAIN:localhost}, so Caddy
 * matches on Host. Only an HTTPS request carrying Host=<domain> reaches the
 * app. Anything else — Host 127.0.0.1, plain HTTP to an IP — matches no site
 * and never yields the app's JSON (curl -f exits 22). And inside the sandbox
 * <domain> resolves nowhere unless the caller pins it with
 * `--resolve <domain>:443:127.0.0.1`, exactly as on a box whose own DNS is not
 * guaranteed to hairpin (curl exits 6, "could not resolve host").
 */
export function caddyCurl(domain, { healthy = true } = {}) {
  return `
resolve_ok=0; url=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--resolve" ] && [ "$a" = "${domain}:443:127.0.0.1" ]; then resolve_ok=1; fi
  case "$a" in http://*|https://*) url="$a" ;; esac
  prev="$a"
done
case "$url" in
  "https://${domain}/api/health")
    [ "$resolve_ok" = 1 ] || exit 6
    ${healthy ? `printf '%s' '{"ok":true,"app":true,"db":true,"storage":true,"migrations":true}'; exit 0` : `printf '%s' '{"ok":false}'; exit 22`}
    ;;
  *) exit 22 ;;
esac`;
}
