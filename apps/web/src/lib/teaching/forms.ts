// What a /teaching server action answers its form with: a message in the
// teacher's language, already translated on the server (teaching.errors.* /
// teaching.done.*), so the form component needs no strings of its own.
// Undefined before the first submission. Types only -- nothing here runs.

export type ActionState = { error?: string; ok?: string } | undefined;

export type FormAction = (prev: ActionState, formData: FormData) => Promise<ActionState>;
