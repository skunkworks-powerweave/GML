import { z } from "zod";
import { resourceSubjects } from "@gml/db/schema";
import type { AdminEntity } from "../types";

export const resourceSubjectsEntity: AdminEntity = {
  slug: "resource-subjects",
  table: resourceSubjects,
  readRoles: ["programme_admin", "super_admin"],
  mutateRoles: ["programme_admin", "super_admin"],
  displayColumns: [
    { key: "resourceId" },
    { key: "subjectId" },
  ],
  formSchema: z.object({
    resourceId: z.string().uuid(),
    subjectId: z.string().uuid(),
  }),
  formFields: ["resourceId", "subjectId"],
  describeRow: (r) => `resource-subject:${r.resourceId}/${r.subjectId}`,
};
