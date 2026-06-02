# Research 130

Two non-obvious choices for threading catalogue context through `/forms/[slug]`:

1. **Closed allow-list, not a free-form `context` bag.** The brief implies the
   four context keys (`cycleId`, `quarter`, `observerId`, `kind`) are
   meaningful to the response record, but adding "accept any key starting with
   `__ctx_`" would re-open the HTML-injection surface (a crafted URL could plant
   surprise hidden inputs the server then trusts). The closed
   `CONTEXT_KEYS = ["cycleId", "quarter", "observerId", "kind"] as const` is a
   single line to edit when new context keys arrive, and `sanitizeContextValue`
   enforces shape rules per key (quarter is a `1..4` integer, IDs are a safe
   character class capped at 64 chars). The server action re-sanitizes on
   submit so a tampered DOM cannot smuggle a bad value through.

2. **Prefill is gated on `schema.fields[].name`, not on the URL.** The naive
   reading of "any `?prefill_<key>=value` becomes a default" is unsafe — a
   crafted URL could plant `prefill___formId=…` or `prefill_csrf=…` and try to
   get the renderer to surface unexpected hidden inputs. We instead build a
   `Set` of the active form's `fields[].name`, drop any `prefill_<key>` whose
   `<key>` isn't in the set, and only then merge the survivors into
   `initialResponses`. Prefill is layered **under** existing draft / prior
   responses so a starting hint never overrides work-in-progress.

A third subtle point: the existing FormRenderer accepts `action`, `formId`,
`slug`, `pairingId` props but never destructured or rendered them. That was a
latent bug from spec 074 — the hidden inputs the server action depends on were
never planted. This spec wires them up alongside the new `context` prop, which
is the smallest change that lets `submitFormAction` actually read its inputs.
