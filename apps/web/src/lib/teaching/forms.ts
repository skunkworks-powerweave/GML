// What a /teaching server action answers its form with: a message in the
// teacher's language, already translated on the server (teaching.errors.* /
// teaching.done.*), so the form component needs no strings of its own.
// Undefined before the first submission. A CSV upload also lists, one line
// each, the rows it did not import (`issues`). Types only -- nothing here runs.

export type ActionState = { error?: string; ok?: string; issues?: string[] } | undefined;

export type FormAction = (prev: ActionState, formData: FormData) => Promise<ActionState>;
