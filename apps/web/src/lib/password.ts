// Shared bcrypt cost.
//
// USER PASSWORDS ARE NO LONGER HASHED HERE. `hashPassword` and `verifyPassword`
// are gone along with `users.password_hash`: credentials live in Supabase's
// auth.users and are verified by GoTrue. Keeping local helpers around would
// invite someone to reintroduce a second, unauthoritative credential store.
//
// What remains is the SECTION GATE password -- a shared, rotatable, per-section
// secret that is not a user credential and has no Supabase equivalent. It is
// hashed by api/admin/gates/[slug]/rotate and compared by gate/[slug]/actions.
//
// One exported constant, so a future cost bump is a one-line change rather than
// a hunt for literal 10s. packages/db/src/scripts/seed.ts also hashes a gate
// password and cannot import across the workspace boundary, so it duplicates
// the value with a comment pointing here; the governance test pins both.
export const BCRYPT_COST = 10;
