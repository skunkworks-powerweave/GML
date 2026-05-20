# Quickstart 001 — Harness Scaffold

## What you get after this spec

A bootable monorepo skeleton at `C:\Users\himan\OneDrive\Desktop\GML\lms-app\`. No business logic yet — just the structure that every later spec slots into.

## Walking through it

### 1. The folder tree

```
lms-app/
├── apps/
│   ├── web/      ← Next.js 15 + App Router + TypeScript + Tailwind (just the default page)
│   └── worker/   ← empty stub (real worker arrives in spec 024)
├── packages/
│   ├── db/       ← empty stub (Drizzle schema arrives in spec 004)
│   ├── ui/       ← empty stub
│   └── shared/   ← empty stub
├── specs/        ← spec-kit (one numbered folder per feature)
│   ├── 001-harness-scaffold/  ← this spec
│   ├── 002-docker-compose-skeleton/
│   └── 003-superpowers-integration-test/
├── workspace/    ← runtime state (gitignored)
│   ├── state.json
│   ├── session_log.md
│   └── marathon_log.md
├── .claude/
│   └── settings.json    ← 6 hooks
├── scripts/
│   ├── session_start.mjs
│   ├── stop_session.mjs
│   ├── block_destructive.mjs
│   ├── warn_schema_change.mjs
│   ├── warn_middleware_change.mjs
│   └── check_migration_reversible.mjs
├── docker/       ← empty (compose file arrives in spec 002)
├── docs/         ← placeholder docs for substrate-moats, verification, architecture, operations
├── tests/governance/  ← node --test files
├── CLAUDE.md
├── README.md
├── README-IT.md
├── package.json
├── pnpm-workspace.yaml
├── .gitignore
└── .env.example
```

### 2. First-time setup

```powershell
cd C:\Users\himan\OneDrive\Desktop\GML\lms-app
pnpm install
```

That's it. No env vars yet (compose stack arrives in spec 002).

### 3. Run the harness self-test

```powershell
node scripts/session_start.mjs
# → Spec 001 — 1/70 complete (current: 002-docker-compose-skeleton)

pnpm test
# → runs tests/governance/test_001_harness_scaffold.test.ts via node --test
# → all assertions pass
```

### 4. Try the Next.js placeholder

```powershell
pnpm --filter @gml/web dev
# → http://localhost:3000 shows Next.js default page
```

(Real LMS routes arrive in spec 032+.)

## What this spec does NOT give you

- No docker-compose (spec 002)
- No DB (spec 004)
- No auth (specs 005-006)
- No video upload (specs 022-031)
- No UI for any of the three core pages (specs 032-046)

If you wanted any of those, you ran the wrong quickstart. This one is the foundation.

## Troubleshooting

- **`pnpm: command not found`** — run `npm install -g pnpm@10` and reopen the terminal.
- **`pnpm install` complains about OneDrive sync** — add `lms-app/node_modules`, `lms-app/.next` to OneDrive's exclusion list.
- **`node scripts/session_start.mjs` shows wrong spec** — the script reads `workspace/state.json`; edit that file manually if state diverges.
