import "server-only";
import { NextResponse } from "next/server";
import type { ZodError } from "zod";

// Reading a route handler's JSON body, and answering when it is wrong.
//
// `await req.json().catch(() => ({}))` turned a body that is not JSON into an
// EMPTY body, and the handler carried on as if the caller had sent `{}`:
// PUT /api/user-prefs answered 200 {"ok":true} and audited an update, POST
// /api/helpdesk/tickets put a help request in every administrator's inbox, and
// PUT /api/admin/system-settings said "empty_patch" -- each one telling the
// caller something about a request it never read.
//
// And the 400s returned zod's issues verbatim. zod 3 copies the rejected value
// into an issue's `received` AND into its message ("... received '<value>'"),
// so a 2 MB field came back twice in the response, and an array of thousands
// of bad entries came back as thousands of issues.

/** 400 for a body that is not JSON. The parser's message is not echoed. */
export function invalidJson(): NextResponse {
  return NextResponse.json({ error: "invalid_json" }, { status: 400 });
}

/**
 * The request body parsed as JSON, or the 400 to return instead.
 *
 * An empty body is malformed too, unless the route opts in with `allowEmpty`
 * (then it reads as `{}`): only a route whose every field is optional should.
 */
export async function readJsonBody(
  req: Request,
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
): Promise<{ body: unknown; response?: never } | { body?: never; response: NextResponse }> {
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return { response: invalidJson() };
  }
  if (raw.trim() === "") return allowEmpty ? { body: {} } : { response: invalidJson() };
  try {
    return { body: JSON.parse(raw) as unknown };
  } catch {
    return { response: invalidJson() };
  }
}

const MAX_ISSUES = 20;
const MAX_MESSAGE = 200;

/**
 * zod issues as a 400 body may carry them: which field, and why, bounded.
 * `received` and every other echo of the input are dropped; the message, which
 * can quote the input, is cut to MAX_MESSAGE characters.
 */
export function publicIssues(error: ZodError): Array<{ path: (string | number)[]; message: string }> {
  return error.issues
    .slice(0, MAX_ISSUES)
    .map((issue) => ({ path: issue.path, message: issue.message.slice(0, MAX_MESSAGE) }));
}
