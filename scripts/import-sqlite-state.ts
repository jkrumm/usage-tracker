#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { importState } from "../src/backfill-state.ts";
import { connect } from "../src/pg/connect.ts";

// One-off, re-runnable import of the SQLite archive's state tables into the usage schema: collector_state (cursors and
// bookkeeping), session_env, quota_sample -> quota_samples, account_pick -> account_picks, iu_portal_cost and
// iu_portal_total. The archive is opened read-only. Safe to run again at cutover: it never overwrites a cursor or a
// line the Postgres pipeline has written since (see src/backfill-state.ts).
//
//   bun scripts/import-sqlite-state.ts [--db <usage.db>]

const i = process.argv.indexOf("--db");
const path = (i >= 0 ? process.argv[i + 1] : undefined) ?? process.env.USAGE_DB ?? join(homedir(), ".local/share/usage-tracker/usage.db");

const db = new Database(path, { readonly: true });
const sql = connect();
try {
  const result = await importState(db, sql);
  for (const [table, c] of Object.entries(result)) {
    console.log(`usage.${table}: read ${c.read}, added ${c.added}${c.skipped?.length ? `, skipped ${c.skipped.join(", ")} (retired Argo sync)` : ""}`);
  }
} finally {
  db.close();
  await sql.close();
}
