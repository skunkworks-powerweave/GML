-- One row per (slug, version) in section_gates.
--
-- /api/admin/gates/[slug]/rotate computed max(version)+1 before its
-- transaction, so two rotations of the same gate at once both wrote version N.
-- getCurrentGate() orders by version DESC LIMIT 1, arbitrary between equal
-- versions, so one of the two passwords shown "once" did not work -- and if
-- that one was distributed, the section was locked for everyone. The route now
-- takes a per-slug advisory lock and computes the version inside it; this
-- index makes a duplicate impossible whatever writes the table.
--
-- Existing duplicates are renumbered first, or the index could not be built
-- and `docker compose up` would stop at the migrate step. Within a duplicated
-- (slug, version), the rows after the first (by created_at, then id) move above
-- that gate's highest version, in creation order -- so the most recent
-- rotation is the current one, which is what the admin who performed it was
-- told. Each move is reported; if in doubt, rotate that gate once more.

DO $$
DECLARE r record; top integer;
BEGIN
  FOR r IN
    SELECT id, slug, version FROM (
      SELECT id, slug, version,
             row_number() OVER (PARTITION BY slug, version ORDER BY created_at, id) AS n
      FROM section_gates
    ) d WHERE n > 1
    ORDER BY slug, version, n
  LOOP
    SELECT max(version) INTO top FROM section_gates WHERE slug = r.slug;
    UPDATE section_gates SET version = top + 1 WHERE id = r.id;
    RAISE NOTICE 'section_gates %: duplicate % version % renumbered to %', r.id, r.slug, r.version, top + 1;
  END LOOP;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "section_gates_slug_version_uq" ON "section_gates" USING btree ("slug", "version");
