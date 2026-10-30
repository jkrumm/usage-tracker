import type { SQL } from "bun";
import { parseAccount, type Account } from "../models.ts";

// The Postgres side of the hook's session_env lines (usage.session_env): base_url, USAGE_LANE and the Max account
// per session id. The hook-log parsing in models.ts (`pendingSessionEnvs`) feeds `upsertSessionEnv` from `ingest`; the
// writer (writer.ts) reads the table back to classify billing, account and lane.

export interface SessionEnvRow {
  session: string;
  base_url: string | null;
  lane: string | null;
  /** Claude Max account id; null on lines older than the account field. */
  account: Account | null;
  seen_at: Date;
}

export type SessionEnvInput = Pick<SessionEnvRow, "session"> &
  Partial<Pick<SessionEnvRow, "base_url" | "lane" | "account" | "seen_at">>;

const CHUNK = 1000;

/**
 * Insert or refresh session_env lines; `seen_at` is the source line's own timestamp (process time only when the line
 * has none). The newest line wins: a line older than the stored one changes nothing but fills a NULL lane or account,
 * so replaying an old log or the SQLite archive never rolls a session back. Among equal-or-newer lines `base_url` is
 * replaced as given (NULL is a real value there: no gateway, a Max session) while a NULL `lane` (a resume without
 * USAGE_LANE) or `account` (a hook that predates the field) never erases a stored one. Idempotent, safe concurrently.
 */
export async function upsertSessionEnv(sql: SQL, rows: SessionEnvInput[], now: Date = new Date()): Promise<number> {
  // Newest line per session wins inside the batch (the later one on a tie): one ON CONFLICT command cannot touch a row twice.
  const bySession = new Map<string, SessionEnvInput>();
  for (const r of rows) {
    if (!r.session) continue;
    const prev = bySession.get(r.session);
    if (prev && (prev.seen_at?.getTime() ?? now.getTime()) > (r.seen_at?.getTime() ?? now.getTime())) continue;
    bySession.set(r.session, r);
  }
  const items = [...bySession.values()].sort((a, b) => (a.session < b.session ? -1 : 1));
  for (let i = 0; i < items.length; i += CHUNK) {
    const payload = items.slice(i, i + CHUNK).map((r) => ({
      session: r.session,
      base_url: r.base_url ?? null,
      lane: r.lane ?? null,
      account: parseAccount(r.account),
      seen_at: (r.seen_at ?? now).toISOString(),
    }));
    await sql`
      INSERT INTO usage.session_env AS e (session, base_url, lane, account, seen_at)
      SELECT session, base_url, lane, account, seen_at
      FROM jsonb_to_recordset(${JSON.stringify(payload)}::text::jsonb)
        AS j(session text, base_url text, lane text, account text, seen_at timestamptz)
      ORDER BY session
      ON CONFLICT (session) DO UPDATE SET
        base_url = CASE WHEN EXCLUDED.seen_at >= e.seen_at THEN EXCLUDED.base_url ELSE e.base_url END,
        lane = CASE WHEN EXCLUDED.seen_at >= e.seen_at THEN coalesce(EXCLUDED.lane, e.lane) ELSE coalesce(e.lane, EXCLUDED.lane) END,
        account = CASE WHEN EXCLUDED.seen_at >= e.seen_at THEN coalesce(EXCLUDED.account, e.account) ELSE coalesce(e.account, EXCLUDED.account) END,
        seen_at = greatest(EXCLUDED.seen_at, e.seen_at)
      WHERE EXCLUDED.seen_at >= e.seen_at
         OR (e.lane IS NULL AND EXCLUDED.lane IS NOT NULL)
         OR (e.account IS NULL AND EXCLUDED.account IS NOT NULL)`;
  }
  return items.length;
}

/** The stored lines of the given session ids; ids without a line are absent from the map. */
export async function readSessionEnv(sql: SQL, sessions: Iterable<string>): Promise<Map<string, SessionEnvRow>> {
  const ids = [...new Set(sessions)].filter(Boolean);
  const out = new Map<string, SessionEnvRow>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const rows = await sql`SELECT session, base_url, lane, account, seen_at FROM usage.session_env WHERE session IN ${sql(part)}`;
    for (const r of rows) {
      out.set(String(r.session), {
        session: String(r.session),
        base_url: r.base_url ?? null,
        lane: r.lane ?? null,
        account: parseAccount(r.account),
        seen_at: new Date(r.seen_at as string | Date),
      });
    }
  }
  return out;
}

/** The two lookups classifyBilling and resolveAccount take, backed by a prefetched map. */
export function sessionEnvLookups(env: Map<string, SessionEnvRow>) {
  return {
    baseUrl: (session: string | null | undefined): string | null | undefined =>
      session ? env.get(session)?.base_url : undefined,
    account: (session: string): Account | null | undefined => env.get(session)?.account,
  };
}
