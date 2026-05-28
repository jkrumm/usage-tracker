// Token pricing, USD per 1,000,000 tokens.
//
// Cost is almost never reliable at the source: Claude Code records none, and
// IU-routed sessions carry cost_status='unknown'. So the tracker owns one
// pricing table and computes a *single, comparable* cost for every record. The
// `billing` column on each row tells you whether that cost is actually charged
// (iu) or sunk into the Max subscription (max — track the value, not the bill).
//
// Rates verified May 2026 against published list prices (Anthropic, OpenAI,
// Google) and the Feuer agent's configured IU rate for Kimi-K2.6. Two caveats
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
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  // IU bridge rate (Feuer agent config — authoritative for this setup).
  "kimi-k2.6": { input: 0.95, output: 4.0, cacheRead: 0.16, cacheWrite: 0.95 },
  // OpenAI / Google list prices, verified May 2026.
  "gpt-5-mini": { input: 0.25, output: 2.0, cacheRead: 0.025, cacheWrite: 0.25 },
  "gemini-3-pro-preview": { input: 2.0, output: 12.0, cacheRead: 0.2, cacheWrite: 2.0 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0.75 },
  "gemini-3.1-flash-tts-preview": { input: 1.0, output: 20.0, cacheRead: 0, cacheWrite: 0 },
  // Audio models (OpenAI), text-token rates — audio_tokens / audio_seconds are
  // captured in raw.{audioTokens,audioSeconds} for future per-audio-minute pricing
  // refinement. Cache fields zero (no caching on the audio path).
  "gpt-4o-transcribe": { input: 2.5, output: 10.0, cacheRead: 0, cacheWrite: 0 },
  "gpt-4o-mini-tts": { input: 0.6, output: 12.0, cacheRead: 0, cacheWrite: 0 },
  "whisper": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
