"use server";

// "Request an account" -- the public form linked from both login screens.
// Anyone can post here, signed in or not, so:
//
//   - The answer is the same neutral confirmation whether the request was
//     recorded, the address already has a request waiting, or it already has
//     a login: the form must not tell a stranger which addresses are known.
//     (Whether an address has a login is shown to the approver instead, on
//     the request, before they approve.)
//   - A hidden field no person fills in (the honeypot) answers "done" and
//     records nothing.
//   - Requests that would be recorded are rate limited per network address,
//     in Postgres like the sign-in throttle (lib/rate-limit.ts), failing
//     closed. A school or a training room shares one address behind NAT and a
//     whole cohort may ask at once, so the limit is per quarter hour and
//     generous; what it stops is one source filling the queue and every
//     programme admin's inbox.
//
// Messages are codes; the form (./request-form.tsx) says them in the
// language picked on the login page (login.requestAccount.*).

import { and, eq } from "drizzle-orm";
import { db } from "@gml/db";
import { schools } from "@gml/db/schema";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/request-ip";
import { isUuid } from "@/lib/ids";
import {
  ACCOUNT_REQUEST_ROLES,
  submitAccountRequest,
  type AccountRequestRole,
} from "@/lib/approvals/account-requests";
import { HONEYPOT_FIELD, type RequestAccountField, type RequestAccountState } from "./fields";

const WINDOW_MS = 15 * 60 * 1000;
const REQUESTS_PER_ADDRESS = 10;

const LIMITS = { fullName: 160, email: 254, message: 2000 } as const;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A phone number as the programme writes it: E.164, "+" and 8-15 digits. A
 * bare 10-digit number is an Indian mobile; a leading 0 or 91 before one is
 * the same number. As /admin/users reads a WhatsApp number.
 */
function normalisePhone(raw: string): string | null {
  const s = raw.replace(/[\s\-().]/g, "");
  if (/^\+\d{8,15}$/.test(s)) return s;
  if (/^\d{10}$/.test(s)) return `+91${s}`;
  if (/^0\d{10}$/.test(s)) return `+91${s.slice(1)}`;
  if (/^91\d{10}$/.test(s)) return `+${s}`;
  return null;
}

export async function requestAccountAction(
  _prev: RequestAccountState | undefined,
  formData: FormData,
): Promise<RequestAccountState> {
  const text = (name: string) => String(formData.get(name) ?? "").trim();
  // Filled in: not a person. Say what a person would be told, record nothing.
  if (text(HONEYPOT_FIELD) !== "") return { done: true };

  const values = {
    fullName: text("fullName"),
    email: text("email").toLowerCase(),
    phone: text("phone"),
    school: text("school"),
    role: text("role"),
    message: text("message"),
  } satisfies Record<RequestAccountField, string>;

  const invalid: RequestAccountField[] = [];
  if (!values.fullName || values.fullName.length > LIMITS.fullName) invalid.push("fullName");
  if (!EMAIL.test(values.email) || values.email.length > LIMITS.email) invalid.push("email");
  const phone = values.phone === "" ? null : normalisePhone(values.phone);
  if (values.phone !== "" && phone === null) invalid.push("phone");
  const role = (ACCOUNT_REQUEST_ROLES as readonly string[]).includes(values.role) ? (values.role as AccountRequestRole) : null;
  if (!role) invalid.push("role");
  if (values.message.length > LIMITS.message) invalid.push("message");

  // A teacher belongs to a school; a mentor or an observer may name one.
  let schoolId: string | null = null;
  if (values.school !== "") {
    if (isUuid(values.school)) {
      try {
        const [row] = await db
          .select({ id: schools.id })
          .from(schools)
          .where(and(eq(schools.id, values.school), eq(schools.active, true)))
          .limit(1);
        schoolId = row?.id ?? null;
      } catch (err) {
        console.error("[request-account] could not look up the school:", err);
        return { error: "unavailable", values };
      }
    }
    if (!schoolId) invalid.push("school");
  } else if (role === "teacher") {
    invalid.push("school");
  }

  if (invalid.length > 0) return { invalid, values };

  try {
    const limited = await rateLimit({
      bucket: "account-request:address",
      id: await clientIp(),
      limit: REQUESTS_PER_ADDRESS,
      windowMs: WINDOW_MS,
    });
    if (!limited.ok) return { error: "rate_limited", values };
  } catch (err) {
    // Fail closed: a limiter that cannot count refuses.
    console.error("[request-account] the rate limiter is unavailable:", err);
    return { error: "unavailable", values };
  }

  try {
    await submitAccountRequest(db as never, {
      fullName: values.fullName,
      email: values.email,
      phone,
      schoolId,
      role: role!,
      message: values.message || null,
    });
  } catch (err) {
    console.error("[request-account] the request could not be recorded:", err);
    return { error: "unavailable", values };
  }
  // Recorded, or a request from this address was already waiting: the same
  // answer either way.
  return { done: true };
}
