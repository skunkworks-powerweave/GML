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
import { rttSessionsEntity } from "./entities/rtt-sessions";
import { rttSubjectsEntity } from "./entities/rtt-subjects";
import { rttModulesEntity } from "./entities/rtt-modules";
import { rttLessonsEntity } from "./entities/rtt-lessons";
import { rttReadingsEntity } from "./entities/rtt-readings";
import { observationCyclesEntity } from "./entities/observation-cycles";
import { subjectsEntity } from "./entities/subjects";
import { classesEntity } from "./entities/classes";
import { courseOutlinesEntity } from "./entities/course-outlines";
import { outlineLessonsEntity } from "./entities/outline-lessons";
import { sessionsEntity } from "./entities/sessions";
import { resourcesEntity } from "./entities/resources";
import { resourceSubjectsEntity } from "./entities/resource-subjects";
import { learnersEntity } from "./entities/learners";

export const ADMIN_ENTITIES: Record<string, AdminEntity> = {
  schools: schoolsEntity,
  zones: zonesEntity,
  teachers: teachersEntity,
  mentors: mentorsEntity,
  "mentor-pairings": mentorPairingsEntity,
  "rtt-attendance": rttAttendanceEntity,
  "rtt-sessions": rttSessionsEntity,
  "rtt-subjects": rttSubjectsEntity,
  // The four below are registered because nothing else in the product writes
  // their tables: /rtt/subject/[id] reads modules, lessons and readings, and
  // /observation is fed entirely by observation_cycles, which only the demo
  // seed ever inserted. Each entity file carries the full note; the proof is
  // tests/behaviour/admin-entities.test.ts.
  "rtt-modules": rttModulesEntity,
  "rtt-lessons": rttLessonsEntity,
  "rtt-readings": rttReadingsEntity,
  "observation-cycles": observationCyclesEntity,
  subjects: subjectsEntity,
  classes: classesEntity,
  "course-outlines": courseOutlinesEntity,
  "outline-lessons": outlineLessonsEntity,
  sessions: sessionsEntity,
  resources: resourcesEntity,
  "resource-subjects": resourceSubjectsEntity,
  learners: learnersEntity, // SM-9 piiAudited:true
};

export type AdminEntitySlug = keyof typeof ADMIN_ENTITIES;
