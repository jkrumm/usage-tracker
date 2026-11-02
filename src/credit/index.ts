import type { SQL } from 'bun'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { log } from '../log.ts'
import { adminWindows, fetchCost, type Chunk, type CostRow } from './admin-api.ts'
import { cycleOf, previousCycle, type Cycle } from './cycle.ts'

// The credit pass (docs/usage-schema.md §API credit, docs/collectors.md §Admin API): per Claude Console org with a
// `platform` block in the account registry, (a) the provider's daily cost into usage.platform_cost, (b) the current and
// previous credit cycle into usage.credit_cycles, reconciled against (a) once the provider's snapshot is past the end.

const SECRET_TIMEOUT_MS = 20_000
/** A closed cycle's reconciled figure follows the provider's revisions for this long after its end. */
const REVISION_DAYS = 7

export interface PlatformAccount {
  id: string
  creditUsd: number
  /** Day of month the credit expires/renews (UTC midnight); null = unknown. */
  cycleDay: number | null
  adminKeyRef: string | null
}

export interface CreditPassOptions {
  /** Replace the registry (tests). */
  accounts?: PlatformAccount[]
  /** Replace `secrets-run read` (tests): the secret, or null when it does not resolve. */
  resolveSecret?: (ref: string) => Promise<string | null>
  /** Admin API origin (tests point it at a fake server). */
  baseUrl?: string
  now?: Date
  /** Minimum trailing window in days (default 35). */
  days?: number
}

export interface CreditPassResult {
  /** platform_cost rows upserted. */
  platformCost: number
  /** credit_cycles rows upserted. */
  cycles: number
}

function registryPath(): string {
  return (
    process.env.USAGE_CLAUDE_ACCOUNTS ??
    join(homedir(), 'SourceRoot', 'dotfiles', 'config', 'claude-accounts.json')
  )
}

/** The accounts that have a `platform` block; an absent registry (not the mini) is an empty list. */
export function loadPlatformAccounts(path = registryPath()): PlatformAccount[] {
  if (!existsSync(path)) {
    log.info(`credit: no account registry at ${path}, skipped`)
    return []
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    accounts?: Record<string, { platform?: Record<string, unknown> }>
  }
  const out: PlatformAccount[] = []
  for (const [id, acct] of Object.entries(parsed.accounts ?? {})) {
    const p = acct?.platform
    if (!p || typeof p !== 'object') continue
    if (typeof p.creditUsd !== 'number' || !Number.isFinite(p.creditUsd)) {
      log.warn(`credit: ${id}: platform.creditUsd is not a number, skipped`)
      continue
    }
    const cycleDay = p.cycleDay ?? null
    if (
      cycleDay !== null &&
      (!Number.isInteger(cycleDay) || (cycleDay as number) < 1 || (cycleDay as number) > 31)
    ) {
      log.warn(`credit: ${id}: platform.cycleDay is not 1-31 or null, skipped`)
      continue
    }
    out.push({
      id,
      creditUsd: p.creditUsd,
      cycleDay: cycleDay as number | null,
      adminKeyRef: typeof p.adminKeyRef === 'string' && p.adminKeyRef ? p.adminKeyRef : null,
    })
  }
  return out
}

/** `secrets-run read <ref>` (never `op`: it hangs on a headless Mac). A placeholder or empty value is "missing". */
export async function resolveSecret(ref: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(['secrets-run', 'read', ref], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: SECRET_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    })
    const out = (await new Response(proc.stdout).text()).trim()
    if ((await proc.exited) !== 0) return null
    return out === '' || out.startsWith('REPLACE') ? null : out
  } catch {
    return null
  }
}

/** The oldest snapshot among the chunks that read [start, end), or null when the window does not span the whole cycle. */
function snapshotCovering(chunks: Chunk[], cycle: Cycle): Date | null {
  const overlapping = chunks.filter((c) => c.from < cycle.end && c.to > cycle.start)
  if (overlapping.length === 0) return null
  const first = Math.min(...overlapping.map((c) => c.from.getTime()))
  const last = Math.max(...overlapping.map((c) => c.to.getTime()))
  // An open cycle ends after today's last bucket, so it is never covered and never closes.
  if (first > cycle.start.getTime() || last < cycle.end.getTime()) return null
  return new Date(Math.min(...overlapping.map((c) => c.refreshedAt.getTime())))
}

async function writePlatformCost(sql: SQL, account: string, rows: CostRow[]): Promise<void> {
  if (rows.length === 0) return
  await sql.begin(async (tx) => {
    for (const r of rows) {
      await tx`
        INSERT INTO usage.platform_cost (account, day, model, api_key_id, cost_usd, refreshed_at)
        VALUES (${account}, ${r.day}::date, ${r.model}, ${r.apiKeyId}, ${r.cents}::numeric / 100, ${r.refreshedAt.toISOString()}::timestamptz)
        ON CONFLICT (account, day, coalesce(model, ''), coalesce(api_key_id, '')) DO UPDATE SET
          cost_usd = EXCLUDED.cost_usd, refreshed_at = EXCLUDED.refreshed_at`
    }
  })
}

/**
 * Upsert one cycle. `reconcile` (the provider's snapshot is past `cycle.end`) fills reconciled/unspent and stamps
 * closed_at once; a later revision may move reconciled/unspent for REVISION_DAYS after the end, closed_at stays. Without
 * `reconcile` those columns are left as they are, only metered_usd (gateway rows) is refreshed.
 */
async function writeCycle(
  sql: SQL,
  account: PlatformAccount,
  cycle: Cycle,
  reconcile: boolean,
  now: Date,
): Promise<void> {
  await sql`
    INSERT INTO usage.credit_cycles AS cc
      (account, cycle_start, cycle_end, grant_usd, metered_usd, reconciled_usd, unspent_usd, closed_at)
    SELECT ${account.id}, ${cycle.start.toISOString()}::timestamptz, ${cycle.end.toISOString()}::timestamptz,
           ${account.creditUsd}::numeric, m.metered, r.reconciled,
           CASE WHEN r.reconciled IS NULL THEN NULL ELSE greatest(${account.creditUsd}::numeric - r.reconciled, 0) END,
           CASE WHEN r.reconciled IS NULL THEN NULL ELSE ${now.toISOString()}::timestamptz END
    FROM (
      SELECT coalesce(sum(coalesce(cost_usd, (lane_detail->>'costEstimatedUsd')::numeric, 0)), 0) AS metered
      FROM usage.records
      WHERE source = 'gateway' AND billing = 'api_credit' AND account = ${account.id}
        AND ts >= ${cycle.start.toISOString()}::timestamptz AND ts < ${cycle.end.toISOString()}::timestamptz
    ) m,
    LATERAL (
      SELECT CASE WHEN ${reconcile}::boolean THEN coalesce(sum(cost_usd), 0) END AS reconciled
      FROM usage.platform_cost
      WHERE account = ${account.id}
        AND day >= (${cycle.start.toISOString()}::timestamptz AT TIME ZONE 'UTC')::date
        AND day <  (${cycle.end.toISOString()}::timestamptz AT TIME ZONE 'UTC')::date
    ) r
    ON CONFLICT (account, cycle_start) DO UPDATE SET
      cycle_end      = EXCLUDED.cycle_end,
      grant_usd      = EXCLUDED.grant_usd,
      metered_usd    = EXCLUDED.metered_usd,
      reconciled_usd = CASE
        WHEN EXCLUDED.reconciled_usd IS NOT NULL
         AND (cc.closed_at IS NULL OR ${now.toISOString()}::timestamptz < cc.cycle_end + make_interval(days => ${REVISION_DAYS}))
        THEN EXCLUDED.reconciled_usd ELSE cc.reconciled_usd END,
      unspent_usd    = CASE
        WHEN EXCLUDED.reconciled_usd IS NOT NULL
         AND (cc.closed_at IS NULL OR ${now.toISOString()}::timestamptz < cc.cycle_end + make_interval(days => ${REVISION_DAYS}))
        THEN EXCLUDED.unspent_usd ELSE cc.unspent_usd END,
      closed_at      = coalesce(cc.closed_at, EXCLUDED.closed_at)`
}

/**
 * Run the pass. Each org is isolated: a missing key or a failing Admin API call skips that org's platform_cost (one log
 * line, no secret) and the rest go on; credit_cycles still gets its metered figure. Throws only on a Postgres failure,
 * which the caller (ingest) logs.
 */
export async function runCreditPass(
  sql: SQL,
  opts: CreditPassOptions = {},
): Promise<CreditPassResult> {
  const now = opts.now ?? new Date()
  const resolve = opts.resolveSecret ?? resolveSecret
  const result: CreditPassResult = { platformCost: 0, cycles: 0 }

  for (const account of opts.accounts ?? loadPlatformAccounts()) {
    const current = account.cycleDay === null ? null : cycleOf(account.cycleDay, now)
    const previous =
      current && account.cycleDay !== null ? previousCycle(account.cycleDay, current) : null

    let chunks: Chunk[] = []
    if (!account.adminKeyRef) {
      log.info(`credit: ${account.id}: no admin key ref, platform_cost skipped`)
    } else {
      const adminKey = await resolve(account.adminKeyRef)
      if (!adminKey) {
        log.info(`credit: ${account.id}: admin key not available, platform_cost skipped`)
      } else {
        try {
          const got = await fetchCost(adminWindows(previous?.start ?? null, now, opts.days), {
            baseUrl: opts.baseUrl,
            adminKey,
          })
          await writePlatformCost(sql, account.id, got.rows)
          chunks = got.chunks
          result.platformCost += got.rows.length
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          log.warn(`credit: ${account.id}: admin API ${msg}, platform_cost skipped`)
        }
      }
    }

    if (!current || !previous) {
      log.info(`credit: ${account.id}: cycleDay unknown, credit_cycles skipped`)
      continue
    }
    for (const cycle of [previous, current]) {
      const snapshot = snapshotCovering(chunks, cycle)
      const closed = snapshot !== null && cycle.end.getTime() <= snapshot.getTime()
      await writeCycle(sql, account, cycle, closed, now)
      result.cycles++
    }
  }
  return result
}
