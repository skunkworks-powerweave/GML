import "server-only";
import { notFound } from "next/navigation";

// Ids that arrive in a URL, validated before they reach Postgres.
//
// Every detail route passed its [id] straight into a `uuid` column, so a
// malformed id -- a truncated link from WhatsApp, a typo, a probe -- made
// Postgres throw `invalid input syntax for type uuid` and the page answered
// HTTP 500 ("This page couldn't load ... temporary connection problem"), which
// both misleads the user and pages an operator for nothing. A malformed id is
// simply a record that does not exist.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(raw: unknown): raw is string {
  return typeof raw === "string" && UUID.test(raw);
}

/** For pages: a malformed id renders the 404 page, as a missing record does. */
export function uuidOrNotFound(raw: unknown): string {
  if (!isUuid(raw)) notFound();
  return raw;
}
