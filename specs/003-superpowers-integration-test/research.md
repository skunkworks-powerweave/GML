# Research 003 — Superpowers Integration Test

## Decisions

### D-001: Use `zod` for API contracts in `@gml/shared`

zod is the de-facto standard for runtime schema validation in modern TypeScript Next.js apps; it pairs with react-hook-form (used in forms spec 047+) and Drizzle (DB spec 004+). Adding it once at spec 003 means later specs already have it on hand.

### D-002: Workspace exports via `exports` map, not `main`

`@gml/shared/package.json` declares `exports` so consumers can `import { pingResponse } from "@gml/shared/api-contracts/ping"`. Cleaner than a flat barrel index for a monorepo that will grow many modules.

### D-003: No build step for `@gml/shared` yet

Just emit `.ts` and let consumers (`@gml/web`) read them directly via Next.js's TypeScript pipeline. Add a real build step (tsc or tsup) only when a consumer not in Next.js needs the package — i.e., when `@gml/worker` becomes a real consumer in spec 024.

## Alternatives

- Use **superstruct** or **valibot** — both lighter than zod. Decision: zod's ecosystem and react-hook-form integration outweighs the size cost.
- Inline the schema in the route file — would defeat the point of proving `@gml/shared` is usable.
