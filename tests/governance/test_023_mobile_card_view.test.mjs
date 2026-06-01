import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const COMPONENT_PATH = "apps/web/src/admin/components/MobileEntityCardList.tsx";
const PAGE_PATH = "apps/web/src/app/(authenticated)/admin/data/[entity]/page.tsx";

test("MobileEntityCardList component file exists at the documented path", () => {
  assert.ok(
    existsSync(resolve(root, COMPONENT_PATH)),
    `Spec 023 requires ${COMPONENT_PATH}`,
  );
});

test("MobileEntityCardList is a client component with the expected named exports", () => {
  const src = read(COMPONENT_PATH);
  assert.match(src, /^"use client";/, 'must start with "use client" directive');
  assert.match(src, /export function MobileEntityCardList/);
  assert.match(src, /export type MobileEntityCardListProps/);
  assert.match(src, /export type MobileCardColumn/);
});

test("MobileEntityCardList renders cards with the GML design tokens (card-hi, line, r-3, padding 14, gap 8)", () => {
  const src = read(COMPONENT_PATH);
  assert.match(src, /var\(--card-hi\)/, "card background uses --card-hi");
  assert.match(src, /1px solid var\(--line\)/, "card border uses --line");
  assert.match(src, /borderRadius:\s*"var\(--r-3\)"/, "card radius uses --r-3");
  assert.match(src, /padding:\s*14/, "card padding 14");
  assert.match(src, /gap:\s*8/, "card gap 8");
});

test("Card title uses serif 16px and KV labels are uppercase 10px tracking 0.07em var(--ink-3)", () => {
  const src = read(COMPONENT_PATH);
  assert.match(src, /fontFamily:\s*"var\(--serif\)"/);
  assert.match(src, /fontSize:\s*16/);
  // KV label tokens
  assert.match(src, /textTransform:\s*"uppercase"/);
  assert.match(src, /letterSpacing:\s*"0\.07em"/);
  assert.match(src, /color:\s*"var\(--ink-3\)"/);
  assert.match(src, /fontSize:\s*10/);
});

test("Hindi name (SM-7) is rendered conditionally in var(--deva)", () => {
  const src = read(COMPONENT_PATH);
  assert.match(src, /var\(--deva\)/, "Hindi text must use --deva font family");
  assert.match(src, /hindiName/, "must read hindiName field");
  // The Hindi name pickHindi helper must do a presence check before render
  assert.match(src, /trim\(\)/, "Hindi pick must trim before length-check");
  assert.match(src, /\.length\s*>\s*0/, "Hindi pick must guard against empty string");
});

test("Each card exposes Export CSV and View row affordances pointing at the right URLs", () => {
  const src = read(COMPONENT_PATH);
  assert.match(src, /Export CSV/);
  assert.match(src, /View row/);
  assert.match(src, /\/api\/admin\/data\/\$\{entitySlug\}\/export/);
  assert.match(src, /\/admin\/data\/\$\{entitySlug\}/);
});

test("[entity]/page.tsx imports getDeviceType + MobileEntityCardList and branches on device", () => {
  const src = read(PAGE_PATH);
  assert.match(src, /from "@\/lib\/device"/, "page must import from @/lib/device");
  assert.match(src, /getDeviceType/);
  assert.match(src, /MobileEntityCardList/);
  assert.match(src, /from "@\/admin\/components\/MobileEntityCardList"/);
  assert.match(src, /device === "mobile"/, "must branch on the device value");
});

test("[entity]/page.tsx preserves dynamic=force-dynamic and the existing table for desktop", () => {
  const src = read(PAGE_PATH);
  assert.match(src, /export const dynamic = "force-dynamic"/);
  // Desktop table is still in the source — we hide it on mobile, not delete it.
  assert.match(src, /<table className="min-w-full text-sm">/);
  assert.match(src, /Add new/);
});

test("Empty rows fall back to a friendly message that references the entity label", () => {
  const src = read(COMPONENT_PATH);
  assert.match(src, /No /, "empty state must say 'No <entity> yet'");
  assert.match(src, /entityLabel\.toLowerCase\(\)/);
});
