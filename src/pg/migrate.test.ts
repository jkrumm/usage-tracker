import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, readMigrations } from "./migrate.ts";
import { describePg, scratchDb } from "./testing.ts";

describePg("pg migrations", () => {
  const db = scratchDb();
  const files = readMigrations();
  // Created on first use (a skipped suite still runs this body) and removed once, after the suite.
  let tmp: string | undefined;
  afterAll(() => tmp && rmSync(tmp, { recursive: true, force: true }));
  const freshDir = (name: string) => {
    tmp ??= mkdtempSync(join(tmpdir(), "mig-"));
    const dir = join(tmp, name);
    mkdirSync(dir);
    return dir;
  };

  test("from empty applies every file, the second run is a no-op", async () => {
    const sql = await db.connect();
    const first = await migrate(sql);
    expect(first.applied.length).toBe(files.length);
    expect(first.alreadyApplied).toBe(0);

    const second = await migrate(sql);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toBe(files.length);

    const rows = await sql`SELECT version, name, checksum FROM usage.schema_migrations ORDER BY version`;
    expect(rows.map((r: { version: number }) => r.version)).toEqual(files.map((f) => f.version));
    expect(rows[0].checksum).toBe(files[0]?.checksum);
  });

  test("creates the target tables with the v2 keys", async () => {
    const sql = await db.connect();
    const tables = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'usage' ORDER BY 1`;
    expect(tables.map((t: { table_name: string }) => t.table_name)).toEqual([
      "account_picks",
      "price_aliases",
      "price_overrides",
      "prices",
      "quota_samples",
      "records",
      "schema_migrations",
      "sessions",
    ]);
    const [{ n }] = await sql`
      SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'usage' AND tablename = 'records'`;
    expect(n).toBe(8);
  });

  test("a changed applied file is refused", async () => {
    const sql = await db.connect();
    const dir = freshDir("changed");
    writeFileSync(join(dir, "0200_a.sql"), "CREATE TABLE usage.t1 (id int);");
    await migrate(sql, { dir });
    writeFileSync(join(dir, "0200_a.sql"), "CREATE TABLE usage.t1 (id bigint);");
    await expect(migrate(sql, { dir })).rejects.toThrow(/changed after it was applied/);
  });

  test("a failing file rolls back and leaves no row behind", async () => {
    const sql = await db.connect();
    const dir = freshDir("bad");
    writeFileSync(join(dir, "0090_bad.sql"), "CREATE TABLE usage.half (id int); SELECT 1/0;");
    await expect(migrate(sql, { dir })).rejects.toThrow();
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'usage' AND table_name = 'half'`;
    expect(n).toBe(0);
    const [{ m }] = await sql`SELECT count(*)::int AS m FROM usage.schema_migrations WHERE version = 90`;
    expect(m).toBe(0);
  });

  test("concurrent runners serialise on the advisory lock", async () => {
    const sql = await db.connect();
    const dir = freshDir("race");
    writeFileSync(join(dir, "0100_race.sql"), "CREATE TABLE usage.race (id int);");
    const results = await Promise.all([migrate(sql, { dir }), migrate(sql, { dir })]);
    expect(results.map((r) => r.applied.length).sort()).toEqual([0, 1]);
  });
});
