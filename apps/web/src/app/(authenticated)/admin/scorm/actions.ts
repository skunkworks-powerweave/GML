"use server";

// Withdraw or restore a SCORM package.
//
// Withdrawing hides it from learners (lib/scorm/store.ts launchableWhere):
// it leaves their subject page, its launch page and content 404, and commits
// to it are refused. Nothing is deleted -- the learners' records are programme
// evidence of what they completed, and the files are what a restore brings
// back. Either administrator role may do it: it adds no content, so it is not
// the super_admin-only act an upload is (lib/scorm/ingest.ts).

import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { db } from "@gml/db";
import { requireRole } from "@/lib/guards";
import { recordAudit } from "@/lib/audit";
import { setPackageActive } from "@/lib/scorm/store";

export async function setScormPackageActiveAction(formData: FormData): Promise<void> {
  await requireRole(["programme_admin", "super_admin"]);
  const id = String(formData.get("id") ?? "");
  const active = formData.get("active") === "true";

  const title = await setPackageActive(db, id, active);
  if (title === null) notFound();

  await recordAudit({
    action: active ? "scorm.package.activate" : "scorm.package.deactivate",
    entityType: "scorm_package",
    entityId: id,
    metadata: { title },
  });
  revalidatePath("/admin/scorm");
  revalidatePath(`/admin/scorm/${id}`);
  redirect(`/admin/scorm/${id}`);
}
