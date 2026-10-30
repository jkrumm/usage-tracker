import type { SQL } from 'bun'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Logger } from '../types.ts'

// Forward-only SQL migrations for the `usage` schema. Files: migrations/pg/NNNN_name.sql, applied in order,
// one transaction each, under an advisory lock so two runners (LaunchAgent and a manual run) never interleave.
// An applied file whose bytes changed is refused: write a new migration instead.

export const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'migrations', 'pg')
const LOCK_KEY = 7_265_001
const FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/

interface MigrationFile {
  version: number
  name: string
  checksum: string
  sql: string
}

export interface MigrateResult {
  applied: string[]
  alreadyApplied: number
}

export function readMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  const migrations = files.map((f) => {
    const m = FILE.exec(f)
    if (!m) throw new Error(`migration file ${f} does not match NNNN_name.sql`)
    const sql = readFileSync(join(dir, f), 'utf8')
    return {
      version: Number(m[1]),
      name: m[2] as string,
      checksum: createHash('sha256').update(sql).digest('hex'),
      sql,
    }
  })
  migrations.forEach((m, i) => {
    if (i > 0 && m.version === (migrations[i - 1] as MigrationFile).version) {
      throw new Error(`duplicate migration version ${m.version}`)
    }
  })
  return migrations
}

export async function migrate(
  sql: SQL,
  opts: { dir?: string; log?: Pick<Logger, 'info' | 'warn'> } = {},
): Promise<MigrateResult> {
  const migrations = readMigrations(opts.dir)
  const conn = await sql.reserve()
  try {
    await conn`SELECT pg_advisory_lock(${LOCK_KEY})`
    // The role owns schema usage in `shared` and may lack CREATE on the database, so only create when absent.
    const [exists] = await conn`SELECT 1 AS ok FROM pg_namespace WHERE nspname = 'usage'`
    if (!exists) await conn.unsafe('CREATE SCHEMA usage')
    await conn.unsafe(`CREATE TABLE IF NOT EXISTS usage.schema_migrations (
      version    integer     PRIMARY KEY,
      name       text        NOT NULL,
      checksum   text        NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`)

    const done = new Map<number, string>()
    for (const row of await conn`SELECT version, checksum FROM usage.schema_migrations`) {
      done.set(Number(row.version), String(row.checksum))
    }
    for (const m of migrations) {
      const applied = done.get(m.version)
      if (applied !== undefined && applied !== m.checksum) {
        throw new Error(
          `migration ${m.version}_${m.name} changed after it was applied; add a new migration instead`,
        )
      }
    }

    const applied: string[] = []
    for (const m of migrations) {
      if (done.has(m.version)) continue
      await conn.unsafe('BEGIN').simple()
      try {
        await conn.unsafe(m.sql).simple()
        await conn`INSERT INTO usage.schema_migrations (version, name, checksum) VALUES (${m.version}, ${m.name}, ${m.checksum})`
        await conn.unsafe('COMMIT').simple()
      } catch (err) {
        await conn.unsafe('ROLLBACK').simple()
        throw err
      }
      applied.push(`${String(m.version).padStart(4, '0')}_${m.name}`)
      opts.log?.info(`pg-migrate: applied ${m.version}_${m.name}`)
    }
    return { applied, alreadyApplied: migrations.length - applied.length }
  } finally {
    await conn`SELECT pg_advisory_unlock(${LOCK_KEY})`.catch(() => undefined)
    conn.release()
  }
}
