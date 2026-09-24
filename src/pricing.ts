import type { Grain } from "./types.ts";

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
// (see inline notes). The Requesty-routed non-Claude models (DeepSeek and the
// August 2026 batch below) are measured directly against the IU unified
// endpoint's own reported `usage.cost`, 2026-08-28 — solved by least squares
// across four request shapes per model with a 0.0% residual, and confirmed
// route-independent (/openai and /anthropic both agree). Those rates are
// exact, not estimates. deepseek-v4.1-flash and a re-check of glm-5.3-flash
// were measured the same way on 2026-09-13; glm-5.3-flash's rate had
// genuinely doubled since 08-28. Sonnet 5 corrected and Opus 5.5 added
// 2026-09-24 against the live Anthropic pricing page (see their inline
// notes) — deepseek-v4.1-flash also re-measured against the IU gateway's own
// `usage.cost` the same day. Two caveats remain for everything else: (1) the
// Claude/Gemini models route to AWS Bedrock eu-west-1 / Azure Sweden and the
// gateway reports no cost field for them, so their entries stay public-list-
// price proxies of unknown accuracy against IU's actual EU per-token rate;
// (2) cache-write bills at the 1.25x 5-minute multiplier by default, split out
// to the 2x 1-hour multiplier when a source reports the ephemeral_1h/5m
// breakdown — sources that don't report the split still fall back to the 5m
// rate for the whole amount.
// Editing values is safe — the model key is the only thing collectors depend on.

export interface Rate {
  /** Uncached input tokens. */
  input: number;
  /** Output (and reasoning) tokens. */
  output: number;
  /** Cache-read (cached input) tokens. */
  cacheRead: number;
  /** Cache-write (cache creation) tokens, 5-minute TTL. */
  cacheWrite: number;
  /**
   * Cache-write tokens at the 1-hour TTL (2x input for Anthropic). Omit for
   * vendors with no 1h tier — computeCost falls back to `cacheWrite`.
   */
  cacheWrite1h?: number;
  /**
   * A second, dearer schedule for prompts above `threshold` INPUT tokens.
   * OpenAI's GPT-5.6+/GPT-6 models charge 2x input and 1.5x output once a
   * prompt passes 272k; Anthropic's models here have one schedule at every
   * size, so they omit this and are priced identically to before.
   *
   * The threshold is measured against the vendor's own input total — uncached
   * + cache-read + cache-write — not the additive sum including output.
   */
  long?: { threshold: number; rate: Rate };
}

/** OpenAI's published long-context boundary for GPT-5.6+ and GPT-6. */
const LONG_CONTEXT = 272_000;

export const PRICING: Record<string, Rate> = {
  // Anthropic list prices, verified May 2026 (platform.claude.com pricing).
  // cacheWrite = 1.25x input (standard 5-minute cache-creation multiplier);
  // cacheWrite1h = 2x input (1-hour cache-creation multiplier).
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  // Opus 5 (August 2026) ships at the Opus 4.8 rate, 1M context included at
  // standard pricing — no long-context premium.
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  // Claude 5 family (list prices, July 2026). Fable 5 is the top tier ($10/$50).
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5, cacheWrite1h: 20 },
  // Fable 5.1: same $10/$50 tier as Fable 5, but Anthropic cut cache reads to
  // $0.25/MTok — the family-tier fallback's $1.00 was overstating 1.1B+
  // recorded cache-read tokens by $826 before this entry existed. cacheWrite /
  // cacheWrite1h keep the standard 1.25x/2x-input multipliers; unlike cacheRead
  // these are not independently verified against a Fable-5.1-specific source.
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5, cacheWrite1h: 20 },
  // Sonnet 5 — corrected 2026-09-24 (platform.claude.com/docs/en/about-claude/pricing).
  // The previously-recorded $3/$15 was the *planned* Sept-1 increase off the
  // $2/$10 intro rate; Anthropic cancelled that increase, so $2/$10 is the
  // settled standing rate, not a lapsed intro window. cacheRead $0.20,
  // cacheWrite (5m) $2.50 (1.25x input), cacheWrite1h $4 (2x input) — all
  // published, not derived.
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 },
  // Opus 5.5 — added 2026-09-24 (platform.claude.com/docs/en/about-claude/pricing).
  // Diverges from the opus-tier FAMILY_PRICING fallback ($5/$25/$0.50/$6.25/$10),
  // which had been silently overcosting every opus-5-5 row until this exact
  // entry was added. cacheRead is 0.05x input (not the usual 0.1x), published.
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 },
  // IU bridge rate (Feuer agent config — authoritative for this setup).
  "kimi-k2.6": { input: 0.95, output: 4.0, cacheRead: 0.16, cacheWrite: 0.95 },
  // DeepSeek V4 (IU unified endpoint, EU-resident, Requesty-routed) — Hermes
  // brain runs Pro, its auxiliaries run Flash/Pro. Rates measured directly
  // against the gateway's own `usage.cost` 2026-08-28 (see the file header) —
  // corrected from modelpick's scraped OpenRouter/ArtificialAnalysis list
  // prices, which undercosted every stored row by roughly 3x (Pro) and
  // 3.1x/4.7x input/output (Flash). cacheWrite = input: the gateway never
  // reports a cache-creation field for these models, so a cache write bills
  // as ordinary input.
  "deepseek-v4-pro": { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 1.32 },
  "deepseek-v4-flash": { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0.44 },
  // DeepSeek V4.1 Flash — the new Hermes brain (also research-gateway,
  // argo, audio-gateway, image-gen, warden). Retired: `deepseek-v4-flash`
  // above stays for historical rows priced before the swap; this is a
  // separate model, not a rename, so normalizeModel must not collapse the
  // two onto one key. Rates re-measured 2026-09-24 against the gateway's own
  // `usage.cost` on /openai/v1/chat/completions (solved exactly, 0 residual):
  // 7780 uncached input + 2 output = $0.0011682 -> input $0.15/M; 44 in + 79
  // out (77 reasoning) = $0.000054 -> output $0.60/M; 7552 cached + 228
  // uncached + 2 out = $0.000058056 -> cacheRead $0.003/M. Down sharply from
  // the 2026-09-13 figures (0.5/1.5/0.05) — a real gateway repricing, not a
  // correction. Cache write still not surcharged — the gateway bills a
  // cache-write request at the ordinary input rate — so cacheWrite = input.
  "deepseek-v4.1-flash": { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0.15 },
  // The following ten (glm-5.3-flash through qwen3.7-max) are the rest of the
  // IU unified endpoint's Requesty-routed catalog, measured 2026-08-28 the
  // same way — see the file header for the method. cacheWrite = input
  // throughout, same reason as DeepSeek above.
  // glm-5.3-flash re-measured 2026-09-13: exactly double the 08-28 figure
  // (0.075/0.015/0.25) — not a rounding correction, the gateway's rate for
  // this model actually doubled between the two measurement dates.
  "glm-5.3-flash": { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0.15 },
  // No caching observed on the gateway for this model — cacheRead = input is a
  // deliberate "caching does not work on this model" encoding, not a missing
  // measurement.
  "nvidia-nemotron-3-super-120b-a12b": { input: 0.1, output: 0.5, cacheRead: 0.1, cacheWrite: 0.1 },
  hy3: { input: 0.14, output: 0.58, cacheRead: 0.035, cacheWrite: 0.14 },
  "minimax-m3": { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.3 },
  "nemotron-3-ultra": { input: 0.6, output: 2.4, cacheRead: 0.12, cacheWrite: 0.6 },
  "kimi-k2.7-code": { input: 0.95, output: 4.0, cacheRead: 0.19, cacheWrite: 0.95 },
  "mimo-v2.5-pro": { input: 1.0, output: 3.0, cacheRead: 0.2, cacheWrite: 1.0 },
  "glm-5.1": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 1.4 },
  "glm-5.2": { input: 1.4, output: 4.4, cacheRead: 0.14, cacheWrite: 1.4 },
  // No caching observed on the gateway for this model — same deliberate
  // cacheRead = input encoding as nvidia-nemotron-3-super-120b-a12b above.
  "qwen3.7-max": { input: 2.5, output: 7.5, cacheRead: 2.5, cacheWrite: 2.5 },
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
  // Gemini 3.8 Flash — its successor on the IU catalog, not yet used by any
  // source. Input/output from modelpick's `metric_snapshot` (`price_in` 0.75,
  // `price_out` 3.75; OpenRouter and ArtificialAnalysis agree, captured
  // 2026-09-04) — modelpick's cost.ts and pick_probe carry no row for it.
  // cacheRead = 10% of input and cacheWrite = input follow the 3.5 Flash entry
  // above; unmeasured against the gateway.
  "gemini-3.8-flash": { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 },
  // gpt-image-2 is per-token, not flat per-image. It emits image output tokens
  // ($30/M) and consumes text prompt tokens ($5/M) — mapped to output/input
  // here because sideclaw only does text->image generation. Image *input*
  // tokens (edits/reference images) bill at $8/M and would need a separate
  // rate; sideclaw doesn't send them today.
  "gpt-image-2": { input: 5.0, output: 30.0, cacheRead: 1.25, cacheWrite: 5.0 },
  // GPT Image 2.5 Flare / Sunburst (OpenAI pricing table, verified 2026-09-23)
  // — listed on the IU catalog, not yet used by any source. Same schedule as
  // gpt-image-2 above and mapped the same way: text input $5/M (cached
  // $1.25), image output $30/M; image input ($8/M, cached $2) is unmodelled.
  "gpt-image-2.5-flare": { input: 5.0, output: 30.0, cacheRead: 1.25, cacheWrite: 5.0 },
  "gpt-image-2.5-sunburst": { input: 5.0, output: 30.0, cacheRead: 1.25, cacheWrite: 5.0 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0.75 },
  // GPT-5.6 Terra (OpenAI list prices, GA 2026-07-09) — sideclaw's `review`
  // adversary critic, which runs it at reasoning_effort "high". cacheWrite =
  // 1.25x input, cacheRead = 90% off input, both per OpenAI's published rates.
  // Reasoning dominates this model's output: a ~170-token critique carries ~4.3k
  // thinking tokens. OpenAI folds that count inside completion_tokens, so
  // sideclaw splits it back out (see its normalizeUsage) and reports output and
  // reasoning separately. Both bill at `output` here, and they sum to the
  // vendor's completion_tokens — so the spend lands once, not twice.
  // Corrected 2026-08-20 from $2.50/$15.00 (the launch price) — OpenAI's
  // 2026-07-30 cut moved Terra to $2.00/$12.00, confirmed live against
  // openrouter.ai/api/v1/models. $2.50/$15.00 was gpt-5.6-sol's launch rate,
  // which is how the stale figure kept looking plausible; Sol is $4.00/$20.00
  // now and has its own row below.
  "gpt-5.6-terra": {
    input: 2.0,
    output: 12.0,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    long: { threshold: LONG_CONTEXT, rate: { input: 4.0, output: 18.0, cacheRead: 0.4, cacheWrite: 5.0 } },
  },
  // GPT-5.6 Luna (OpenAI list prices; Azure OpenAI matches exactly, effective
  // 2026-08-01) — Hermes's brain, research-gateway's lead/worker, and argo's
  // AI-gateway default since 2026-08-10. OpenAI cut this model 80% on
  // 2026-07-30, so the $1.00/$6.00 launch price still shown on many pages
  // (including some August-dated ones) is stale. Rates below are short context
  // (<=272k); a request over that doubles input and multiplies output by 1.5.
  // cacheRead = 90% off input, cacheWrite = 1.25x input, both published.
  // Reasoning tokens bill at `output`. NOTE: $0.10/$0.60 is the *batch* rate
  // (50% off) for this model, not a later price cut — do not "correct" these
  // numbers down to it.
  "gpt-5.6-luna": {
    input: 0.2,
    output: 1.2,
    cacheRead: 0.02,
    cacheWrite: 0.25,
    long: { threshold: LONG_CONTEXT, rate: { input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 } },
  },
  // GPT-5.6 Sol (OpenAI list prices, verified against the API pricing table and
  // the model page 2026-09-08) — the default model behind dotfiles' `cx`. Not
  // the $2.50/$15.00 launch price, see the Terra note above. cacheWrite = 1.25x
  // input, cacheRead = 90% off input, the published GPT-5.6+ caching rule.
  "gpt-5.6-sol": {
    input: 4.0,
    output: 20.0,
    cacheRead: 0.4,
    cacheWrite: 5.0,
    long: { threshold: LONG_CONTEXT, rate: { input: 8.0, output: 30.0, cacheRead: 0.8, cacheWrite: 10.0 } },
  },
  // GPT-6 Luna (OpenAI API pricing table + model page, verified 2026-09-23) —
  // successor to gpt-5.6-luna in every slot that ran it (2026-09-23 rollout);
  // the 5.6 row above stays for historical rows. Half 5.6 Luna's input and
  // ~40% of its output. cacheRead is published ($0.01); cacheWrite = 1.25x
  // input per the GPT-5.6+ caching rule, which Sol's published $2.50 matches.
  "gpt-6-luna": {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    long: { threshold: LONG_CONTEXT, rate: { input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 } },
  },
  // GPT-6 Sol (OpenAI API pricing table, verified 2026-09-23, cache write
  // published at $2.50 / $5.00 long) — IU-listed, no source uses it yet.
  "gpt-6-sol": {
    input: 2.0,
    output: 10.0,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    long: { threshold: LONG_CONTEXT, rate: { input: 4.0, output: 15.0, cacheRead: 0.4, cacheWrite: 5.0 } },
  },
  // GPT-6 Astra — dotfiles' `cxa`, and by a distance the most expensive model
  // in this table: 5x Terra's input and ~4x its output. Deliberately opt-in
  // there for that reason, and the reason this collector exists at all. Same
  // 1.25x / 0.1x caching rule.
  "gpt-6-astra": {
    input: 10.0,
    output: 50.0,
    cacheRead: 1.0,
    cacheWrite: 12.5,
    long: { threshold: LONG_CONTEXT, rate: { input: 20.0, output: 75.0, cacheRead: 2.0, cacheWrite: 25.0 } },
  },
  // The base rows above are the standard short-context (<=272k) schedule; the
  // `long` block on each is OpenAI's over-272k one (2x input, 1.5x output).
  // computeCost picks between them per record from the prompt size.
  // Locally hosted (mlx/ollama) — no marginal token cost.
  "gemma4-agent": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Subset of cacheWrite created at the 1h TTL (not additive). */
  cacheWrite1h: number;
  reasoning: number;
  /**
   * usage_record.grain for this row. The long-context schedule is a
   * per-request concept (OpenAI charges it on one oversized prompt) but
   * 'session' rows (hermes, feuer, opencode) sum tokens across every turn in
   * the session — hundreds of requests, none of them individually anywhere
   * near the threshold. computeCost only evaluates `long` for grain
   * 'message', where the token counts genuinely describe one request.
   */
  grain: Grain;
}

/**
 * Per-tier fallback rates, applied when an Anthropic model has no exact entry
 * above. Anthropic has held each tier's list price flat across releases (Opus
 * 4.7/4.8/5 all $5/$25; Sonnet 4.6/5 both $3/$15), so a new model lands at its
 * tier's rate far more often than not — and a slightly-stale rate beats the
 * silent zero that an unpriced model used to produce. Ordered: the first
 * matching tier wins, so keep the more specific names first. Exact entries in
 * PRICING always take precedence; add one there the moment a tier's price
 * actually diverges.
 */
const FAMILY_PRICING: ReadonlyArray<readonly [tier: string, rate: Rate]> = [
  ["fable", { input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5, cacheWrite1h: 20 }],
  ["mythos", { input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5, cacheWrite1h: 20 }],
  ["opus", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 }],
  ["sonnet", { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 }],
  ["haiku", { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 }],
];

export interface CostResult {
  usd: number | null;
  /**
   * "computed" — exact rate; "family" — Anthropic tier fallback (approximate,
   * a new model at its tier's list price); "none" — unpriced, cost is null.
   */
  source: "computed" | "family" | "none";
}

/**
 * Resolve a model to a rate: exact entry first, then the Anthropic tier
 * fallback. The `claude-` guard keeps the tier match off third-party ids that
 * happen to contain a tier word.
 */
function resolveRate(modelNorm: string): { rate: Rate; source: "computed" | "family" } | null {
  const exact = PRICING[modelNorm];
  if (exact) return { rate: exact, source: "computed" };
  if (!modelNorm.startsWith("claude-")) return null;
  for (const [tier, rate] of FAMILY_PRICING) {
    if (modelNorm.includes(tier)) return { rate, source: "family" };
  }
  return null;
}

/** Compute cost for a model. Returns null when the model has no known rate. */
export function computeCost(modelNorm: string | null, t: TokenCounts): CostResult {
  const resolved = modelNorm ? resolveRate(modelNorm) : null;
  if (!resolved) return { usd: null, source: "none" };
  const base = resolved.rate;

  // Long-context schedules key off the prompt size, so this has to happen per
  // record rather than per model. Without it a >272k call silently bills at
  // half the input rate it actually cost. But the threshold is a per-request
  // concept — OpenAI charges the dearer schedule on one oversized prompt — so
  // it only applies to grain 'message'. A 'session' row (hermes, feuer,
  // opencode) sums tokens across every turn of the whole session; that total
  // can clear 272k many times over without any single request coming close,
  // and pricing it as one giant prompt overcharges those rows badly.
  const promptTokens = t.input + t.cacheRead + t.cacheWrite;
  const rate =
    t.grain === "message" && base.long && promptTokens > base.long.threshold ? base.long.rate : base;

  const cw1h = Math.min(Math.max(t.cacheWrite1h, 0), t.cacheWrite);
  const cw5m = t.cacheWrite - cw1h;

  const usd =
    (t.input * rate.input +
      t.output * rate.output +
      t.cacheRead * rate.cacheRead +
      cw5m * rate.cacheWrite +
      cw1h * (rate.cacheWrite1h ?? rate.cacheWrite) +
      t.reasoning * rate.output) /
    1_000_000;

  return { usd, source: resolved.source };
}
