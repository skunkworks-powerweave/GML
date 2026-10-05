-- 015: classes.students_count is the number of ACTIVE learners in the class.
--
-- WHY
--
-- The column was a number an administrator typed. Students added afterwards
-- (one at a time in the grid, by CSV, or by a teacher on her own screen)
-- never moved it, so the class page, the school page and "View learners (N)"
-- said "0 students" above a roster of six. A trigger keeps it true for every
-- writer: the grid, CSV import, the teacher screens, the seed, or SQL run by
-- hand.
--
-- Only the classes a write touches are recounted; the backfill at the end brings
-- every existing class to its real count once (a class created later with a typed
-- number keeps it until its first student arrives).
--
-- A trigger rather than code in each writer, because there are five writers
-- today and a sixth would otherwise reintroduce the defect. The grid and the CSV
-- importer no longer offer the column (admin/entities/classes.ts).
--
-- Idempotent: CREATE OR REPLACE, DROP TRIGGER IF EXISTS, and a backfill that
-- only writes where the number is wrong, so a replay on a later deploy is a
-- no-op.

CREATE OR REPLACE FUNCTION public.sync_class_students_count() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    UPDATE public.classes c
       SET students_count = (SELECT count(*) FROM public.learners l WHERE l.class_id = c.id AND l.active)
     WHERE c.id = OLD.class_id
       AND c.students_count IS DISTINCT FROM (SELECT count(*) FROM public.learners l WHERE l.class_id = c.id AND l.active);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    UPDATE public.classes c
       SET students_count = (SELECT count(*) FROM public.learners l WHERE l.class_id = c.id AND l.active)
     WHERE c.id = NEW.class_id
       AND c.students_count IS DISTINCT FROM (SELECT count(*) FROM public.learners l WHERE l.class_id = c.id AND l.active);
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS learners_sync_class_students_count ON public.learners;
CREATE TRIGGER learners_sync_class_students_count
  AFTER INSERT OR DELETE OR UPDATE OF class_id, active ON public.learners
  FOR EACH ROW EXECUTE FUNCTION public.sync_class_students_count();

UPDATE public.classes c
   SET students_count = n.count
  FROM (
    SELECT cl.id, count(l.id) FILTER (WHERE l.active) AS count
      FROM public.classes cl
      LEFT JOIN public.learners l ON l.class_id = cl.id
     GROUP BY cl.id
  ) n
 WHERE c.id = n.id
   AND c.students_count IS DISTINCT FROM n.count;
