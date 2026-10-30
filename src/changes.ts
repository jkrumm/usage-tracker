import { readFileSync } from "node:fs";
import { join } from "node:path";

// The record of change ref -> finding id (docs/usage-schema.md §Finding changes). A tracked file the weekly report reads:
// nothing is stored in the database, the report recomputes a finding's metric for both weeks and prints the change next to it.

export const DEFAULT_CHANGES_PATH = join(import.meta.dir, "..", "docs", "finding-changes.json");

export const CHANGE_STATUSES = ["landed", "declined", "handed-off"] as const;
export type ChangeStatus = (typeof CHANGE_STATUSES)[number];

/** One entry of `docs/finding-changes.json`. */
export interface ChangeRecord {
  /** A finding id as the report prints it: `<rule>:<subject>`. */
  finding: string;
  /** `landed`: a change is in place (`ref` names it). `declined`: looked at, no change, `summary` says why. `handed-off`: another owner lands it. */
  status: ChangeStatus;
  /** UTC day (`YYYY-MM-DD`) the change landed or the decision was made. */
  date: string;
  /** `<repo>@<short sha>`; required for `landed`. */
  ref: string | null;
  summary: string;
}

/** Where a change stands against the week a report covers: `full` = both compared weeks ran under it, `partial` = it landed in one of them, `not-yet` = it lands after the report week. Only `landed` changes have one. */
export type ChangeExposure = "full" | "partial" | "not-yet";

export interface ChangeNote extends ChangeRecord {
  /** ISO week of `date`. */
  week: string;
  /** The first report week whose two compared weeks both ran wholly under a `landed` change: two weeks after `week`. */
  cleanFrom: string | null;
  exposure: ChangeExposure | null;
}

// The subject is whatever a role, lane, skill or subagent type is called (spaces and parentheses included), but never an address or a reference.
const ID_RE = /^[a-z][a-z-]*:[A-Za-z0-9(][A-Za-z0-9 :._()-]{0,60}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REF_RE = /^[a-z0-9][a-z0-9._-]*@[0-9a-f]{7,40}$/;

/** `Date` rolls 2026-02-30 over to March 2, which would put the change in the wrong week: a day must round-trip. */
const isDay = (s: string) => {
  const at = new Date(`${s}T00:00:00Z`);
  return DATE_RE.test(s) && !Number.isNaN(at.getTime()) && at.toISOString().startsWith(s);
};

/** Strict: a malformed record throws with its index, so a typo never silently drops a change from the report. */
export function parseChanges(json: string): ChangeRecord[] {
  const data: unknown = JSON.parse(json);
  if (!Array.isArray(data)) throw new Error("finding changes: the file must hold a JSON array");
  const seen = new Set<string>();
  return data.map((raw, i) => {
    const where = `finding changes[${i}]`;
    if (typeof raw !== "object" || raw === null) throw new Error(`${where}: not an object`);
    const r = raw as Record<string, unknown>;
    const { finding, status, date, ref, summary } = r;
    if (typeof finding !== "string" || !ID_RE.test(finding)) throw new Error(`${where}: finding must look like <rule>:<subject>`);
    if (!CHANGE_STATUSES.includes(status as ChangeStatus)) throw new Error(`${where}: status must be one of ${CHANGE_STATUSES.join(", ")}`);
    if (typeof date !== "string" || !isDay(date)) throw new Error(`${where}: date must be a real day, YYYY-MM-DD`);
    if (ref !== undefined && ref !== null && (typeof ref !== "string" || !REF_RE.test(ref))) throw new Error(`${where}: ref must look like <repo>@<sha>`);
    if (status === "landed" && (ref === undefined || ref === null)) throw new Error(`${where}: a landed change needs a ref`);
    if (typeof summary !== "string" || summary.trim() === "") throw new Error(`${where}: summary is required`);
    const key = `${finding}@${date}`;
    if (seen.has(key)) throw new Error(`${where}: duplicate entry for ${finding} on ${date}`);
    seen.add(key);
    return { finding, status: status as ChangeStatus, date, ref: (ref as string | null | undefined) ?? null, summary: summary.trim() };
  });
}

/** The file is tracked and the report depends on it: a missing, unreadable or malformed one throws, never an empty report. */
export function loadChanges(path = DEFAULT_CHANGES_PATH): ChangeRecord[] {
  return parseChanges(readFileSync(path, "utf8"));
}
