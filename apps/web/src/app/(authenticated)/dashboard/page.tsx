import Link from "next/link";
import { getSessionOrRedirect } from "@/lib/guards";
import { hasAnyRole } from "@gml/shared/auth/roles";

export default async function Dashboard() {
  const session = await getSessionOrRedirect("/dashboard");
  const role = session.user.role ?? "teacher";
  const isAdmin = hasAnyRole(role, ["programme_admin", "super_admin"]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-neutral-500">
          Welcome <span className="font-medium">{session.user.name ?? session.user.email}</span> · role: <code>{role}</code>
        </p>
      </header>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Link href="/observation/baseline" className="rounded-lg border border-neutral-200 bg-white p-4 hover:bg-neutral-50">
          <h2 className="font-medium">Classroom Observation</h2>
          <p className="text-xs text-neutral-500">Baseline / developmental / evaluative cycles + video evidence.</p>
        </Link>
        <Link href="/rtt" className="rounded-lg border border-neutral-200 bg-white p-4 hover:bg-neutral-50">
          <h2 className="font-medium">RTT Phases</h2>
          <p className="text-xs text-neutral-500">Phase 1-3 content by district / zone / term / subject.</p>
        </Link>
        <Link href="/mentorship" className="rounded-lg border border-neutral-200 bg-white p-4 hover:bg-neutral-50">
          <h2 className="font-medium">Mentorship</h2>
          <p className="text-xs text-neutral-500">Mentor/mentee directories, pairings, feedback, recordings.</p>
        </Link>
        {isAdmin ? (
          <Link href="/admin/data/teachers" className="rounded-lg border border-neutral-200 bg-white p-4 hover:bg-neutral-50">
            <h2 className="font-medium">Admin · Data</h2>
            <p className="text-xs text-neutral-500">Edit teachers, zones, schools, mentors, attendance.</p>
          </Link>
        ) : null}
      </section>

      <footer className="text-xs text-neutral-500">
        Confidential — internal programme use only. © Goldenmile Learning.
      </footer>
    </main>
  );
}
