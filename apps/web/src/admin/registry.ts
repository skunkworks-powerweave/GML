import type { AdminEntity } from "./types";

// Registry — entities grow spec-by-spec across Phase 2 (specs 012-019).
//
// SM-1 reminder: actions.ts wraps every mutation with `withAudit({entityType, action})`.
// Don't bypass — the grep gate doesn't catch it, but a code review will.
//
// v2 note (spec 013): `attendance` and `subjects` were renamed to `rtt-attendance`
// and `rtt-subjects` to free the bare slugs for curriculum-side entities
// (spec 014 ships the curriculum `subjects` entity at slug `subjects`).

import { schoolsEntity } from "./entities/schools";
import { zonesEntity } from "./entities/zones";
import { teachersEntity } from "./entities/teachers";
import { mentorsEntity } from "./entities/mentors";
import { mentorPairingsEntity } from "./entities/mentor-pairings";
import { rttAttendanceEntity } from "./entities/rtt-attendance";
import { rttSubjectsEntity } from "./entities/rtt-subjects";
import { subjectsEntity } from "./entities/subjects";
import { classesEntity } from "./entities/classes";
import { courseOutlinesEntity } from "./entities/course-outlines";
import { outlineLessonsEntity } from "./entities/outline-lessons";
import { sessionsEntity } from "./entities/sessions";

export const ADMIN_ENTITIES: Record<string, AdminEntity> = {
  schools: schoolsEntity,
  zones: zonesEntity,
  teachers: teachersEntity,
  mentors: mentorsEntity,
  "mentor-pairings": mentorPairingsEntity,
  "rtt-attendance": rttAttendanceEntity,
  "rtt-subjects": rttSubjectsEntity,
  subjects: subjectsEntity,
  classes: classesEntity,
  "course-outlines": courseOutlinesEntity,
  "outline-lessons": outlineLessonsEntity,
  sessions: sessionsEntity,
};

export type AdminEntitySlug = keyof typeof ADMIN_ENTITIES;
