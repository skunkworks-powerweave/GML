/**
 * What the programme's WhatsApp number says back to a sender, in one place.
 *
 * Short and plain: these are read on a phone, often on 2G, by a teacher who
 * wants to know one thing -- did my lesson reach the right cycle, and if not,
 * what do I do. Each names the next step. English only for now; the app's
 * en/hi/bo bundles are Next-side and the worker, which sends these, has no
 * locale for a sender it may not even recognise.
 */

/** The caption format every reply that asks for a resend teaches. */
const EXAMPLE = "OBS-2026-009";

export type ReplyOutcome =
  | { kind: "linked_cycle"; code: string }
  | { kind: "linked_teach_back" }
  | { kind: "linked_meeting" }
  | { kind: "unmatched" }
  | { kind: "unregistered" }
  | { kind: "fetch_failed" }
  | { kind: "not_a_video" };

export function replyText(outcome: ReplyOutcome): string {
  switch (outcome.kind) {
    case "linked_cycle":
      return `Received your video for ${outcome.code}. It will be on the cycle page once it has been processed.`;
    case "linked_teach_back":
      return "Received your teach-back video. It will be in the teach-back queue once it has been processed.";
    case "linked_meeting":
      return "Received your meeting recording. It will be on the meeting once it has been processed.";
    case "unmatched":
      return (
        "Received your video, but the caption did not name a cycle you can add it to, so it has been kept " +
        `for the programme team. To attach it, send it again with your cycle code as the caption, for example ${EXAMPLE}.`
      );
    case "unregistered":
      return (
        "Received your video, but this number is not registered with the programme, so it has not been added " +
        "to any cycle and has been kept for the programme team. Please ask them to add this number to your profile."
      );
    case "fetch_failed":
      return "We could not download your video. Please send it again. If this keeps happening, contact the programme team.";
    case "not_a_video":
      return `This number accepts lesson videos. Send your video with your cycle code as the caption, for example ${EXAMPLE}.`;
  }
}
