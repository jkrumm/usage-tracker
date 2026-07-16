// Token pricing, USD per 1,000,000 tokens.
//
// Cost is almost never reliable at the source: Claude Code records none, and
// IU-routed sessions carry cost_status='unknown'. So the tracker owns one
// pricing table and computes a *single, comparable* cost for every record. The
// `billing` column on each row tells you whether that cost is actually charged
// (iu) or sunk into the Max subscription (max — track the value, not the bill).
//
// Rates verified May 2026 against published list prices (Anthropic, OpenAI,
// Google) and the Feuer agent's configured IU rate for Kimi-K2.6; DeepSeek V4
// and Opus 4.8 added June 2026, Claude 5 family (Sonnet 5, Fable 5) July 2026
// (see inline notes). Two caveats
// remain: (1) IU's actual per-token EU rates may differ from public list prices
// for the Claude/Gemini models routed through the bridge; (2) cache-write uses
// the 1.25x 5-minute multiplier and does not yet split the 1-hour tier. Editing
// values is safe — the model key is the only thing collectors depend on.

export interface Rate {
  /** Uncached input tokens. */
  input: number;
  /** Output (and reasoning) tokens. */
  output: number;
  /** Cache-read (cached input) tokens. */
  cacheRead: number;
  /** Cache-write (cache creation) tokens. */
  cacheWrite: number;
}

export const PRICING: Record<string, Rate> = {
  // Anthropic list prices, verified May 2026 (platform.claude.com pricing).
  // cacheWrite = 1.25x input (standard 5-minute cache-creation multiplier; the
  // 1-hour tier is 2x but is not split out here — a future refinement).
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  // Claude 5 family (list prices, July 2026). Fable 5 is the top tier ($10/$50);
  // Sonnet 5 standard list matches Sonnet 4.6 ($3/$15) — the $2/$10 intro through
  // 2026-08-31 is not tracked (these are Max value, not a real bill).
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5 },
  "claude-sonnet-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  // IU bridge rate (Feuer agent config — authoritative for this setup).
  "kimi-k2.6": { input: 0.95, output: 4.0, cacheRead: 0.16, cacheWrite: 0.95 },
  // DeepSeek V4 (IU unified endpoint, EU-resident) — Hermes brain runs Pro, its
  // auxiliaries run Flash/Pro. Rates from modelpick's
  // scraped aggregators (OpenRouter + ArtificialAnalysis, 2026-06-02); cacheRead/Write
  // follow the table's non-Claude convention (0.1x / 1.0x input). Same public-list
  // caveat as the other IU-routed models — actual EU per-token rate may differ.
  "deepseek-v4-pro": { input: 0.435, output: 0.87, cacheRead: 0.0435, cacheWrite: 0.435 },
  "deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.014, cacheWrite: 0.14 },
  // OpenAI / Google list prices, verified May 2026.
  "gpt-5-mini": { input: 0.25, output: 2.0, cacheRead: 0.025, cacheWrite: 0.25 },
  "gemini-3-pro-preview": { input: 2.0, output: 12.0, cacheRead: 0.2, cacheWrite: 2.0 },
  // Gemini 3.5 Flash standard tier (ai.google.dev/gemini-api/docs/pricing, July
  // 2026) — sideclaw's vision model. Google bills thinking tokens at the output
  // rate, which is what computeCost already does with `reasoning`; those tokens
  // sit outside candidatesTokenCount, so sideclaw derives them rather than
  // reading a field (see its normalizeUsage). Batch/Flex are half these rates
  // and Priority is 1.8x; only standard is tracked.
  "gemini-3.5-flash": { input: 1.5, output: 9.0, cacheRead: 0.15, cacheWrite: 1.5 },
  // gpt-image-2 is per-token, not flat per-image. It emits image output tokens
  // ($30/M) and consumes text prompt tokens ($5/M) — mapped to output/input
  // here because sideclaw only does text->image generation. Image *input*
  // tokens (edits/reference images) bill at $8/M and would need a separate
  // rate; sideclaw doesn't send them today.
  "gpt-image-2": { input: 5.0, output: 30.0, cacheRead: 1.25, cacheWrite: 5.0 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0.75 },
  // GPT-5.6 Terra (OpenAI list prices, GA 2026-07-09) — sideclaw's `review`
  // adversary critic, which runs it at reasoning_effort "high". cacheWrite =
  // 1.25x input, cacheRead = 90% off input, both per OpenAI's published rates.
  // Reasoning dominates this model's output: a ~170-token critique carries ~4.3k
  // thinking tokens. OpenAI folds that count inside completion_tokens, so
  // sideclaw splits it back out (see its normalizeUsage) and reports output and
  // reasoning separately. Both bill at `output` here, and they sum to the
  // vendor's completion_tokens — so the spend lands once, not twice.
  "gpt-5.6-terra": { input: 2.5, output: 15.0, cacheRead: 0.25, cacheWrite: 3.125 },
  // Locally hosted (mlx/ollama) — no marginal token cost.
  "gemma4-agent": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export interface CostResult {
  usd: number | null;
  source: "computed" | "none";
}

/** Compute cost for a model. Returns null when the model has no known rate. */
export function computeCost(modelNorm: string | null, t: TokenCounts): CostResult {
  const rate = modelNorm ? PRICING[modelNorm] : undefined;
  if (!rate) return { usd: null, source: "none" };

  const usd =
    (t.input * rate.input +
      t.output * rate.output +
      t.cacheRead * rate.cacheRead +
      t.cacheWrite * rate.cacheWrite +
      t.reasoning * rate.output) /
    1_000_000;

  return { usd, source: "computed" };
}
