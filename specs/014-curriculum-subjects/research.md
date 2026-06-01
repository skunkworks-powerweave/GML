# Research 014

## D-001: `code` is required + unique

The prototype's repository quick-find depends on stable codes (`ENG`, `MAT`, `EVS`, etc). NULL codes would break breadcrumb generation. Making `code` `NOT NULL UNIQUE` is the right discipline — seed data can fill in.

## D-002: `grades_min` / `grades_max` as smallint with CHECK 1..12

Constrains to valid Indian grade range. CHECK constraint at DB layer prevents bad data from any source (admin grid, seed, manual SQL). Drizzle supports CHECK via `.check()` or raw SQL — using the raw `check()` builder.

## D-003: `display_order` for predictable ordering

Repository UI sorts subjects in a consistent order. `display_order ASC, name ASC` is the natural sort. Default 0 means new entries land at the top; admin can re-order later.

## D-004: No FK back to RTT subjects

Curriculum subjects and RTT subjects are independent — a curriculum subject like "English" isn't tied to a specific phase/term/training unit. The link goes the other way: course_outlines reference curriculum subjects (spec 016), and classroom sessions reference both a curriculum subject + an optional outline_lesson (spec 017).
