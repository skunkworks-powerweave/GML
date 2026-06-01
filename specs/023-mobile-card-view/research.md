# Research 023

Chose to derive `title` + card fields from existing `AdminEntity.displayColumns` (first column = title, next 2-3 = KV pairs) rather than adding `titleField` / `cardFields` to the `AdminEntity` type. Every entity's `displayColumns` already places the canonical name first, so adding new registry fields would just duplicate that convention without unlocking new behaviour. The component takes `maxKvFields` (default 3) for per-call overrides if a future caller needs a tighter card.
