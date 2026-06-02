# Tasks 138

- [x] T1 → write governance test (red) covering: MobileRepoCardList file
  presence + named export, design-token assertions (var(--card-hi),
  var(--line), var(--r-3), padding 14, gap 12), one Link per item with
  href + chip + hindi + secondary rendering, empty state, and seven repo
  pages each importing both getDeviceType + MobileRepoCardList and
  branching on `device === "mobile"`. Run suite → red.
- [x] T2 → create `apps/web/src/components/repo/MobileRepoCardList.tsx`:
  pure server component, item-shape props (id, primary, hindi, secondary,
  chip, href), card style honors the design tokens, minHeight 44, wraps
  each card in Next.js `<Link>`, renders chip top-right via `.chip
  .chip-<kind>`, renders hindi line under primary in var(--deva), empty
  state with dashed border + emptyMessage prop.
- [x] T3 → edit `apps/web/src/app/(authenticated)/repo/schools/page.tsx`:
  import getDeviceType + MobileRepoCardList, await device, render mobile
  card branch with district chip + code/zone/counts secondary lines,
  hide the desktop `.card` wrapper via display: none + aria-hidden on
  mobile. Leave the SQL untouched.
- [x] T4 → repeat T3 shape for `/repo/teachers`: primary = fullName,
  hindi = hindiName, chip = subject specialism, secondary = school code +
  phase + sessions/cycles counts.
- [x] T5 → repeat T3 shape for `/repo/mentors`: primary = name, hindi =
  hindiName, chip = base location (Leh/Kargil), secondary = expertise +
  mentee count.
- [x] T6 → repeat T3 shape for `/repo/subjects`: primary = name, chip =
  subject code, secondary = grades range + outlines/sessions/readings
  counts.
- [x] T7 → repeat T3 shape for `/repo/sessions`: primary = topic, hindi
  = teacher Hindi name, chip = status, secondary = scheduled date/time
  mono + subject/grade/school + teacher name.
- [x] T8 → repeat T3 shape for `/repo/resources`: primary = name, chip
  = kind, secondary = subjects (head, 2 + overflow) + owner/pages +
  updated date mono.
- [x] T9 → repeat T3 shape for `/repo/outlines`: primary = name, hindi
  = owner Hindi, chip = status, secondary = subject + grade/term/
  sessions + owner.
- [x] T10 → author all five spec-kit files under
  `specs/138-mobile-repo-card-list/`.
- [x] T11 → run the scoped governance suite (`pnpm test -- --test-name-
  pattern "spec 138"`) → green. Run the full suite to confirm no
  regression in the broader chrome.
- [ ] T12 (future) → consider a mobile-specific filter sheet (slide-up
  bottom-sheet pattern) if user testing shows the wrap-flow filter row
  feels cramped on 360px screens. Out of scope here; the current
  filter UI already wraps cleanly.
- [ ] T13 (future) → adopt the same card list on `/repo/students` once
  the PII gate is refactored (currently the page tightly couples its
  guard with the table layout). Punt until that refactor lands.
