# Research 056

## D-001 — Use React's `cache()` not a request-scoped Map

`React.cache` (React 19, already in deps) automatically scopes memoization to the current React render pass and works inside Next.js Server Components without manual context plumbing. A homegrown `WeakMap` or `globalThis.__wikiCache` either leaks across requests or fails inside Next's per-request isolation. `cache()` is the documented React-Next path for this exact pattern (deduped server-side data fetches per request).
