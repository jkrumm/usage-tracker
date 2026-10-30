import { SQL } from "bun";
import { afterAll, describe } from "bun:test";
import { randomBytes } from "node:crypto";

// Postgres test harness. `make check` injects USAGE_TEST_PG_URL (an admin connection to the maintenance
// database) through secrets-run; each suite creates a scratch database `usage_test_<random>`, connects to
// it as admin and drops it afterwards. Without the variable the suites skip, with the reason in their name.

const ADMIN_URL = process.env.USAGE_TEST_PG_URL;
export const pgEnabled = Boolean(ADMIN_URL);
const SCRATCH_NAME = /^usage_test_[0-9a-f]{12}$/;

/** The admin role can drop anything on the shared server, so only names this helper generates ever reach DDL. */
export function assertScratchName(name: string): string {
  if (!SCRATCH_NAME.test(name)) throw new Error(`refusing to create or drop database ${JSON.stringify(name)}: not usage_test_<12 hex>`);
  return name;
}

export const SKIP_REASON = "skipped: USAGE_TEST_PG_URL unset (run via make check / secrets-run)";

if (!pgEnabled) console.warn(`pg tests ${SKIP_REASON}`);

export function describePg(name: string, fn: () => void): void {
  if (pgEnabled) describe(name, fn);
  else describe.skip(`${name} (${SKIP_REASON})`, fn);
}

/** A scratch database for the current suite. Call inside describePg; dropped in afterAll. */
export function scratchDb(): { connect(): Promise<SQL> } {
  let url: string | undefined;
  let admin: SQL | undefined;
  const dbName = assertScratchName(`usage_test_${randomBytes(6).toString("hex")}`);
  const opened: SQL[] = [];

  afterAll(async () => {
    for (const s of opened) await s.close({ timeout: 1 }).catch(() => undefined);
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${assertScratchName(dbName)} WITH (FORCE)`).catch(() => undefined);
      await admin.close().catch(() => undefined);
    }
  });

  return {
    async connect() {
      if (!url) {
        admin = new SQL({ url: ADMIN_URL as string, max: 1 });
        await admin.unsafe(`CREATE DATABASE ${assertScratchName(dbName)}`);
        const u = new URL(ADMIN_URL as string);
        u.pathname = `/${dbName}`;
        url = u.toString();
      }
      const sql = new SQL({ url, max: 4 });
      opened.push(sql);
      return sql;
    },
  };
}
