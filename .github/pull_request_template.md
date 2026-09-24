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

<!-- The merge hook greps this body for the verdict field below. The field
     ships UNAPPROVED and stays that way until a review has actually happened:
     once the diff has been read, change `pending` to the single word
     `approved`, alone on that line.

     Do not write the satisfying form anywhere else in this body, and do not
     write it here in advance. This template used to spell it out in this very
     sentence — so every pull request opened from the default template cleared
     the merge gate with no review at all, and the line in the PR body read as
     though a human had put it there. A gate whose own form letter approves it
     is the exact failure this layer exists to end.
     `tests/hooks/template-not-self-approving.test.mjs` pins that: it extracts
     the live pattern from `.claude/hooks/pre-bash.mjs` and asserts this file
     does not satisfy it.

     A qualified verdict is not an approval. Nits, caveats or conditions mean
     the field stays `pending` until they are resolved. Do not lean on the hook
     to notice: its pattern is an unanchored substring match today, so a
     qualified verdict would slip past it (finding I6, being anchored
     separately). The field is yours to keep honest. -->

```
Review-Verdict: pending
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
