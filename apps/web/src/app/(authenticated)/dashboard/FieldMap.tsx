// FieldMapSection — schematic SVG of Ladakh with one dot per real school.
// Clicking a dot deep-links to /repo/school/[id]. Coordinates are derived from
// a hash of the school code so the layout is stable across renders without
// requiring a geo column on the schools table.
//
// Its own module (it was the tail of dashboard/page.tsx) so it can be rendered
// on its own; tests/behaviour/ui-field-map.test.ts does.
//
// THE DISTRICT IS THE SCHOOL'S, from its zone. It used to be guessed from the
// code ("GMS-K", "GPS-K", "GHS-K" = Kargil), but a code names the place, not
// the district: GMS-KHA (Khaltsi) is in Leh, and five of the six Kargil
// schools do not start with a K. And a dot was placed by the hash anywhere
// across the map, whatever the KARGIL | LEH halves drawn under it said. Now a
// dot takes its district's colour and sits in its district's half; a district
// the map does not draw takes neither colour and may sit anywhere.

export type FieldMapSchool = { id: string; code: string; name: string; districtCode: string | null };

// x ranges either side of the divider at x = 280 (Kargil is west of Leh).
const DISTRICTS: Record<string, { label: string; color: string; x0: number; span: number }> = {
  KGL: { label: "Kargil", color: "var(--saffron)", x0: 60, span: 200 },
  LEH: { label: "Leh", color: "var(--indigo)", x0: 300, span: 160 },
};
const ELSEWHERE = { color: "var(--ink-3)", x0: 60, span: 400 };

export function FieldMapSection({ schools }: { schools: FieldMapSchool[] }) {
  // Stable hash → 0..1 mapping so dots stay put across renders.
  const placed = schools.map((s) => {
    let h = 0;
    for (let i = 0; i < s.code.length; i++) h = (h * 31 + s.code.charCodeAt(i)) >>> 0;
    const d = (s.districtCode ? DISTRICTS[s.districtCode] : undefined) ?? ELSEWHERE;
    const x = d.x0 + (h % d.span);
    const y = 80 + ((h >>> 8) % 200);
    return { ...s, x, y, color: d.color };
  });
  return (
    <article className="card card-hi">
      <header style={{ padding: 14, borderBottom: "1px solid var(--line)" }}>
        <h2 className="serif" style={{ fontSize: 16, fontWeight: 600 }}>
          Field operations
        </h2>
        <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
          {schools.length} school{schools.length === 1 ? "" : "s"} — click a marker to open its repo page
        </div>
        {/* What the two colours mean. */}
        <div style={{ display: "flex", gap: 12, marginTop: 6, fontSize: 11, color: "var(--ink-3)" }}>
          {Object.values(DISTRICTS).map((d) => (
            <span key={d.label} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span className="dot" style={{ background: d.color }} />
              {d.label}
            </span>
          ))}
        </div>
      </header>
      <div style={{ padding: 14 }}>
        {schools.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>No active schools registered.</div>
        ) : (
          <div style={{ position: "relative", borderRadius: 10, overflow: "hidden", border: "1px solid var(--line)", background: "var(--paper-2)" }}>
            <svg viewBox="0 0 520 320" style={{ width: "100%", display: "block" }}>
              {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                <path
                  key={i}
                  d={`M0 ${40 + i * 38} Q ${130 + i * 4} ${20 + i * 40} ${260 + i * 2} ${50 + i * 38} T 520 ${30 + i * 40}`}
                  fill="none"
                  stroke="var(--line-2)"
                  strokeWidth="0.6"
                  opacity={0.7}
                />
              ))}
              <text x="200" y="290" fill="var(--ink-3)" fontFamily="var(--mono)" fontSize="10" letterSpacing="2">
                KARGIL
              </text>
              <text x="400" y="290" fill="var(--ink-3)" fontFamily="var(--mono)" fontSize="10" letterSpacing="2">
                LEH
              </text>
              <line x1="280" y1="60" x2="280" y2="270" stroke="var(--line-2)" strokeDasharray="3 4" />
              {placed.map((m) => (
                <a key={m.id} href={`/repo/school/${m.id}`}>
                  <g style={{ cursor: "pointer" }}>
                    <circle cx={m.x} cy={m.y} r="6" fill={m.color} stroke="var(--paper)" strokeWidth="2" />
                    {/* ONE string child. `{m.name} ({m.code})` is four children,
                        and React's server renderer writes a <title> only for a
                        single string: the served HTML had <title></title>, the
                        client rendered the text, and every admin load failed
                        hydration (React error #418). */}
                    <title>{`${m.name} (${m.code})`}</title>
                  </g>
                </a>
              ))}
            </svg>
          </div>
        )}
      </div>
    </article>
  );
}
