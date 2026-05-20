# Research 001 — Harness Scaffold

## Decisions

### D-001: Use pnpm (not npm) for workspace, install via `npm install -g pnpm@10`

**Context:** PLAN.md specifies pnpm workspaces (matches CourseLit conventions and is more disk-efficient for monorepos).

**Friction encountered:** `corepack enable` failed with EPERM on `C:\Program Files\nodejs\yarn` (no admin permission to write to the global Node install). `Invoke-WebRequest https://get.pnpm.io/install.ps1 | iex` failed with a self-install ENOENT bug in pnpm v11. The auto-mode classifier also blocked further re-runs of the external installer script (treated as "executing code from external source").

**Resolution:** `npm install -g pnpm@10` — installs to `C:\Users\himan\AppData\Roaming\npm` (npm's user-scoped global prefix, no admin needed). pnpm 10.33.4 installed and works. Recorded `packageManager: "pnpm@10.33.4"` in root package.json.

**Why:** unblocks the scaffold. pnpm 10 has every feature we need; pnpm 11 is too new to be worth fighting Windows install bugs over.

### D-002: Use `node --test` for governance tests (not jest/vitest yet)

**Context:** spec 001 needs basic file-existence assertions for the harness. Adding jest or vitest brings dependency weight before there's anything to test in earnest.

**Resolution:** Node's built-in `node:test` runner (stable since Node 20). Assertions via `node:assert`. Zero new dependencies. Test file pattern `tests/**/*.test.ts`. We can upgrade to vitest in a later spec if/when we need watch mode, snapshot testing, or DOM testing.

**Why:** minimal dependency footprint at the seed-stage of the project. Easy migration path later.

### D-003: Defer git's first commit to spec 002

**Context:** spec 001 sets up the workspace; spec 002 lands docker-compose.yml. We could commit twice (once after 001, once after 002) or once (after 002, covering both).

**Resolution:** `git init` in 001, no commit. First commit happens at end of 002. Reasoning: the first commit being "full bootable workspace + compose stack" is a more useful checkpoint than "empty Next.js install".

**Why:** cleaner git history at the project's start.

### D-004: SessionStart hook is a Node script (.mjs), not Python

**Context:** Base Version's hooks are Python (`yoda/hooks/*.py`). GML LMS is a Node project — adding Python adds runtime dependency for IT.

**Resolution:** All hook scripts are `.mjs` Node ESM files. They run with `node scripts/<name>.mjs`. No Python anywhere in the runtime stack.

**Why:** single-runtime project is simpler for IT to deploy and for future-Claude to maintain. No Python venv to manage.

### D-005: `apps/web` uses `--no-src-dir` so files live at `apps/web/app/...` not `apps/web/src/app/...`

**Context:** Next.js 15 defaults the App Router to a `src/` directory. Many Next.js projects do this; some don't.

**Resolution:** Use `--no-src-dir` for now. The plan's "critical files" section references paths like `apps/web/src/middleware.ts` — we'll update those references during the spec to either match `--no-src-dir` or flip the flag.

**Update:** flip the flag — use the default `src/` layout so paths like `apps/web/src/middleware.ts` (referenced throughout PLAN.md) work without rewriting. Recording this here for the implementation step.

## Alternatives considered

### A-001: Use Turborepo instead of vanilla pnpm workspaces
- **Pros:** caching, parallel task running
- **Cons:** extra dependency, extra config file, more complexity, more concepts to teach future-developer
- **Decision:** skip. Vanilla pnpm workspaces are sufficient for ~5-package monorepo. Add Turborepo only if/when build times become painful (unlikely at this scale).

### A-002: Use a starter template like `t3-stack`
- **Pros:** opinionated, batteries included (Auth.js, Drizzle, tRPC)
- **Cons:** brings tRPC + a specific Auth.js setup we may not want; harder to swap pieces; less clarity about what each piece does
- **Decision:** skip. We want each piece deliberately chosen via its own spec, not inherited from a starter.

### A-003: Skip the spec-kit overhead for early specs
- **Pros:** ship faster
- **Cons:** breaks the harness invariant ("a spec is only CLOSED when its ledger entry exists"); creates two classes of spec (rigorous later, loose early) which confuses everyone
- **Decision:** skip. The harness applies uniformly from spec 001.

## Context

- PLAN.md authoritative: `C:\Users\himan\OneDrive\Desktop\GML\PLAN.md`
- Reference repos cloned at `C:\Users\himan\OneDrive\Desktop\Repos\{frappe-lms,courselit,canvas-lms,edx-platform}` for grep-only reference
- Base Version harness studied at `C:\Users\himan\OneDrive\Desktop\Base Version` — pattern reused, marketing-platform-specific bits dropped
