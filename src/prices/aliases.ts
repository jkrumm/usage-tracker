import type { SQL } from 'bun'

// usage model -> catalog key. Derived from the distinct SQLite model_norm values (every model above ~0.05% of
// rows, plus cheap neighbours). `exact`: same string as the first-party LiteLLM key; `suffix`: a context
// suffix like [1m] stripped; `data`: chosen by comparing the catalog with measured spend; `manual`: our pick
// where the catalog has no first-party key (OpenRouter keys are written `openrouter:<id>`).
//
// Models deliberately without an alias (the cost stays NULL until a price exists): audio/speech/image models
// (not token-priced), `<synthetic>`, unnamed ids (v3, decision-1, clef, flash-v2.5, pplx-decider-v1-27b) and
// test strings. Their rows keep cost_source 'none' or the provider-reported cost.

export type MatchedBy = 'exact' | 'suffix' | 'data' | 'manual'
export interface Alias {
  model: string
  modelKey: string
  matchedBy: MatchedBy
  note?: string
}

const exact = (model: string, modelKey = model): Alias => ({ model, modelKey, matchedBy: 'exact' })
const manual = (model: string, modelKey: string, note: string): Alias => ({
  model,
  modelKey,
  matchedBy: 'manual',
  note,
})

export const ALIASES: readonly Alias[] = [
  ...[
    'claude-sonnet-5',
    'claude-sonnet-5-5',
    'claude-sonnet-4-6',
    'claude-opus-5',
    'claude-opus-5-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-fable-5',
    'claude-fable-5-1',
    'claude-haiku-5-5',
    'claude-haiku-4-5',
  ].map((m) => exact(m)),
  {
    model: 'claude-sonnet-5[1m]',
    modelKey: 'claude-sonnet-5',
    matchedBy: 'suffix',
    note: '1M-context flag, same schedule',
  },
  {
    model: 'claude-opus-5[1m]',
    modelKey: 'claude-opus-5',
    matchedBy: 'suffix',
    note: '1M-context flag, same schedule',
  },
  exact('deepseek-v4-pro', 'deepseek/deepseek-v4-pro'),
  exact('deepseek-v4-flash', 'deepseek/deepseek-v4-flash'),
  {
    model: 'deepseek-v4.1-flash',
    modelKey: 'deepseek/deepseek-v4-flash',
    matchedBy: 'data',
    note:
      "LiteLLM has no deepseek/ key for 4.1; coralbricks/deepseek-v4.1-flash lists input 0.01 USD/M and OpenRouter's aggregate " +
      "deepseek/deepseek-v4.1-flash 0.045/0.50, neither near IU's measured 0.30/1.20/0.006 (peak) and 0.15/0.60/0.003 (off-peak). " +
      "DeepSeek's first-party deepseek/deepseek-v4-flash entry matches those numbers and carries the off-peak windows. " +
      "IU's portal stays the cost truth for billing=iu rows.",
  },
  exact('glm-5.3-flash', 'zai/glm-5.3-flash'),
  exact('glm-5.3', 'zai/glm-5.3'),
  exact('kimi-k2.6', 'moonshot/kimi-k2.6'),
  exact('kimi-k3', 'moonshot/kimi-k3'),
  ...[
    'gpt-5.6-luna',
    'gpt-5.6-terra',
    'gpt-5.6-sol',
    'gpt-6-luna',
    'gpt-6-sol',
    'gpt-6-astra',
    'gpt-6.1-sol',
    'gpt-5.4-mini',
    'gpt-5-mini',
  ].map((m) => exact(m)),
  ...[
    'gemini-3.8-flash',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-3.1-pro-preview',
  ].map((m) => exact(m)),
  exact('sonar', 'perplexity/sonar'),
  exact('grok-4.7', 'xai/grok-4.7'),
  manual(
    'minimax-m3',
    'fireworks_ai/minimax-m3',
    "no first-party LiteLLM key; the reseller entry equals IU's measured 0.30/1.20",
  ),
  manual('hy3', 'openrouter:tencent/hy3', 'absent from LiteLLM under a first-party key'),
  manual(
    'kimi-k2.7-code',
    'openrouter:moonshotai/kimi-k2.7-code',
    'absent from LiteLLM under a first-party key',
  ),
]

/** claude-sonnet-5[1m] -> claude-sonnet-5. The context-window flag is not a model. */
export function baseModel(model: string): string {
  return model.replace(/\[[^\]]*\]$/, '')
}

/**
 * The code is the source of truth: the table ends up holding exactly `aliases`, in one transaction (rows no longer
 * listed are deleted so a removed alias stops syncing). A database-side correction belongs in price_overrides.
 */
export async function upsertAliases(sql: SQL, aliases: readonly Alias[] = ALIASES): Promise<void> {
  await sql.begin(async (tx) => {
    if (aliases.length === 0) await tx`DELETE FROM usage.price_aliases`
    else
      await tx`DELETE FROM usage.price_aliases WHERE model NOT IN ${tx(aliases.map((a) => a.model))}`
    for (const a of aliases) {
      await tx`
        INSERT INTO usage.price_aliases (model, model_key, matched_by, note)
        VALUES (${a.model}, ${a.modelKey}, ${a.matchedBy}, ${a.note ?? null})
        ON CONFLICT (model) DO UPDATE
          SET model_key = EXCLUDED.model_key, matched_by = EXCLUDED.matched_by, note = EXCLUDED.note`
    }
  })
}
