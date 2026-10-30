import type { SQL } from 'bun'
import { log as defaultLog } from '../log.ts'
import type { Logger } from '../types.ts'
import { type Alias, upsertAliases } from './aliases.ts'
import {
  droppedRate,
  normalizeLiteLLM,
  normalizeOpenRouter,
  type OpenRouterModel,
  type Schedule,
  scheduleText,
} from './normalize.ts'
import { insertPrice, loadTimelines } from './store.ts'

// Daily price sync (decision U3): the aliased catalog keys are read from LiteLLM's public price file (OpenRouter
// for the keys written `openrouter:<id>`), and a new usage.prices row is written only when a rate, tier or
// off-peak value changed against the model's latest row. A key that vanished upstream, or whose price became
// zero/unpublished, is an error line that keeps the previous row: a missing price must never become $0.

export const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models'
export const OPENROUTER_PREFIX = 'openrouter:'

export interface SyncDeps {
  fetchLiteLLM: () => Promise<Record<string, unknown>>
  fetchOpenRouter: () => Promise<OpenRouterModel[]>
  now?: () => Date
  log?: Logger
  /** The alias set to enforce (default: ALIASES). */
  aliases?: readonly Alias[]
}
export interface SyncResult {
  checked: number
  inserted: number
  unchanged: number
  errors: number
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
  return res.json()
}

export const liveDeps: SyncDeps = {
  fetchLiteLLM: async () => (await getJson(LITELLM_URL)) as Record<string, unknown>,
  fetchOpenRouter: async () =>
    ((await getJson(OPENROUTER_URL)) as { data: OpenRouterModel[] }).data,
}

export async function syncPrices(sql: SQL, deps: SyncDeps = liveDeps): Promise<SyncResult> {
  const log = deps.log ?? defaultLog
  const now = (deps.now ?? (() => new Date()))()
  await upsertAliases(sql, deps.aliases)

  const keys = (
    await sql`SELECT DISTINCT model_key FROM usage.price_aliases ORDER BY model_key`
  ).map((r: { model_key: string }) => r.model_key)
  const litellmKeys = keys.filter((k: string) => !k.startsWith(OPENROUTER_PREFIX))
  const orKeys = keys.filter((k: string) => k.startsWith(OPENROUTER_PREFIX))
  const litellm = litellmKeys.length > 0 ? await deps.fetchLiteLLM() : {}
  const orModels =
    orKeys.length > 0
      ? new Map((await deps.fetchOpenRouter()).map((m) => [m.id, m]))
      : new Map<string, OpenRouterModel>()
  const timelines = await loadTimelines(sql, keys)

  const result: SyncResult = { checked: keys.length, inserted: 0, unchanged: 0, errors: 0 }
  for (const key of keys) {
    const isOr = key.startsWith(OPENROUTER_PREFIX)
    const next: Schedule | null = isOr
      ? normalizeOpenRouter(orModels.get(key.slice(OPENROUTER_PREFIX.length)))
      : normalizeLiteLLM(litellm[key])
    const latest = timelines.get(key)?.at(-1)

    if (!next) {
      const why = latest
        ? 'vanished upstream or no longer has a positive input/output price; keeping the previous row'
        : 'has no usable price upstream; no row written'
      log.error(`prices-sync: ${key} ${why}`)
      result.errors++
      continue
    }
    const dropped = latest ? droppedRate(latest.schedule, next) : null
    if (dropped) {
      log.error(
        `prices-sync: ${key} lost its ${dropped} price upstream (now unpublished or zero); keeping the previous row`,
      )
      result.errors++
      continue
    }
    if (latest && scheduleText(latest.schedule) === scheduleText(next)) {
      result.unchanged++
      continue
    }
    const written = await insertPrice(sql, {
      modelKey: key,
      validFrom: now,
      schedule: next,
      source: isOr ? 'openrouter' : 'litellm',
      sourceRef: isOr ? OPENROUTER_URL : LITELLM_URL,
      fetchedAt: now,
    })
    if (written) {
      result.inserted++
      log.info(
        `prices-sync: ${key} ${latest ? 'repriced' : 'first price'} (input ${next.rates.input}, output ${next.rates.output} USD/M)`,
      )
    }
  }
  return result
}
