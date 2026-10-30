import { describe, expect, test } from 'bun:test'
import { migrate } from '../pg/migrate.ts'
import { describePg, scratchDb } from '../pg/testing.ts'
import { ALIASES, baseModel, upsertAliases } from './aliases.ts'
import { normalizeLiteLLM, normalizeOpenRouter } from './normalize.ts'
import { fixtureDeps, LITELLM_FIXTURE, OPENROUTER_FIXTURE } from './testing.ts'
import { OPENROUTER_PREFIX, syncPrices } from './sync.ts'

describe('aliases', () => {
  test('baseModel strips the context flag', () => {
    expect(baseModel('claude-sonnet-5[1m]')).toBe('claude-sonnet-5')
    expect(baseModel('claude-opus-5-5')).toBe('claude-opus-5-5')
  })

  test('every alias target is priceable from the committed catalog snapshots', () => {
    for (const a of ALIASES) {
      const schedule = a.modelKey.startsWith(OPENROUTER_PREFIX)
        ? normalizeOpenRouter(
            OPENROUTER_FIXTURE.find((m) => m.id === a.modelKey.slice(OPENROUTER_PREFIX.length)),
          )
        : normalizeLiteLLM(LITELLM_FIXTURE[a.modelKey])
      expect(schedule, `${a.model} -> ${a.modelKey}`).not.toBeNull()
    }
  })

  test('model names are unique and suffix aliases point at their base model', () => {
    expect(new Set(ALIASES.map((a) => a.model)).size).toBe(ALIASES.length)
    for (const a of ALIASES.filter((x) => x.matchedBy === 'suffix'))
      expect(a.modelKey).toBe(baseModel(a.model))
  })
})

describePg('upsertAliases', () => {
  const db = scratchDb()

  test('the table ends up holding exactly the listed aliases', async () => {
    const sql = await db.connect()
    await migrate(sql)
    await upsertAliases(sql)
    const count = async () =>
      Number((await sql`SELECT count(*) AS n FROM usage.price_aliases`)[0].n)
    expect(await count()).toBe(ALIASES.length)

    const gone = ALIASES.find((a) => a.model === 'hy3')!
    await upsertAliases(
      sql,
      ALIASES.filter((a) => a !== gone),
    )
    expect(await count()).toBe(ALIASES.length - 1)
    const rows = await sql`SELECT 1 FROM usage.price_aliases WHERE model = ${gone.model}`
    expect(rows.length).toBe(0)

    await upsertAliases(sql, [{ ...ALIASES[0]!, note: 'edited' }])
    expect(await count()).toBe(1)
    expect((await sql`SELECT note FROM usage.price_aliases`)[0].note).toBe('edited')
  })

  test('a removed alias is no longer synced', async () => {
    const sql = await db.connect()
    const keysOf = (list: readonly (typeof ALIASES)[number][]) =>
      new Set(list.map((a) => a.modelKey)).size
    const without = ALIASES.filter((a) => !a.modelKey.startsWith('openrouter:'))
    const r = await syncPrices(sql, fixtureDeps({ aliases: without }))
    expect(r.checked).toBe(keysOf(without))
    const keys = await sql`SELECT DISTINCT model_key FROM usage.price_aliases`
    expect(keys.some((k: { model_key: string }) => k.model_key.startsWith('openrouter:'))).toBe(
      false,
    )
  })
})
