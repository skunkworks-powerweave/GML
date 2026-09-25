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
-- and `docker compose up` would stop at the migrate step. Every gate that has
-- a duplicate is renumbered 1..n in (version, created_at, id) order: the
-- versions keep their order, and within a duplicated version the later row
-- comes second. So a LATER rotation stays above the duplicate -- the password
-- the last rotating admin distributed stays current. (Moving the duplicate to
-- max(version)+1 instead would put a stale password above that rotation.)
-- Gates without a duplicate keep their numbers. Each change is reported; if
-- in doubt, rotate that gate once more.

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT id, slug, version, n FROM (
      SELECT id, slug, version,
             row_number() OVER (PARTITION BY slug ORDER BY version, created_at, id) AS n
      FROM section_gates
      WHERE slug IN (SELECT slug FROM section_gates GROUP BY slug, version HAVING count(*) > 1)
    ) d WHERE n <> version
    ORDER BY slug, n
  LOOP
    UPDATE section_gates SET version = r.n WHERE id = r.id;
    RAISE NOTICE 'section_gates %: % version % renumbered to %', r.id, r.slug, r.version, r.n;
  END LOOP;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "section_gates_slug_version_uq" ON "section_gates" USING btree ("slug", "version");
