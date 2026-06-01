# Spec 056 — Wiki data layer + RelLink chip

**Status:** complete · **Date:** 2026-06-01 · **Phase:** 6 (Repository)

## Overview

Replaces the JSX prototype's `window.WIKI` mock store and `window.wikiLookup` synchronous map with a real, request-cached server-side lookup helper that resolves entities by id from the Drizzle schema. Backs every cross-entity link in the Repository (`/repo/*`) routes that were ported in specs 046–055. Mirrors `LMS GML Frontend/wiki-data.jsx` lines 200–211 (the `wikiLookup` map) and `LMS GML Frontend/repository.jsx` lines 24–30 (the `RelLink` component). The helper exposes one async function per cross-referenced entity (`school`, `subject`, `teacher`, `class`, `session`, `outline`, `mentor`, `resource`) returning `Promise<Entity | null>`. Each function is wrapped in React's `cache()` so multiple `RelLink` renders against the same id during a single render pass collapse into a single SQL round-trip — matching the JSX prototype's effective behavior (synchronous in-memory array lookup) without the data-layer staleness. `RelLink` itself is a tiny client-safe presentational chip that ships as a Next.js `<Link>` styled with the `--chip` family of inline tokens; the `kind` prop maps the entity type to a color family identical to the JSX prototype (`school → indigo`, `subject → lichen / saffron / rust depending on `subjects.color`, `teacher → ink`, `class → indigo`, `session → saffron`, `outline → indigo`, `mentor → rust`, `resource → ink`). No PII is exposed by the chip label (we show name/code, not phone/guardian) so SM-9 does not apply.

## Functional Requirements

- **FR-001** — `apps/web/src/lib/wiki.ts` exports a `wikiLookup` object with 8 async methods: `school(id)`, `subject(id)`, `teacher(id)`, `class(id)`, `session(id)`, `outline(id)`, `mentor(id)`, `resource(id)`. Each returns `Promise<Entity | null>` (null when the id is not found or input is falsy).
- **FR-002** — Each lookup uses `import { cache } from "react"` to deduplicate within a single React render pass. The first call for a given id runs the Drizzle query; later calls in the same request return the cached promise.
- **FR-003** — Queries use `db.select().from(<table>).where(eq(<table>.id, id)).limit(1)` against the production Drizzle tables: `schools`, `subjects`, `teachers`, `classes`, `sessions`, `courseOutlines`, `mentors`, `resources`. Selected columns include the id, primary display name (or code for schools), and the SM-7 `hindiName` field where present (teachers, mentors).
- **FR-004** — Also export `hrefForEntity(kind, id)` returning the canonical `/repo/<kind>/<id>` URL: `school → /repo/school/<id>`, `class → /repo/class/<id>`, `subject → /repo/subject/<id>`, `session → /repo/session/<id>`, `teacher → /repo/teacher/<id>`, `outline → /repo/outline/<id>`, `mentor → /repo/mentor/<id>`, `resource → /repo/resource/<id>`. Matches the JSX `onNavigate(\`${kind}/${id}\`)` routing convention.
- **FR-005** — `apps/web/src/components/repo/RelLink.tsx` is a server-component-safe wrapper around Next.js `<Link>`. Props: `kind: "school" | "subject" | "teacher" | "class" | "session" | "outline" | "mentor" | "resource"`, `id: string`, `label: string`, optional `subjectColor?: string` for subject chips. Renders a pill (radius 999, 2px 8px padding, 11px label) coloured by `kind` per the JSX `subjectColor` map. Uses inline `style={{ background: …, color: … }}` with CSS variable tokens (no Tailwind classes — mirrors mentorship/page.tsx).
- **FR-006** — `RelLink` is itself non-async; it renders the label the caller computed (the caller is responsible for `await`-ing a `wikiLookup` to derive the label). This keeps RelLink composable inside JSX without unwrapping promises and matches the JSX prototype's flat usage `<RelLink>{owner.name}</RelLink>`.
- **FR-007** — `wikiLookup.session` joins `sessions → subjects → schools → teachers` so the session row includes `subjectName`, `schoolCode`, `teacherName` — used by `/repo/session/[id]` (spec 053) breadcrumb panel.

## Acceptance Criteria → JSX components ported

| JSX (wiki-data.jsx / repository.jsx) | Server-side counterpart |
| --- | --- |
| `window.wikiLookup.school(id)` returning `LMS.SCHOOLS.find(...)` | `wikiLookup.school(id)` Drizzle `select from schools` |
| `window.wikiLookup.subject(id)` returning WIKI_SUBJECTS find | `wikiLookup.subject(id)` Drizzle `select from subjects` |
| `window.wikiLookup.teacher(id)` returning `LMS.TEACHERS.find(...)` | `wikiLookup.teacher(id)` Drizzle `select from teachers` incl. `hindiName` |
| `window.wikiLookup.class(id)`, `.session(id)`, `.outline(id)`, `.resource(id)` | mirror functions on `classes`, `sessions`, `courseOutlines`, `resources` |
| `wikiLookup.student(id)` (mock-only) | **NOT ported** — learners are PII-gated; admin uses `/repo/students` directly (spec 054) and per-learner pages are out of repository scope. Documented in `designDeviations`. |
| `<RelLink onClick={() => onNavigate(\`subject/${id}\`)}>{name}</RelLink>` | `<RelLink kind="subject" id={id} label={name} />` rendering a Next.js `<Link href="/repo/subject/<id>">` |
| `subjectColor()` switch over `color` strings | `subjectColor()` exported from `wiki.ts` returning the `--indigo`/`--lichen`/`--saffron`/`--rust` token. |
| `chip-indigo`/`chip-saffron`/`chip-lichen`/`chip-rust` Tailwind class | Inline `style={{ background: <soft-token>, color: <ink-token> }}` |

## Audit hooks

None. SM-9 applies to learner-PII flows (spec 054). The wiki lookup returns only display-safe fields (names, codes, public metadata). Phone numbers, guardian names, ages, etc. are **not** selected by any function.

## Out of scope

- Mutations / admin CRUD (covered by `/admin/data/<entity>` per spec 012).
- Learner / student lookup (spec 054 handles the admin index; per-learner pages are not part of the wiki layer).
- Client-side hover prefetch of linked entities (future enhancement).
