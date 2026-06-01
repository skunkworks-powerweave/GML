# Research 054

The `learners` table has **no `hindi_name` column** (schema locked at spec 019/020), so SM-7 bilingual rendering does not apply for learner records — only `name varchar(160)` exists. Guardian is also a single plain-text field. Rendering only English is therefore correct and 1:1 with the JSX prototype which also shows a single name.
