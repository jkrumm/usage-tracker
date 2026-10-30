import { log } from '../log.ts'
import { applyHistory, DEFAULT_SINCE, gitSnapshots } from '../prices/history.ts'
import { syncPrices } from '../prices/sync.ts'
import { connect } from './connect.ts'
import { migrate } from './migrate.ts'

/** `--since YYYY-MM-DD` (a real calendar day) or the default; throws a message naming the flag. */
export function parseSince(args: string[]): string {
  const i = args.indexOf('--since')
  if (i < 0) return DEFAULT_SINCE
  const value = args[i + 1]
  const day =
    value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : null
  const valid =
    value !== undefined &&
    day !== null &&
    !Number.isNaN(day.getTime()) &&
    day.toISOString().startsWith(value)
  if (!valid)
    throw new Error(
      `--since needs a date as YYYY-MM-DD, got ${value === undefined ? 'nothing' : JSON.stringify(value)}`,
    )
  return value
}

/** The Postgres commands. Returns the exit code, or null when `cmd` is not one of them. */
export async function runPgCommand(cmd: string, args: string[]): Promise<number | null> {
  if (cmd !== 'pg-migrate' && cmd !== 'prices-sync' && cmd !== 'prices-seed-history') return null
  let since = DEFAULT_SINCE
  if (cmd === 'prices-seed-history') {
    try {
      since = parseSince(args)
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`)
      return 2
    }
  }
  const sql = connect()
  try {
    if (cmd === 'pg-migrate') {
      const { applied, alreadyApplied } = await migrate(sql, { log })
      process.stdout.write(
        `pg-migrate: ${applied.length} applied, ${alreadyApplied} already applied\n`,
      )
      return 0
    }
    if (cmd === 'prices-sync') {
      const r = await syncPrices(sql)
      process.stdout.write(
        `prices-sync: ${r.checked} models checked, ${r.inserted} repriced, ${r.unchanged} unchanged, ${r.errors} errors\n`,
      )
      return r.errors > 0 ? 1 : 0
    }
    const r = await applyHistory(sql, gitSnapshots({ since }))
    process.stdout.write(
      `prices-seed-history: ${r.snapshots} snapshots, ${r.inserted} rows written\n`,
    )
    return 0
  } finally {
    await sql.close()
  }
}
