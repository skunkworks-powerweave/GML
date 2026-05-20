import Link from "next/link";

export default function Forbidden() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="text-5xl">403</p>
      <h1 className="text-xl font-semibold">Forbidden</h1>
      <p className="text-sm text-neutral-600">
        Your role does not permit access to this section. Contact your programme administrator.
      </p>
      <Link href="/" className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white">
        Go home
      </Link>
    </main>
  );
}
