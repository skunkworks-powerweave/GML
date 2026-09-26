// District > zone navigation for staff on /rtt and /rtt/progress (F42).
//
// Plain links, not a form or a client component: each choice is a URL
// (?district= / ?zone=), so it works with no JavaScript on a slow link and a
// view can be bookmarked or shared. lib/rtt/scope.ts resolves the choice, and
// ignores it for a teacher, who is always shown her own place.

import Link from "next/link";
import type { Place, PlaceOption } from "@/lib/rtt/scope";

export function PlacePicker({
  basePath,
  options,
  place,
  keep = {},
}: {
  basePath: string;
  options: PlaceOption[];
  place: Place | null;
  /** Other query parameters the links carry over (a subject filter). */
  keep?: Record<string, string | null>;
}) {
  const href = (district?: string, zone?: string) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(keep)) if (v) q.set(k, v);
    if (district) q.set("district", district);
    if (zone) q.set("zone", zone);
    const s = q.toString();
    return s ? `${basePath}?${s}` : basePath;
  };
  // The chosen place is bold as well as indigo: chip-indigo and the plain chip
  // are the same lightness, so the hue alone was all that marked it (F135).
  const chip = (on: boolean) =>
    on ? { className: "chip chip-indigo", style: { fontWeight: 600 } } : { className: "chip" };
  const district = options.find((o) => o.districtId === place?.districtId);
  return (
    <nav aria-label="District and zone" style={{ display: "grid", gap: 6, marginTop: 12 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Link href={href()} {...chip(!place)} aria-current={place ? undefined : "page"}>
          Whole programme
        </Link>
        {options.map((o) => (
          <Link
            key={o.districtId}
            href={href(o.districtId)}
            {...chip(o.districtId === place?.districtId)}
            aria-current={o.districtId === place?.districtId && !place?.zoneId ? "page" : undefined}
          >
            {o.districtName}
          </Link>
        ))}
      </div>
      {district && district.zones.length > 0 ? (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {/* The same URL as the district's chip above, so current with it:
              it said nothing, and a screen reader could not tell it was on. */}
          <Link
            href={href(district.districtId)}
            {...chip(!place?.zoneId)}
            aria-current={place?.zoneId ? undefined : "page"}
          >
            All of {district.districtName}
          </Link>
          {district.zones.map((z) => (
            <Link
              key={z.id}
              href={href(district.districtId, z.id)}
              {...chip(z.id === place?.zoneId)}
              aria-current={z.id === place?.zoneId ? "page" : undefined}
            >
              {z.name}
            </Link>
          ))}
        </div>
      ) : null}
    </nav>
  );
}
