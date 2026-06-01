export * from "./schema";
export { db, getDb, getPool } from "./client";
// Note: deleteOldNotifications is NOT re-exported here — it's a CLI/worker
// concern, importing it would drag retention.ts (with its node:url +
// process.exit guard) into every web-side bundle that touches @gml/db.
// Worker imports via the explicit subpath: "@gml/db/scripts/retention".
