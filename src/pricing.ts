// Token pricing, USD per 1,000,000 tokens.
//
// Cost is almost never reliable at the source: Claude Code records none, and
// IU-routed sessions carry cost_status='unknown'. So the tracker owns one
// pricing table and computes a *single, comparable* cost for every record. The
// `billing` column on each row tells you whether that cost is actually charged
// (iu) or sunk into the Max subscription (max — track the value, not the bill).
//
// VERIFY BEFORE TRUSTING $ FIGURES: these are seed rates. Kimi-K2.6 and
// gpt-5-mini mirror the Feuer agent's configured prices; the Anthropic rates
// are published list prices. Confirm current numbers (and IU's actual per-token
// EU rates) and adjust here — the model key is the only thing collectors depend
// on, so editing values is safe.

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
  "claude-opus-4-7": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "kimi-k2.6": { input: 0.95, output: 4.0, cacheRead: 0.16, cacheWrite: 0.95 },
  "gpt-5-mini": { input: 0.25, output: 2.0, cacheRead: 0.025, cacheWrite: 0.25 },
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
