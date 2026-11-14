import { SQL } from 'bun'
import { afterAll, describe } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'

// Postgres test harness. Each suite creates a scratch database `usage_test_<random>`, connects to it as admin
// and drops it afterwards. The admin connection, first match wins:
//   1. USAGE_TEST_PG_URL: a full URL to the maintenance database (CI service container, any explicit server).
//   2. USAGE_TEST_PG_USER + USAGE_TEST_PG_PASSWORD: TCP to 127.0.0.1:5432 (USAGE_TEST_PG_HOST / _PORT override).
//   3. The unix socket of the mini's native cluster, as the OS user with no password, as libpq does by default
//      (the superuser has no password and logs in over the socket only). Socket directory: PGHOST when it
//      starts with `/`, else /tmp; port: PGPORT, else 5432.
// With none of them available the suites skip, with the reason in their name.

type Target = { url: string } | { path: string; port: number; username: string }

/** Where the admin connection goes, or undefined when this machine has no test Postgres. */
export function adminTarget(env: NodeJS.ProcessEnv = process.env): Target | undefined {
  if (env.USAGE_TEST_PG_URL) return { url: env.USAGE_TEST_PG_URL }
  const { USAGE_TEST_PG_USER: user, USAGE_TEST_PG_PASSWORD: password } = env
  if (user && password) {
    const host = env.USAGE_TEST_PG_HOST || '127.0.0.1'
    const port = env.USAGE_TEST_PG_PORT || '5432'
    return {
      url: `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/postgres`,
    }
  }
  // Bun appends /.s.PGSQL.<port> to a `path` that is a directory, so it gets the directory and the port.
  const path = env.PGHOST?.startsWith('/') ? env.PGHOST : '/tmp'
  const port = Number(env.PGPORT || 5432)
  return existsSync(`${path}/.s.PGSQL.${port}`)
    ? { path, port, username: userInfo().username }
    : undefined
}

const TARGET = adminTarget()
export const pgEnabled = Boolean(TARGET)

/** Connection options for `database` on the admin target. */
function optionsFor(database: string): ConstructorParameters<typeof SQL>[0] {
  const target = TARGET as Target
  if ('url' in target) {
    const u = new URL(target.url)
    u.pathname = `/${database}`
    return { url: u.toString() }
  }
  return { path: target.path, port: target.port, username: target.username, database }
}
const SCRATCH_NAME = /^usage_test_[0-9a-f]{12}$/

/** The admin role can drop anything on the shared server, so only names this helper generates ever reach DDL. */
export function assertScratchName(name: string): string {
  if (!SCRATCH_NAME.test(name))
    throw new Error(
      `refusing to create or drop database ${JSON.stringify(name)}: not usage_test_<12 hex>`,
    )
  return name
}

export const SKIP_REASON =
  'skipped: no test Postgres (no unix socket at PGHOST|/tmp, USAGE_TEST_PG_URL unset)'

if (!pgEnabled) console.warn(`pg tests ${SKIP_REASON}`)

export function describePg(name: string, fn: () => void): void {
  if (pgEnabled) describe(name, fn)
  else describe.skip(`${name} (${SKIP_REASON})`, fn)
}

/** A scratch database for the current suite. Call inside describePg; dropped in afterAll. */
export function scratchDb(): { connect(): Promise<SQL> } {
  let ready = false
  let admin: SQL | undefined
  const dbName = assertScratchName(`usage_test_${randomBytes(6).toString('hex')}`)
  const opened: SQL[] = []

  afterAll(async () => {
    for (const s of opened) await s.close({ timeout: 1 }).catch(() => undefined)
    if (admin) {
      await admin
        .unsafe(`DROP DATABASE IF EXISTS ${assertScratchName(dbName)} WITH (FORCE)`)
        .catch(() => undefined)
      await admin.close().catch(() => undefined)
    }
  })

  return {
    async connect() {
      if (!ready) {
        admin = new SQL({ ...optionsFor('postgres'), max: 1 })
        await admin.unsafe(`CREATE DATABASE ${assertScratchName(dbName)}`)
        ready = true
      }
      const sql = new SQL({ ...optionsFor(dbName), max: 4 })
      opened.push(sql)
      return sql
    },
  }
}
