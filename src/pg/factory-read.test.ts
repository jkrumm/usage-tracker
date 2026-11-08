import { expect, test } from 'bun:test'
import { migrate, readMigrations } from './migrate.ts'
import { describePg, scratchDb } from './testing.ts'

// Migration 0022 grants the software-factory's `factory` role read access to three relations. Roles are
// cluster-wide, so the suite never creates one: it proves the guard (a server without `factory` still migrates),
// idempotency, and, where the server has the role, the exact privilege set.

describePg('migration 0022 factory read grant', () => {
  const db = scratchDb()
  const grantSql = () => {
    const m = readMigrations().find((f) => f.name === 'factory_read')
    if (!m) throw new Error('migration factory_read missing')
    return m.sql
  }

  test('applies on any server and re-running it is a no-op', async () => {
    const sql = await db.connect()
    await migrate(sql)
    await sql.unsafe(grantSql()).simple()
    await sql.unsafe(grantSql()).simple()
  })

  test('the factory role, when the server has one, reads three relations and nothing else', async () => {
    const sql = await db.connect()
    const [role] = await sql`SELECT 1 AS ok FROM pg_roles WHERE rolname = 'factory'`
    if (!role) return
    const can = async (priv: string, rel: string) => {
      const [r] = await sql`SELECT has_table_privilege('factory', ${rel}, ${priv}) AS ok`
      return r.ok as boolean
    }
    const [schema] = await sql`SELECT has_schema_privilege('factory', 'usage', 'USAGE') AS ok`
    expect(schema.ok).toBe(true)
    for (const rel of ['usage.sessions', 'usage.records_unique', 'usage.session_window_share']) {
      expect(await can('SELECT', rel)).toBe(true)
      expect(await can('INSERT', rel)).toBe(false)
      expect(await can('UPDATE', rel)).toBe(false)
      expect(await can('DELETE', rel)).toBe(false)
    }
    expect(await can('SELECT', 'usage.records')).toBe(false)
    expect(await can('SELECT', 'usage.session_env')).toBe(false)
  })
})
