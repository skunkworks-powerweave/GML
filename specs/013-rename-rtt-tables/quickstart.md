# Quickstart 013

After applying 0001:

```sql
SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'rtt_%';
-- expect: rtt_subjects, rtt_modules, rtt_lessons, rtt_sessions, rtt_readings, rtt_attendance
```

In code: `import { rttSubjects, rttModules, rttLessons, rttSessions, rttReadings, rttAttendance } from "@gml/db/schema";`
