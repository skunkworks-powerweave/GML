// What a feedback form's kind and audience are called, in the viewer's
// language (adminData.forms): in a chip (`kind`, `audience`) or spelled out
// (`kindTitle`, `audienceTitle`). Shared by /admin/forms and its [id] page.

import { feedbackAudienceEnum, feedbackKindEnum } from "@gml/db/schema";
import type { Translate } from "@/admin/labels";

type Group = "kind" | "kindTitle" | "audience" | "audienceTitle";

/** A value outside the database's list is shown as itself. */
export function formEnumLabel(t: Translate, group: Group, value: string): string {
  const known: readonly string[] = group.startsWith("kind") ? feedbackKindEnum.enumValues : feedbackAudienceEnum.enumValues;
  return known.includes(value) ? t(`forms.${group}.${value}`) : value;
}
