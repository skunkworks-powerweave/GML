# Research 073

## D-001 — Version bump strategy: numeric increment vs SemVer

The `feedback_forms.version` column is `text` (not numeric), allowing free-form values like "1", "2.3", or "draft-Q2". v1 ships a pragmatic regex check (`^\d+(\.\d+)?$`) — numeric paths increment the last component, non-numeric paths get a "+1" suffix. No SemVer dependency added (we don't need MAJOR.MINOR.PATCH semantics for form schemas; admins rarely bump majors). Deterministic + pure → trivial to unit-test in the governance file.
