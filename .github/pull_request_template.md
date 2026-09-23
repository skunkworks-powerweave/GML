<!--
This template asks for evidence, not for description.

The reason is specific to this repository. Its ledger recorded `1549/1549
passing` and `PRODUCTION LAUNCH READY` while the application returned HTTP 500
on its own login page; every test in its history shipped in the same commit as
the code it tests, and at least 28 assertions ended up pinning defects in
place. Prose cannot distinguish that from real work. Pasted output can.

Delete nothing. A section that does not apply gets `n/a` and one line saying
why — an empty section reads as an oversight, `n/a: no migrations touched`
reads as a decision.
-->

## Plan link

<!-- specs/<nnn>-<slug>/plan.md, or the issue this implements. If there is no
     plan, say so here and why this change did not need one. -->

Plan:

## RED evidence

<!-- The test existed and FAILED before the code existed. Paste the actual
     failing line from `node --test` -- the real `not ok N - <name>` and its
     error, not a summary of it -- and the timestamp of the receipt in
     workspace/test-receipts.jsonl that recorded the red run. -->

```
not ok
```

Receipt timestamp (RED):

## GREEN evidence

<!-- The same test, passing, after the implementation. Paste the `ok N` line
     and the suite totals. -->

```
```

Receipt timestamp (GREEN):

## Mutation check

<!-- Proves the new test actually constrains the new code. Revert ONE hunk of
     the implementation, re-run, and confirm a test fails. A test that still
     passes with the code removed is measuring nothing -- which is what 28
     assertions in this repo turned out to be doing. -->

Hunk reverted:

Test that failed as a result:

## Review

<!-- The diff was read by something other than the agent that wrote it. -->

- BASE_SHA:
- HEAD_SHA:
- Reviewer findings (one line each; `none` is a finding and needs a sentence
  saying what was examined):

The merge hook greps this body for the verdict line below. It must stay at the
start of a line and read exactly `Review-Verdict: approved` to merge; anything
else — including `approved-with-nits` — blocks.

```
Review-Verdict:
```

## Verification commands with output

<!-- What you ran, and what it printed. Commands without output are claims. -->

```
$
```

## Overrides used

<!-- Every GML_GATE_SKIP used while producing this change, quoted verbatim from
     workspace/gate-overrides.log, with the reason it was justified.

     The escape hatch exists so a gate that is wrong can be stepped around
     instead of being deleted wholesale. Its price is visibility: an override
     that reaches main unquoted is a gate that has quietly stopped existing. -->

`none` / paste the `GML_GATE_SKIP` lines:

```
```
