"use client";

import { useActionState } from "react";
import { use } from "react";
import { verifyGate, type GateState } from "./actions";

const LABELS: Record<string, string> = {
  mentorship: "Mentorship",
  observation: "Classroom Observation",
  tkt: "TKT",
  ttt: "TTT",
};

export default function GatePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ next?: string }>;
}) {
  const { slug } = use(params);
  const { next } = use(searchParams);
  const [state, formAction, pending] = useActionState<GateState | undefined, FormData>(
    verifyGate,
    {},
  );
  const label = LABELS[slug] ?? slug;

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">{label}</h1>
        <p className="text-sm text-neutral-500">
          Enter the section password to continue. Your access lasts 8 hours.
        </p>
      </header>
      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="next" value={next ?? "/dashboard"} />
        <label className="flex flex-col gap-1 text-sm">
          <span>Section password</span>
          <input
            name="password"
            type="password"
            required
            autoFocus
            className="rounded-md border border-neutral-300 px-3 py-2 focus:border-neutral-900 focus:outline-none"
          />
        </label>
        {state?.error ? (
          <p className="text-sm text-red-600" role="alert">
            {state.error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-60"
        >
          {pending ? "Checking…" : "Continue"}
        </button>
      </form>
      <p className="text-xs text-neutral-500">
        Confidential — internal programme use only. Section passwords rotate periodically.
      </p>
    </main>
  );
}
