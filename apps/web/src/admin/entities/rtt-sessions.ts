import { z } from "zod";
import { rttSessions } from "@gml/db/schema";
// Relative, not @/: the registry is imported by tests with no path alias.
import { webLink } from "../../lib/rtt/links";
import type { AdminEntity } from "../types";

// RTT sessions — the webinars, live quizzes and asynchronous units that make up
// a training subject.
//
// WHY THIS ENTITY EXISTS. /rtt/online/synchronous renders this table as a
// three-week calendar, and both its empty state and its footer told the
// administrator to "schedule via /admin/data/sessions". That grid manages the
// CLASSROOM `sessions` table, which is a different table entirely: nothing
// typed into it has ever appeared on the webinar calendar. No admin surface
// managed rtt_sessions at all, so the only way to schedule a webinar was to
// edit a seed script and re-run it -- which the IT team taking this over cannot
// do, and should not have to.
export const rttSessionsEntity: AdminEntity = {
  slug: "rtt-sessions",
  label: "RTT Sessions",
  table: rttSessions,
  readRoles: ["programme_admin", "super_admin", "mentor", "observer"],
  mutateRoles: ["programme_admin", "super_admin"],
  displayColumns: [
    { key: "title", label: "Title" },
    { key: "type", label: "Type" },
    { key: "scheduledAt", label: "Scheduled" },
    { key: "durationMin", label: "Minutes" },
    { key: "platform", label: "Platform" },
    { key: "sequence", label: "Seq" },
  ],
  formSchema: z.object({
    rttSubjectId: z.string().uuid(),
    sequence: z.coerce.number().int().min(1).max(999),
    title: z.string().min(2).max(240),
    // The calendar filters on these four values; anything else would be stored
    // and then never rendered anywhere.
    type: z.enum(["synchronous", "asynchronous", "webinar", "quiz"]),
    scheduledAt: z.coerce.date().optional().nullable(),
    durationMin: z.coerce.number().int().min(1).max(600).optional().nullable(),
    platform: z.string().max(80).optional().nullable(),
    // http(s) only, as rtt-readings: it becomes the Join/Watch href on every
    // teacher's subject page and calendar. It was any string, so a Meet link
    // pasted as Meet displays it ("meet.google.com/...", no scheme) became a
    // relative link that 404'd inside the app at session time. A bare host is
    // stored with https:// (lib/rtt/links.ts); anything else is refused.
    linkOrRecording: z
      .preprocess(
        (v) => (typeof v === "string" && v.trim() !== "" ? (webLink(v) ?? v) : v),
        z
          .string()
          .max(2000)
          .regex(/^https?:\/\//i, "Must be a web link, e.g. https://meet.google.com/abc-defg-hij")
          .url(),
      )
      .optional()
      .nullable(),
    notes: z.string().max(5000).optional().nullable(),
  }),
  formFields: [
    "rttSubjectId",
    "sequence",
    "title",
    "type",
    "scheduledAt",
    "durationMin",
    "platform",
    "linkOrRecording",
    "notes",
  ],
  describeRow: (r) => `rtt-session:${r.title ?? r.id}`,
};
