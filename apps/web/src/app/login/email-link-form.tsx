"use client";

// Magic-link sign-in form. Only used when SMTP is configured (server skips the
// Nodemailer provider otherwise). Posts to Auth.js's built-in /api/auth/signin/email.

import { useState } from "react";

export function EmailLinkForm() {
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(formData: FormData) {
    setError(null);
    const email = String(formData.get("email") ?? "");
    if (!email) {
      setError("Please enter your email.");
      return;
    }
    const res = await fetch("/api/auth/signin/email", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email,
        callbackUrl: "/dashboard",
      }),
    });
    if (res.ok || res.redirected) setSubmitted(true);
    else setError("Could not send link — try again later.");
  }

  if (submitted) {
    return (
      <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
        Check your inbox for a sign-in link (it expires in 10 minutes).
      </p>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(new FormData(e.currentTarget));
      }}
      className="flex flex-col gap-3 border-t border-neutral-200 pt-4"
    >
      <p className="text-xs uppercase tracking-wide text-neutral-500">Or sign in with an email link</p>
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
      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        className="rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm hover:bg-neutral-50"
      >
        Email me a sign-in link
      </button>
    </form>
  );
}
