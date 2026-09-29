# Teaching records, attendance, grading and approvals — design

Status: approved 2026-09-28. The product owner's further answers:
- **Approver:** a programme admin approves everything a teacher submits: lesson plans, sessions
  with their attendance, and marks.
- **New accounts:** a "Request an account" form on the login page. A programme admin approves it,
  which creates the login and the teacher record, or rejects it with a reason.
- **Before approval:** a record is visible with a "pending approval" label, and reports count it.
  Approval locks it from further edits by the teacher.

## Why

A status review of the programme admin and teacher roles, done on 2026-09-28, found gaps against
what the product owner needs:

- **Programme admin.** They can already add, edit and delete subjects, schools, teachers and
  curriculum. They cannot write students or attendance.
- **Missing everywhere.** There is no grading beyond a quiz's pass mark, and no approve/reject step.
- **Teacher.** She can maintain nothing of her own: no lesson plans, no sessions, no attendance,
  no marks.
- **Privacy.** A teacher can see other teachers' profiles, including their phone numbers, and
  their sessions.

The product owner's decisions:
- Admins and teachers can add basic information from scratch.
- A teacher maintains **only her own** lesson plans and sessions.
- **Both** kinds of attendance: admins mark teachers at RTT sessions, and teachers mark their students.
- **All** grading systems: a student grade scale, scored observation rubrics, and quiz grades.
- **All** approvals: teacher-entered records, teach-backs, observation sign-off, and new accounts.
- In the Repository, a teacher sees **only her own records**.

## Data model (one migration)

| Change | Purpose |
|---|---|
| `classes.teacher_id` → teachers (nullable) | "My classes" and "my students" for a teacher. `class_teacher_name` stays as display text. |
| `outline_lessons.plan` (text) and `course_outlines.approval_status` | A lesson plan's content, and whether it is approved. |
| `sessions.notes` (text) and `sessions.approval_status` | Session details a teacher writes, and whether they are approved. |
| **`session_attendance`** (session, learner, status present/absent/late/excused, marked_by, marked_at; one row per learner per session) | Per-student attendance. A session's attended/total counts and a learner's attendance % are derived from it. |
| `rtt_attendance` is written by a marking screen, which sets `marked_by_user_id` | Teacher attendance at RTT sessions. |
| **`grading_scales`** (name, used for: students / quizzes / observations, active) and **`grading_bands`** (label, from %, to %, counts as pass, order) | Admin-defined grade scales, e.g. A1 91–100 … E 0–32. |
| **`assessments`** (class, subject, term, title, max marks, date, teacher, approval_status) and **`assessment_marks`** (assessment, learner, marks, remark) | A teacher records test marks; the grade comes from the student scale. |
| **`observation_rubrics`** (name, scale, active) and **`rubric_criteria`** (order, title, what each level looks like) | A scored rubric. The observer scores each criterion, and the cycle shows the total and level. The current free-text rubric stays for old cycles. |
| `quizzes.grading_scale_id` (nullable) | A quiz result shows its grade band next to pass/fail. |
| **`approvals`** (item type, item id, submitted by/at, status pending/approved/changes requested/rejected, decided by/at, comment) | One queue for every approval, with a history per item. |
| **`account_requests`** (name, email, phone, school, requested role, status, decided by/at, reason) | "Request an account" from the login page. |

Every new table gets an admin data-table entity, so admins can add, edit and delete from scratch
and use CSV import and export.

## Screens

**Teacher — new "My teaching" menu section**, where she sees and changes only her own records:
- **My classes:** add or edit her classes at her school.
- **My students:** add, edit or remove learners in her classes.
- **Lesson plans:** her own course outlines and lessons (objectives, activities, materials). She
  submits a plan for approval; it can be edited until it is approved.
- **Sessions:** plan a session (class, subject, lesson, date, time, topic, notes), then mark each
  student present, absent, late or excused. The counts update themselves. She submits the session
  for approval.
- **Marks:** create an assessment, enter each student's marks, see the grades, and submit for
  approval.
- Her own RTT progress, quiz results with grades, and observation scores. She also sees the reason
  when something comes back with changes requested.

**Programme admin and super admin:**
- **Attendance:** open an RTT session to see the teachers it covers, mark each one, and save.
  Programme admins can also write attendance and students in the data tables.
- **Grading:** create and edit grade scales and rubrics.
- **Approvals** (new page with a count badge). One queue: filter by type, open an item, then choose
  Approve, Request changes (with a comment) or Reject (with a reason). The submitter gets an inbox
  message in their own language, and every decision is audited. What goes in the queue:
  - Teacher lesson plans, sessions with their attendance, and marks.
  - New account requests. Approving one creates the login and the teacher record, linked, with
    an initial password.
  - Observation sign-off, which can now also be sent back with a comment.
- The existing data tables keep working for everything, including records that teachers create.

**Mentor and observer:**
- **Teach-back review** becomes Approve or Request changes, with written feedback the teacher sees.
- **The observer scores the rubric** on the observer form.

**Everyone signed out:** the login page gains "Request an account".

## Privacy: the Repository for teachers

- **Her own records only.** A teacher sees her own profile, classes, students, sessions and lesson
  plans. Other teachers' profiles, phone numbers, sessions, classes, rosters and plans answer 404.
  The teacher directory and school rosters are hidden.
- **Quick find** is limited in the same way.
- **Shared reference material stays visible:** subjects, reading material and RTT content. This is
  what she teaches from.
- Mentors, observers and admins keep today's wider view.

## Fixes that ride along

- The data tables hide the Add, Edit and Delete controls a role cannot use; today they lead to a
  Forbidden page.
- Resources get a PDF upload instead of a pasted storage key.
- Deactivating a teacher record also locks her out.
- A delete that would also remove other data says so before it happens.
- Progress appears in the teacher's menu.
- The teacher's Observation menu item shows 🔒.
- Every new string ships in English, Hindi and Bhoti.

## Delivery and verification

- **One branch, `feat/teaching-records`, and one migration**, then one commit per area:
  1. teacher records and privacy;
  2. both kinds of attendance;
  3. grading;
  4. approvals;
  5. account requests;
  6. fixes.
- **Tests.** Every rule gets a behaviour test that fails first and runs against a real Postgres.
  The rules are: who may write what, "own records only", counts derived from attendance, grade
  bands, and approval state changes.
- **Gates:** typecheck, lint, governance, scripts, behaviour and build; the i18n scanner reports
  nothing.
- **Hand-over:** a browser walkthrough as teacher and as programme admin in English, Hindi and
  Bhoti. The UAT map is updated.
