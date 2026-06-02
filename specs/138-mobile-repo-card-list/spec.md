# Spec 138 — Mobile repo card-list (Workflow Run 12 frontend parity, FINAL)

## Why

The JSX prototype at `LMS GML Frontend/mobile-repo.jsx` (530 LOC) defines a
card/row pattern for browsing the repository on small screens. The live
ports at `apps/web/src/app/(authenticated)/repo/<entity>/page.tsx` render
desktop tables (8-9 columns wide). On a 360px phone those tables overflow
horizontally and feel wrong — the JSX prototype's answer is one card per
entity, primary serif title, 1-3 secondary detail lines, optional chip,
optional Hindi name, full card area as the tap target.

Spec 023 shipped a `MobileEntityCardList` for the admin grid at
`/admin/data/<entity>`. It's good for what it does — but it hard-codes
the admin-only "Export CSV / View row" buttons, and it assumes a
column-map registry that the repo pages don't carry. Composition-wise
it's the wrong primitive: the repo pages need a generic, parametric
list that each page can pick fields for and route through its own
href factory.

This is the final Workflow Run 12 spec — after it lands, the entire
JSX prototype is wired to backend.

## What we ship

### 1. `apps/web/src/components/repo/MobileRepoCardList.tsx` (CREATED)

Server component (no client-side state needed — the whole card is a
`<Link>`).

```tsx
type MobileRepoCardItem = {
  id: string | number;
  primary: ReactNode;          // serif 16px line
  hindi?: string | null;       // var(--deva) line below the title
  secondary?: MobileRepoSecondaryField[];   // 1-3 detail lines
  chip?: MobileRepoChip | null;             // pill top-right
  href: string;                              // tap target
  ariaLabel?: string;
};
```

Visual contract (matches mobile-repo.jsx::MobRepoIndex lines 117-142):
- `var(--card-hi)` background
- `var(--line)` 1px border
- `var(--r-3)` border-radius (10px)
- 14px padding, 12px column-gap between fields, 8px gap inside the card
- Primary field: serif 16px, weight 600
- Secondary fields: 12px, var(--ink-3)
- Hindi name: var(--deva), 13px, var(--ink-3)
- Optional chip top-right via `<span className="chip chip-<kind>">`
- Minimum card height: 44px (Apple HIG / Material touch target floor)

Items + emptyMessage + testIdSuffix are the only props — caller-driven
shape keeps the component a true primitive.

### 2-8. Seven repo index pages (EDITED)

Each adopts the conditional pattern:

```tsx
const device = await getDeviceType();
// ...
{device === "mobile" ? (
  <MobileRepoCardList items={...} testIdSuffix="<entity>" />
) : null}
<div className="card" style={device === "mobile" ? { display: "none" } : undefined} aria-hidden={device === "mobile"}>
  <table className="t">...desktop table stays unchanged...</table>
</div>
```

Pages touched:
- `apps/web/src/app/(authenticated)/repo/schools/page.tsx`
- `apps/web/src/app/(authenticated)/repo/teachers/page.tsx`
- `apps/web/src/app/(authenticated)/repo/mentors/page.tsx`
- `apps/web/src/app/(authenticated)/repo/subjects/page.tsx`
- `apps/web/src/app/(authenticated)/repo/sessions/page.tsx`
- `apps/web/src/app/(authenticated)/repo/resources/page.tsx`
- `apps/web/src/app/(authenticated)/repo/outlines/page.tsx`

The SQL queries are NOT touched — the same `visible` / `rows` array
feeds both branches. Filters (URL params from spec 129) continue to
narrow the dataset server-side regardless of which layout renders it.

## Acceptance criteria

- `MobileRepoCardList.tsx` exists and exports `MobileRepoCardList`.
- The component honors the var(--card-hi), var(--line), var(--r-3),
  14px padding, 12px gap design tokens.
- Each card is a `<Link>` (full area tap target).
- The component accepts the documented props shape (items, emptyMessage,
  testIdSuffix) and renders one `[data-testid="mobile-repo-card"]`
  element per item.
- Each of the seven repo index pages imports `getDeviceType` and
  `MobileRepoCardList`, calls `await getDeviceType()`, and renders the
  mobile branch conditionally on `device === "mobile"`.
- Existing desktop tables on each page remain in place but become
  `display: none` + `aria-hidden` on mobile (no double-render).
- All five spec-kit files exist under `specs/138-mobile-repo-card-list/`.
- `tests/governance/test_138_mobile_repo_card_list.test.mjs` passes
  with at least seven assertions.

## Non-goals

- **No new dependencies.** Component is plain JSX + Next.js Link.
- **No schema changes.** Pure UI layer.
- **No changes to SQL queries.** Each adopted page keeps its existing
  Drizzle pipeline; only the render branch is touched.
- **No changes to filter UI.** Filter cards / form GETs continue to
  drive URL search params; the card list shows the filtered slice.
- **No client-side JavaScript.** Card list is server-rendered; the
  whole card is a Next.js `<Link>` and tap-feedback is browser-native.
- **No /repo home (`/repo`) card grid.** The home page's tile grid
  is already mobile-friendly (4×2 emoji tiles in the prototype) and
  the live port at `apps/web/src/app/(authenticated)/repo/page.tsx`
  already uses a flex/grid layout; only the table-based index pages
  needed this treatment.
- **No /repo/students page.** That page is a heavily-restricted PII
  read; the current desktop layout has narrow columns and reads okay
  on mobile, so we leave it alone to avoid touching the privacy guard.
- **No mobile-specific filter UI.** The desktop filter cards from
  spec 129 work fine at 360px (chips wrap; selects shrink) so they're
  reused as-is.
