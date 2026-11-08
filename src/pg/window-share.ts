import type { SQL } from 'bun'

/**
 * Refresh the stored `usage.session_window_share` (migration 0023). CONCURRENTLY: readers keep the previous contents
 * until the new ones swap in. Needs no transaction block, so it is one plain statement on a pooled connection.
 */
export async function refreshWindowShare(sql: SQL): Promise<{ rows: number }> {
  await sql`REFRESH MATERIALIZED VIEW CONCURRENTLY usage.session_window_share`
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM usage.session_window_share`
  return { rows: n as number }
}
