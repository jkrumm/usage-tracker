import type { SQL } from "bun";
import { migrate } from "./migrate.ts";
import { scratchDb } from "./testing.ts";

// A migrated scratch database shared by the tests of one suite: call inside describePg, `reset()` in beforeEach.

const STATE_TABLES = [
  "usage.records", "usage.sessions", "usage.collector_state", "usage.session_env", "usage.quota_samples",
  "usage.account_picks", "usage.iu_portal_cost", "usage.iu_portal_total",
];

export function migratedDb(): { sql(): Promise<SQL>; reset(): Promise<SQL> } {
  const db = scratchDb();
  let pool: Promise<SQL> | undefined;
  const sql = (): Promise<SQL> =>
    (pool ??= (async () => {
      const s = await db.connect();
      await migrate(s);
      return s;
    })());
  return {
    sql,
    async reset() {
      const s = await sql();
      await s.unsafe(`TRUNCATE ${STATE_TABLES.join(", ")} RESTART IDENTITY CASCADE`);
      return s;
    },
  };
}
