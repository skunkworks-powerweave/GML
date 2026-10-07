# GML LMS — QA plan

**For:** IT's QA on the **staging** environment, one release candidate at a time (for example `v1.0.0-rc.1`).
**Result:** a pass or fail for every check below, and one bug report per failure (format at the end).
**Promote to production** only when the exit criteria at the end are met.

Each check has an ID. Quote it in bug reports and sign-off notes, e.g. `QA-TEA-05`.

---

## 0. Before you start

| # | Setup | Notes |
|---|---|---|
| S-1 | The release candidate is on staging | GitHub Release published → `deploy` workflow green. `https://<staging>/api/health` shows `"ok":true` and `migrationsApplied` equal to `migrationsExpected`. |
| S-2 | Sign in as the super admin | The account named by `SUPER_ADMIN_EMAIL` in the server's `.env`, with its initial password. You are asked to choose your own password at once. |
| S-3 | Note the three section passwords | Printed once by the first deploy's seed step (Observation, Mentorship, Audit log). Rotate them at `/admin/gates` if nobody wrote them down. |
| S-4 | Create one account per role | At `/admin/users`: a **programme admin**, a **teacher** (link it to a teacher record, e.g. Fatima Bano), a **mentor** (link it to a mentor record, e.g. Dr. Anjali Bhatt), an **observer**. Each must change the initial password at first sign-in. |
| S-5 | Have the sample files | A SCORM 1.2 zip and a short MP4, supplied with the handover email. |
| S-6 | A phone, or the browser's device toolbar (F12) | Several checks are repeated at phone width. |

The seed loads **demonstration data** (schools, teachers, cycles, pairings) so every screen has something on it. Staging keeps it; production clears it before go-live (`README-deploy.md` 3.1).

---

## 1. First-deploy acceptance (once per environment)

Never exercised before this release. Each needs a real server, domain or Meta account.

| ID | Check | Expected |
|---|---|---|
| QA-ACC-01 | Open `https://<domain>` in a browser | A valid certificate (Let's Encrypt), no warning. `http://` redirects to `https://`. |
| QA-ACC-02 | On the server: `docker compose run --rm --no-deps migrate pnpm exec tsx scripts/verify-auth.mjs` | Every line `PASS`, including `access-token lifetime — 900s`. |
| QA-ACC-03 | "Forgot?" on the login page, for a real mailbox | The reset email arrives, and its link sets a new password. |
| QA-ACC-04 | Send a short video from a registered phone to the WhatsApp number | It appears under `/admin/whatsapp-log`, is transcoded, and plays in the video library. The sender gets a reply. Needs Meta keys (`README-IT.md` → WhatsApp Business setup). |
| QA-ACC-05 | Backups: run `scripts/backup.sh`, then the weekly restore drill (`README-deploy.md` 7) | The dump reaches S3, and the drill passes. **Without a drill in the last 30 days, the next deploy refuses to run.** |
| QA-ACC-06 | A second deploy of the same tag (Actions → deploy → Run workflow) | Completes. Nothing changes, and health stays ok throughout. |

---

## 2. Every signed-in role

| ID | Check | Expected |
|---|---|---|
| QA-ALL-01 | Sign in, sign out | Sign-out returns to `/login`. A wrong password gives a clear message. |
| QA-ALL-02 | Open any inside page while signed out | Sent to login, then back to that page after signing in. |
| QA-ALL-03 | Login page: EN / हिन्दी / བོད་ | The whole page switches language. |
| QA-ALL-04 | Settings → Language → हिन्दी, then བོད་ཡིག | Every page is translated: menus, buttons, messages, dates, help, the tour. People's names and entered text stay as typed. |
| QA-ALL-05 | Settings → Change password | Works. Other devices are signed out. |
| QA-ALL-06 | Top bar: bell (inbox), **?** help panel, quick find (Ctrl+K) | Each opens. Clicking an inbox message opens the thing it is about. |
| QA-ALL-07 | Open a page your role may not use (e.g. `/admin` as a teacher) | **Forbidden**. A page that does not exist gives **404**. |
| QA-ALL-08 | At phone width | Bottom tabs, and **Menu** reaches every page. No sideways scrolling. |

## 3. Teacher

| ID | Check | Expected |
|---|---|---|
| QA-TEA-01 | Dashboard | Tiles for uploads, cycles, quizzes, and a **My teaching** card. |
| QA-TEA-02 | My classes → add a grade, optional section and subject | Listed. Remove deletes only her link, not the class. |
| QA-TEA-03 | My students → add, edit, remove a student | Only her own classes' students are listed. Remove keeps the history. |
| QA-TEA-04 | My classroom sessions → plan a session (class, subject, date, status Complete) → take attendance → **Send for approval** | "Send for approval" appears only once attendance is taken. After sending, the session is locked and shows **Pending approval**. |
| QA-TEA-05 | Lesson plans → start a plan → add lessons → reorder → **Send for approval** | Needs at least one lesson. Locked once sent. |
| QA-TEA-06 | Marks → set a test for her class → enter marks | Each student's % and grade, and the class average and pass count, update as you type. Send for approval locks them. |
| QA-TEA-07 | After an admin **requests changes** (QA-PAD-06) | The **My teaching** page lists it under "Sent back to you" with the comment. The record is editable again, and the inbox has the notice. |
| QA-TEA-08 | Repository: Teachers, Students, Classroom sessions | Only **her own** records. Another teacher's record by URL gives 404. |
| QA-TEA-09 | My observations (Observation password) | Her cycles. The post-observation form is due on an "observed" cycle, and submitting it moves the cycle on. |
| QA-TEA-10 | My phase → a subject: reading (PDF, no download button), SCORM module, quiz | The SCORM launches and resumes. The quiz gives a score, a grade band and a history. |
| QA-TEA-11 | Upload a video (My uploads, or a teach-back from a subject) | A progress bar, resumable. About a minute later it plays in the library. |
| QA-TEA-12 | Mentorship (Mentorship password) | Her pairing, meetings, and commitments that tick at once. |
| QA-TEA-13 | Should **not** be possible | Admin pages, nominating or signing off a cycle, the teach-back review queue. |

## 4. Observer

| ID | Check | Expected |
|---|---|---|
| QA-OBS-01 | Observation cycles (password) | Read the teacher's forms. Fill the observer form once the pre-form is in. Attach video. |
| QA-OBS-02 | Score a cycle against the rubric | Every criterion takes a score up to its maximum. The total and level show on the cycle. |
| QA-OBS-03 | Notes: add two in a row | Both appear at once, with name and time. |
| QA-OBS-04 | Pending review → play a teach-back | **Approve** or **Request changes** with feedback. There is **no Reject**. |
| QA-OBS-05 | Should **not** be possible | Signing off, nominating, Mentorship, admin pages. |

## 5. Mentor

| ID | Check | Expected |
|---|---|---|
| QA-MEN-01 | My mentees (password) | Her pairings, with quarters. |
| QA-MEN-02 | A pairing: log a meeting, cancel it; add, tick and untick a commitment | Each change shows at once. The mentee gets an inbox notice in their own language. |
| QA-MEN-03 | Quarterly forms, Responses page | Due forms can be filled; submitted ones are readable. |
| QA-MEN-04 | A mentee's cycle once her post-form is in | A sign-off request is waiting in **Approvals** and on the cycle page (Sign off / Send back). Signed off, the cycle is complete and takes no more notes. Sent back, the teacher sees why. |
| QA-MEN-05 | Review her mentees' teach-backs | Only her mentees'. Approve or Request changes. |

## 6. Programme admin

| ID | Check | Expected |
|---|---|---|
| QA-PAD-01 | Classroom Observation (password) → nominate a cycle | It appears as "nominated". |
| QA-PAD-02 | Data tables: add, edit, delete a row; CSV export; CSV import | Works for subjects, schools, teachers, teacher classes, curriculum (course outlines and lessons), training and student attendance, and grading tables. A delete that would erase records of work is refused, with the reason. On a phone, rows show as cards. |
| QA-PAD-03 | Mark training attendance → an RTT session | Present, late, absent or excused per teacher, with who marked it. "Mark all present" marks everyone left. |
| QA-PAD-04 | Grading → a scale: edit bands; make it the default; switch it off | Band counts are right. Gaps show as a warning. A scale that is in use cannot be deleted. |
| QA-PAD-05 | Grading → the rubric: rename or reorder criteria | Scores already given stay attached. A scored criterion cannot be removed. |
| QA-PAD-06 | Approvals: the teacher's session and plan (QA-TEA-04/05) | **Request changes** needs a comment. **Approve** locks the record. Each decision reaches the teacher's inbox. |
| QA-PAD-07 | Approvals → an account request (after QA-NEW-02) | Approve shows the initial password once. Reject needs a reason. There is no "Request changes". |
| QA-PAD-08 | Users → create a teacher, change a role, deactivate, link to a teacher record | Works. A deactivated account cannot sign in. |
| QA-PAD-09 | Audit log (admin password) → filter → export CSV | Every change made in these checks is listed. |
| QA-PAD-10 | Should **not** be possible | Section gates, System settings, creating admin accounts, uploading SCORM. |
| QA-PAD-11 | Data menu → **Training attendance**, then **Student attendance** | Training attendance opens the RTT attendance table (teachers at training sessions). Student attendance opens "Students' attendance (classroom sessions)" (session, student, attendance, marked by). Teachers, mentors and observers see neither item. |

## 7. Super admin

| ID | Check | Expected |
|---|---|---|
| QA-SUP-01 | Section gates → rotate a password | The new password is shown once, and the old one stops working. |
| QA-SUP-02 | System settings → save a change | A confirmation shows, and the change is in the audit log. |
| QA-SUP-03 | SCORM → upload the sample zip against a subject | Active. Learners see it on that subject. |
| QA-SUP-04 | Users → create an administrator | Works (programme admins cannot). |

## 8. New accounts

| ID | Check | Expected |
|---|---|---|
| QA-NEW-01 | First sign-in of an account an admin created | Settings opens with "Choose your own password to continue". **Every** page, `/teaching` and `/attendance` included, leads back there until it is changed. Then the dashboard and the first-run tour. |
| QA-NEW-02 | Login page → **Request an account** (signed out) | The form is sent. The programme admins see it in Approvals (QA-PAD-07). |

## 9. Working as designed (do not report)

- WhatsApp is **off** until Meta keys are set. `/api/health` then shows `"whatsapp":"off"` and the webhook answers 503.
- "… locked" tiles stay locked until that section's password is entered. The unlock lasts 8 hours, and 5 wrong tries in 15 minutes locks the section for that account.
- Hindi times show "am/pm" in Latin letters.
- The data tables' browser tab title reads just "Goldenmile RTT LMS".

**Do report** any Hindi or Bhoti wording that is wrong or unclear. All of it is machine-drafted and awaiting a native speaker's review.

---

## Reporting a failure

One report per problem, to the development lead:

```
Check:       QA-TEA-04
Release:     v1.0.0-rc.1 (staging)
Role/account: teacher / <email>
Page:        https://<staging>/teaching/sessions/<id>
Steps:       1. …  2. …  3. …
Expected:    …
Actual:      …
When:        2026-10-02 14:20 IST
Attachments: screenshot / screen recording
Severity:    Blocker | High | Medium | Low
```

| Severity | Meaning |
|---|---|
| Blocker | A role cannot do its core job, data is lost or wrong, or someone sees what they must not. |
| High | A feature fails with no workaround. |
| Medium | It works, with a workaround or a confusing step. |
| Low | Cosmetic, wording, layout. |

Each fix comes back as a new release candidate (`-rc.2`, …) with a note of what it fixed. Re-run those checks, plus a quick pass over §2.

## Exit criteria (release candidate → production)

1. Every §1 check passes on staging.
2. No open Blocker or High.
3. Every Medium is either fixed or accepted in writing by the programme owner.
4. The Hindi and Bhoti text is reviewed, or the programme owner accepts launching English-first.
5. The programme owner signs off. The final tag (`v1.0.0`) is then cut from the same commit and deployed to production.
