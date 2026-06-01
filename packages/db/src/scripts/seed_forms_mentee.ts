// Spec 076 — Mentee (teacher) feedback form catalog seed.
// Inserts 4 mentee-audience templates: baseline, progress_1, progress_2 (version "2"), final.
// Idempotent: per-row existence guard against the (kind, audience, version) unique index.
// Run: `tsx packages/db/src/scripts/seed_forms_mentee.ts`

import "dotenv/config";
import { pathToFileURL } from "node:url";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { feedbackForms } from "../schema/index.js";

const DRY_RUN = process.env.SEED_DRY_RUN === "true";

// Field descriptor — mirrors the shape the renderer (spec 073) expects.
type FieldType = "likert_5" | "textarea" | "radio" | "short_text" | "number";

interface FieldDescriptor {
  id: string;
  label: string;
  hindiLabel?: string;
  type: FieldType;
  required: boolean;
  options?: { value: string; label: string; hindiLabel?: string }[];
  helpText?: string;
  helpHindi?: string;
}

interface FormSchema {
  title: string;
  titleHindi?: string;
  audience: "mentee";
  intro?: string;
  introHindi?: string;
  fields: FieldDescriptor[];
}

// ---- BASELINE (mentee) — 9 fields ----------------------------------------
const baselineMentee: FormSchema = {
  title: "Baseline — Teacher self-assessment",
  titleHindi: "आधार रेखा — शिक्षक स्व-मूल्यांकन",
  audience: "mentee",
  intro: "Filled at the start of the mentorship pairing. Helps your mentor understand where to start.",
  introHindi: "मेंटरशिप शुरू होने पर भरें। आपके मेंटर को शुरुआत समझने में मदद करता है।",
  fields: [
    {
      id: "years_teaching",
      label: "How many years have you been teaching?",
      hindiLabel: "आप कितने वर्षों से पढ़ा रहे हैं?",
      type: "number",
      required: true,
    },
    {
      id: "current_grade",
      label: "Which grade(s) are you currently teaching?",
      hindiLabel: "आप किस कक्षा में पढ़ा रहे हैं?",
      type: "short_text",
      required: true,
      helpText: "e.g. Grade 3, or Grade 4-5 combined",
      helpHindi: "उदा. कक्षा 3, या कक्षा 4-5 संयुक्त",
    },
    {
      id: "biggest_challenge",
      label: "What is the single biggest classroom challenge you face right now?",
      hindiLabel: "इस समय आपकी सबसे बड़ी कक्षा-संबंधी चुनौती क्या है?",
      type: "textarea",
      required: true,
    },
    {
      id: "confidence_english",
      label: "How confident are you teaching in English?",
      hindiLabel: "अंग्रेज़ी में पढ़ाने में आप कितने आश्वस्त हैं?",
      type: "likert_5",
      required: true,
      helpText: "1 = not confident at all, 5 = very confident",
      helpHindi: "1 = बिल्कुल नहीं, 5 = बहुत आश्वस्त",
    },
    {
      id: "confidence_hindi_urdu",
      label: "How confident are you teaching in Hindi or Urdu?",
      hindiLabel: "हिंदी या उर्दू में पढ़ाने में आप कितने आश्वस्त हैं?",
      type: "likert_5",
      required: true,
    },
    {
      id: "confidence_ladakhi",
      label: "How confident are you switching to Ladakhi for explanations when students need it?",
      hindiLabel: "ज़रूरत पड़ने पर लद्दाख़ी में समझाने में आप कितने आश्वस्त हैं?",
      type: "likert_5",
      required: true,
    },
    {
      id: "mentor_expectations",
      label: "What do you hope to gain from these mentor sessions?",
      hindiLabel: "आप मेंटर सत्रों से क्या पाने की उम्मीद रखते हैं?",
      type: "textarea",
      required: true,
    },
    {
      id: "preferred_focus_area",
      label: "Which area would you most like the mentor to focus on?",
      hindiLabel: "मेंटर को आप किस क्षेत्र पर सबसे ज़्यादा ध्यान देने को कहेंगे?",
      type: "short_text",
      required: false,
    },
    {
      id: "anything_else",
      label: "Anything else your mentor should know before they start?",
      hindiLabel: "शुरू करने से पहले मेंटर को और कुछ जानना चाहिए?",
      type: "textarea",
      required: false,
    },
  ],
};

// ---- PROGRESS Q1 (mentee) — 8 fields -------------------------------------
const progress1Mentee: FormSchema = {
  title: "Quarter 1 progress — Teacher reflection",
  titleHindi: "तिमाही 1 प्रगति — शिक्षक चिंतन",
  audience: "mentee",
  intro: "Filled at the end of Quarter 1. Compare how you feel now to the baseline form.",
  introHindi: "तिमाही 1 के अंत में भरें। आधार-रेखा फ़ॉर्म से तुलना करें।",
  fields: [
    {
      id: "confidence_shift",
      label: "Has your overall teaching confidence shifted since the baseline?",
      hindiLabel: "आधार-रेखा के बाद से आपकी समग्र शिक्षण आत्मविश्वास में बदलाव हुआ है?",
      type: "likert_5",
      required: true,
      helpText: "1 = much worse, 3 = about the same, 5 = much better",
      helpHindi: "1 = बहुत कम, 3 = लगभग वही, 5 = बहुत बेहतर",
    },
    {
      id: "english_confidence_now",
      label: "How confident are you teaching in English now?",
      hindiLabel: "अब आप अंग्रेज़ी में पढ़ाने में कितने आश्वस्त हैं?",
      type: "likert_5",
      required: true,
    },
    {
      id: "most_useful_input",
      label: "What was the most useful thing your mentor shared with you this quarter?",
      hindiLabel: "इस तिमाही आपके मेंटर ने जो सबसे उपयोगी बात साझा की, वह क्या थी?",
      type: "textarea",
      required: true,
    },
    {
      id: "still_struggling",
      label: "What are you still struggling with?",
      hindiLabel: "आप अब भी किस चीज़ में संघर्ष कर रहे हैं?",
      type: "textarea",
      required: true,
    },
    {
      id: "sessions_attended",
      label: "Roughly how many mentor sessions have you had this quarter?",
      hindiLabel: "इस तिमाही आपके लगभग कितने मेंटर सत्र हुए?",
      type: "number",
      required: true,
    },
    {
      id: "applied_in_class",
      label: "Give one example of something you tried in the classroom because of mentor input.",
      hindiLabel: "एक उदाहरण दीजिए जो आपने मेंटर के सुझाव से कक्षा में आज़माया।",
      type: "textarea",
      required: true,
    },
    {
      id: "request_next_quarter",
      label: "What would you like to focus on next quarter?",
      hindiLabel: "अगली तिमाही में आप किस पर ध्यान देना चाहेंगे?",
      type: "short_text",
      required: false,
    },
    {
      id: "open_feedback_q1",
      label: "Open feedback for your mentor (optional)",
      hindiLabel: "अपने मेंटर के लिए खुली प्रतिक्रिया (वैकल्पिक)",
      type: "textarea",
      required: false,
    },
  ],
};

// ---- PROGRESS Q2 (mentee) — version "2" — 9 fields -----------------------
const progress2Mentee: FormSchema = {
  title: "Quarter 2 progress — Teacher reflection",
  titleHindi: "तिमाही 2 प्रगति — शिक्षक चिंतन",
  audience: "mentee",
  intro: "Filled at the end of Quarter 2. Halfway point — be honest about what's not working.",
  introHindi: "तिमाही 2 के अंत में भरें। आधे रास्ते पर — जो काम नहीं कर रहा उसके बारे में ईमानदार रहें।",
  fields: [
    {
      id: "confidence_shift_q2",
      label: "Has your overall teaching confidence shifted since Q1?",
      hindiLabel: "तिमाही 1 के बाद से आपकी समग्र शिक्षण आत्मविश्वास में बदलाव हुआ है?",
      type: "likert_5",
      required: true,
    },
    {
      id: "english_confidence_q2",
      label: "How confident are you teaching in English now?",
      hindiLabel: "अब अंग्रेज़ी में पढ़ाने में कितने आश्वस्त हैं?",
      type: "likert_5",
      required: true,
    },
    {
      id: "ladakhi_use_in_class",
      label: "How often are you using Ladakhi to bridge for students this quarter?",
      hindiLabel: "इस तिमाही आप विद्यार्थियों के लिए लद्दाख़ी का उपयोग कितनी बार कर रहे हैं?",
      type: "likert_5",
      required: true,
    },
    {
      id: "most_useful_input_q2",
      label: "What was the most useful mentor input this quarter?",
      hindiLabel: "इस तिमाही मेंटर का सबसे उपयोगी सुझाव क्या था?",
      type: "textarea",
      required: true,
    },
    {
      id: "still_struggling_q2",
      label: "What are you still struggling with?",
      hindiLabel: "अब भी किस चीज़ में संघर्ष है?",
      type: "textarea",
      required: true,
    },
    {
      id: "tried_and_failed",
      label: "Something you tried that did NOT work — and what you learned from it.",
      hindiLabel: "कुछ ऐसा जो आपने आज़माया पर काम नहीं किया — और उससे क्या सीखा।",
      type: "textarea",
      required: false,
    },
    {
      id: "mentor_responsiveness",
      label: "How responsive has your mentor been when you reach out?",
      hindiLabel: "जब आप संपर्क करते हैं तो आपका मेंटर कितनी जल्दी जवाब देता है?",
      type: "likert_5",
      required: true,
    },
    {
      id: "request_next_quarter_q2",
      label: "What do you want to focus on for Q3 and Q4?",
      hindiLabel: "तिमाही 3 और 4 में आप किस पर ध्यान देना चाहते हैं?",
      type: "short_text",
      required: false,
    },
    {
      id: "open_feedback_q2",
      label: "Open feedback for your mentor (optional)",
      hindiLabel: "अपने मेंटर के लिए खुली प्रतिक्रिया (वैकल्पिक)",
      type: "textarea",
      required: false,
    },
  ],
};

// ---- FINAL (mentee) — 10 fields ------------------------------------------
const finalMentee: FormSchema = {
  title: "Final — Mentorship retrospective",
  titleHindi: "अंतिम — मेंटरशिप पुनरावलोकन",
  audience: "mentee",
  intro: "Filled at the end of the pairing. Your honest answers help the next cohort.",
  introHindi: "जोड़ी समाप्त होने पर भरें। आपके ईमानदार जवाब अगले समूह की मदद करते हैं।",
  fields: [
    {
      id: "overall_growth",
      label: "How much have you grown as a teacher through this pairing?",
      hindiLabel: "इस जोड़ी के माध्यम से आप एक शिक्षक के रूप में कितने आगे बढ़े हैं?",
      type: "likert_5",
      required: true,
      helpText: "1 = no change, 5 = significant growth",
      helpHindi: "1 = कोई बदलाव नहीं, 5 = ज़बरदस्त विकास",
    },
    {
      id: "english_confidence_final",
      label: "How confident are you teaching in English now (vs the baseline)?",
      hindiLabel: "अब अंग्रेज़ी में पढ़ाने में कितने आश्वस्त हैं (आधार-रेखा की तुलना में)?",
      type: "likert_5",
      required: true,
    },
    {
      id: "language_blend_final",
      label: "How comfortable are you now blending English, Hindi/Urdu, and Ladakhi as students need?",
      hindiLabel: "विद्यार्थियों की ज़रूरत के अनुसार अंग्रेज़ी, हिंदी/उर्दू और लद्दाख़ी मिलाने में कितने सहज हैं?",
      type: "likert_5",
      required: true,
    },
    {
      id: "would_recommend",
      label: "Would you recommend mentorship to a colleague?",
      hindiLabel: "क्या आप किसी सहकर्मी को मेंटरशिप की सिफ़ारिश करेंगे?",
      type: "radio",
      required: true,
      options: [
        { value: "yes", label: "Yes", hindiLabel: "हाँ" },
        { value: "no", label: "No", hindiLabel: "नहीं" },
      ],
    },
    {
      id: "biggest_takeaway",
      label: "What is the single biggest thing you are taking away from this mentorship?",
      hindiLabel: "इस मेंटरशिप से आप जो एक सबसे बड़ी बात ले जा रहे हैं वह क्या है?",
      type: "textarea",
      required: true,
    },
    {
      id: "what_worked_best",
      label: "What worked best about how your mentor supported you?",
      hindiLabel: "आपके मेंटर ने आपका जिस तरह सहयोग किया, उसमें सबसे अच्छा क्या रहा?",
      type: "textarea",
      required: true,
    },
    {
      id: "what_could_improve",
      label: "What could be better next time?",
      hindiLabel: "अगली बार और बेहतर क्या किया जा सकता है?",
      type: "textarea",
      required: true,
    },
    {
      id: "lasting_change_in_class",
      label: "Describe one lasting change in your classroom because of this mentorship.",
      hindiLabel: "इस मेंटरशिप के कारण आपकी कक्षा में जो एक स्थायी बदलाव आया है, उसका वर्णन करें।",
      type: "textarea",
      required: true,
    },
    {
      id: "continue_next_phase",
      label: "Would you want to continue with a mentor in the next phase?",
      hindiLabel: "क्या आप अगले चरण में किसी मेंटर के साथ जारी रखना चाहेंगे?",
      type: "radio",
      required: false,
      options: [
        { value: "yes", label: "Yes", hindiLabel: "हाँ" },
        { value: "no", label: "No", hindiLabel: "नहीं" },
        { value: "unsure", label: "Not sure", hindiLabel: "अनिश्चित" },
      ],
    },
    {
      id: "open_feedback_final",
      label: "Open feedback — anything else you want to say.",
      hindiLabel: "खुली प्रतिक्रिया — कुछ और कहना चाहें।",
      type: "textarea",
      required: false,
    },
  ],
};

interface FormSeedRow {
  kind: "baseline" | "progress_1" | "progress_2" | "final";
  audience: "mentee";
  version: string;
  schema: FormSchema;
}

const ROWS: FormSeedRow[] = [
  { kind: "baseline", audience: "mentee", version: "1", schema: baselineMentee },
  { kind: "progress_1", audience: "mentee", version: "1", schema: progress1Mentee },
  { kind: "progress_2", audience: "mentee", version: "2", schema: progress2Mentee },
  { kind: "final", audience: "mentee", version: "1", schema: finalMentee },
];

export async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[seed:forms-mentee] DATABASE_URL not set");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);

  console.log(`[seed:forms-mentee] planning ${ROWS.length} mentee feedback templates`);

  if (DRY_RUN) {
    for (const row of ROWS) {
      console.log(
        `[seed:forms-mentee] DRY_RUN — would insert kind=${row.kind} audience=${row.audience} version=${row.version} fields=${row.schema.fields.length}`,
      );
    }
    await pool.end();
    return;
  }

  let inserted = 0;
  let skipped = 0;

  for (const row of ROWS) {
    const existing = await db
      .select({ id: feedbackForms.id })
      .from(feedbackForms)
      .where(
        and(
          eq(feedbackForms.kind, row.kind),
          eq(feedbackForms.audience, row.audience),
          eq(feedbackForms.version, row.version),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      console.log(
        `[seed:forms-mentee] [skip] kind=${row.kind} audience=${row.audience} version=${row.version} already exists (id=${existing[0].id})`,
      );
      skipped += 1;
      continue;
    }

    const [created] = await db
      .insert(feedbackForms)
      .values({
        kind: row.kind,
        audience: row.audience,
        version: row.version,
        active: true,
        schema: row.schema,
      })
      .returning({ id: feedbackForms.id });

    console.log(
      `[seed:forms-mentee] [insert] kind=${row.kind} audience=${row.audience} version=${row.version} -> id=${created.id} (${row.schema.fields.length} fields)`,
    );
    inserted += 1;
  }

  console.log(
    `[seed:forms-mentee] DONE — inserted=${inserted} skipped=${skipped} total=${ROWS.length}`,
  );
  await pool.end();
}

// Auto-run only when invoked directly (e.g. `tsx seed_forms_mentee.ts`), not
// when imported by the seed_all.ts orchestrator (spec 104).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error("[seed:forms-mentee] failed:", err);
    process.exit(1);
  });
}
