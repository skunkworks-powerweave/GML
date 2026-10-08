-- 017: editing a class's school or grade takes its students with it.
--
-- WHY
--
-- 016 holds a student's school and grade to her class's whenever the STUDENT is
-- written. It left the other direction open: Admin > Classes > Edit, Grade 5 to
-- Grade 7, saved, and the class's students were still Grade 5 -- the very
-- contradiction 016 refuses from the other side, made in one click, and a
-- teacher adding a student afterwards got Grade 7, so the class held two grades.
--
-- The class is the authority, so its students follow it. Refusing the edit while
-- the class has students was the alternative, and it cannot work: classes allows
-- one class per school and grade (classes_school_grade_uq), so there is no other
-- class to move the students to, and an administrator who made a typo in a
-- class's grade would have no way to correct it.
--
-- WHAT IT DOES
--
-- After a class's school_id or grade changes, the students who agreed with its
-- OLD school and grade get the new ones, in the same transaction as the edit, for
-- every writer: the grid, the CSV import, SQL run by hand.
--
-- It does not touch a student who already contradicted her class (stored before
-- 016). Those are not ours to rewrite: docs/operations lists the query that finds
-- them, and the learners trigger refuses a half-way write to one, so carrying
-- only the column that happened to agree would fail the class edit. Soft-deleted
-- and inactive students are carried too, so they do not turn up on that list.
--
-- It fires only when the edit sets school_id or grade (UPDATE OF), and does
-- nothing when their values are unchanged, so the students_count that 015 keeps
-- on classes does not wake it. It is an AFTER trigger: 016, which runs on the
-- students it updates, must see the class already carrying the new values.
--
-- Idempotent: CREATE OR REPLACE and DROP TRIGGER IF EXISTS.

CREATE OR REPLACE FUNCTION public.class_carries_students() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.school_id IS NOT DISTINCT FROM OLD.school_id
     AND NEW.grade IS NOT DISTINCT FROM OLD.grade THEN
    RETURN NULL;
  END IF;

  UPDATE public.learners l
     SET school_id = NEW.school_id,
         grade = NEW.grade,
         updated_at = now()
   WHERE l.class_id = NEW.id
     AND l.school_id = OLD.school_id
     AND l.grade = OLD.grade;

  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS classes_carry_students ON public.classes;
CREATE TRIGGER classes_carry_students
  AFTER UPDATE OF school_id, grade ON public.classes
  FOR EACH ROW EXECUTE FUNCTION public.class_carries_students();
