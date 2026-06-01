import type { AdminEntity } from "./types";

// Registry — populated by individual specs (013-019 marathon adds the 7 baseline entities).
// Adding a new admin-editable table = appending an AdminEntity to this map.
//
// SM-1 reminder: actions.ts wraps every mutation with `withAudit({entityType, action})`.
// Don't bypass — the grep gate doesn't catch it, but a code review will.

import { schoolsEntity } from "./entities/schools";
import { zonesEntity } from "./entities/zones";
import { teachersEntity } from "./entities/teachers";
import { mentorsEntity } from "./entities/mentors";
import { mentorPairingsEntity } from "./entities/mentor-pairings";
import { attendanceEntity } from "./entities/attendance";
import { subjectsEntity } from "./entities/subjects";

export const ADMIN_ENTITIES: Record<string, AdminEntity> = {
  schools: schoolsEntity,
  zones: zonesEntity,
  teachers: teachersEntity,
  mentors: mentorsEntity,
  "mentor-pairings": mentorPairingsEntity,
  attendance: attendanceEntity,
  subjects: subjectsEntity,
};

export type AdminEntitySlug = keyof typeof ADMIN_ENTITIES;
