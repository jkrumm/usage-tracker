import type { SQL } from "bun";
import { parseAccount, type Account } from "../models.ts";

// The Postgres side of the hook's session_env lines (usage.session_env): base_url, USAGE_LANE and the Max account
// per session id. The claude-code hook-log parsing in models.ts still fills the SQLite store; porting it is a later
// step, this is the API it will call. The writer (writer.ts) reads it to classify billing and account.

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
 * Insert or refresh session_env lines. The newest line wins for base_url and lane (a resume can change both), but a
 * line without `account` (a hook that predates the field) never erases a stored one. Idempotent, safe concurrently.
 */
export async function upsertSessionEnv(sql: SQL, rows: SessionEnvInput[], now: Date = new Date()): Promise<number> {
  // Last line per session wins inside the batch: one ON CONFLICT command cannot touch a row twice.
  const bySession = new Map<string, SessionEnvInput>();
  for (const r of rows) if (r.session) bySession.set(r.session, r);
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
        base_url = EXCLUDED.base_url,
        lane = EXCLUDED.lane,
        account = coalesce(EXCLUDED.account, e.account),
        seen_at = EXCLUDED.seen_at`;
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
