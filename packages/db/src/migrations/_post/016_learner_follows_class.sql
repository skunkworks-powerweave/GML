-- 016: a student's school and grade are the school and grade of her class.
--
-- WHY
--
-- learners carries class_id, school_id and grade as three columns nothing tied
-- together, so a student could be saved at one school in another school's
-- class, or as Grade 9 in a Grade 5 class, and then turned up in the wrong
-- school's reports and on the wrong class page. The admin grid, the CSV import
-- and the teacher's add-student screen now check it (apps/web
-- lib/learner-placement.ts) and say what is wrong in the user's language; this
-- trigger holds the same rule for every other writer -- a seed, SQL run by
-- hand, a writer not yet written -- as 015 does for the class's student count.
--
-- WHAT IT DOES
--
--   * a blank school_id or grade (omitted or NULL) is filled from the class. A
--     BEFORE trigger runs before the NOT NULL check, so the insert succeeds;
--   * a school_id or grade that differs from the class's is refused (23514,
--     check_violation), naming the ids and never the student;
--   * a class that does not exist is left to the foreign key to report.
--
-- It judges only a write that sets or CHANGES class_id, school_id or grade. An
-- UPDATE that leaves all three as they were passes whatever it names in its SET
-- list (the grid re-posts the whole row), so a student stored before this rule,
-- whose class's grade was edited since, can still have her guardian or name
-- changed. Existing rows are not rewritten: the migration only adds the
-- trigger. docs/operations lists the query that finds the rows that disagree.
--
-- Idempotent: CREATE OR REPLACE and DROP TRIGGER IF EXISTS.

CREATE OR REPLACE FUNCTION public.learner_follows_class() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  class_school uuid;
  class_grade smallint;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.class_id = OLD.class_id
     AND NEW.school_id IS NOT DISTINCT FROM OLD.school_id
     AND NEW.grade IS NOT DISTINCT FROM OLD.grade THEN
    RETURN NEW;
  END IF;

  SELECT c.school_id, c.grade INTO class_school, class_grade
    FROM public.classes c
   WHERE c.id = NEW.class_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF NEW.school_id IS NULL THEN
    NEW.school_id := class_school;
  ELSIF NEW.school_id <> class_school THEN
    RAISE EXCEPTION 'learner school % is not the school of class % (%)', NEW.school_id, NEW.class_id, class_school
      USING ERRCODE = '23514', COLUMN = 'school_id';
  END IF;

  IF NEW.grade IS NULL THEN
    NEW.grade := class_grade;
  ELSIF NEW.grade <> class_grade THEN
    RAISE EXCEPTION 'learner grade % is not the grade of class % (%)', NEW.grade, NEW.class_id, class_grade
      USING ERRCODE = '23514', COLUMN = 'grade';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS learners_follow_class ON public.learners;
CREATE TRIGGER learners_follow_class
  BEFORE INSERT OR UPDATE OF class_id, school_id, grade ON public.learners
  FOR EACH ROW EXECUTE FUNCTION public.learner_follows_class();
