"use client";

import { useActionState } from "react";
import { loginAction, type LoginState } from "./actions";

export default function LoginPage() {
  const [state, formAction, pending] = useActionState<LoginState | undefined, FormData>(
    loginAction,
    {},
  );

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Sign in</h1>
        <p className="text-sm text-neutral-500">GML LMS — Refresher Teacher Training</p>
      </header>

      <form action={formAction} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span>Email</span>
          <input
            name="email"
            type="email"
            autoComplete="email"
            required
            className="rounded-md border border-neutral-300 px-3 py-2 focus:border-neutral-900 focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>Password</span>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
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
          className="rounded-md bg-neutral-900 px-4 py-2 text-white disabled:opacity-60"
        >
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <p className="text-xs text-neutral-500">
        Trouble signing in? Contact your programme administrator.
      </p>
    </main>
  );
}
