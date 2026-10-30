import { describe, expect, test } from 'bun:test'
import { normalizeLiteLLM } from './normalize.ts'
import { LITELLM_FIXTURE } from './testing.ts'

// The "compare once" check: the sync's normalization of a committed LiteLLM snapshot reproduces Anthropic's
// published Claude 5 list prices (USD per MTok) for all five token kinds. The expectations are typed in from
// the pricing page, not derived from the fixture.

type Row = {
  input: string
  cache_write_5m: string
  cache_write_1h: string
  cache_read: string
  output: string
}

const LIST_PRICES: Record<string, Row> = {
  'claude-fable-5-1': {
    input: '10',
    cache_write_5m: '12.5',
    cache_write_1h: '20',
    cache_read: '0.25',
    output: '50',
  },
  'claude-opus-5-5': {
    input: '4',
    cache_write_5m: '5',
    cache_write_1h: '8',
    cache_read: '0.2',
    output: '20',
  },
  'claude-sonnet-5-5': {
    input: '2',
    cache_write_5m: '2.5',
    cache_write_1h: '4',
    cache_read: '0.1',
    output: '10',
  },
  'claude-sonnet-5': {
    input: '2',
    cache_write_5m: '2.5',
    cache_write_1h: '4',
    cache_read: '0.2',
    output: '10',
  },
  'claude-haiku-5-5': {
    input: '0.1',
    cache_write_5m: '0.125',
    cache_write_1h: '0.2',
    cache_read: '0.01',
    output: '0.5',
  },
}
const HAIKU_ABOVE_100K: Row = {
  input: '0.5',
  cache_write_5m: '0.625',
  cache_write_1h: '1',
  cache_read: '0.05',
  output: '2.5',
}

describe('Claude 5 list prices', () => {
  for (const [model, want] of Object.entries(LIST_PRICES)) {
    test(`${model} base schedule, all five kinds`, () => {
      const s = normalizeLiteLLM(LITELLM_FIXTURE[model])
      expect(s?.rates).toEqual(want)
    })
  }

  test('only Haiku 5.5 has a context tier, at 100k tokens, for all five kinds', () => {
    expect(normalizeLiteLLM(LITELLM_FIXTURE['claude-haiku-5-5'])?.tiers).toEqual([
      { above_tokens: 100_000, ...HAIKU_ABOVE_100K },
    ])
    for (const model of Object.keys(LIST_PRICES).filter((m) => m !== 'claude-haiku-5-5')) {
      expect(normalizeLiteLLM(LITELLM_FIXTURE[model])?.tiers).toBeNull()
    }
  })
})
