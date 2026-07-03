import type { Billing } from "./types.ts";

/**
 * Reduce a source's raw model string to a canonical key used for pricing and
 * grouping. Handles OpenCode's JSON-encoded model, the bridge's `-eu` suffix,
 * and provider prefixes like `iu/` or `anthropic/`.
 */
export function normalizeModel(raw: string | null): string | null {
  if (!raw) return null;
  let m = raw.trim();

  // OpenCode stores: {"id":"Kimi-K2.6","providerID":"iu"}
  if (m.startsWith("{")) {
    try {
      const parsed = JSON.parse(m) as { id?: string };
      if (parsed.id) m = parsed.id;
    } catch {
      // fall through with the raw string
    }
  }

  m = m.toLowerCase();
  if (m.includes("/")) m = m.split("/").pop() ?? m;
  m = m.replace(/-eu$/, ""); // bridge EU suffix
  m = m.replace(/-\d{8}$/, ""); // dated variant, e.g. claude-haiku-4-5-20251001
  return m;
}

/**
 * Decide who actually pays for a record. Classification runs on the *raw* model
 * (before normalization) because the bridge's `-eu` suffix is the only signal
 * separating an IU-routed EU Claude worker from a Max-subscription Claude call.
 */
export function classifyBilling(source: string, rawModel: string | null): Billing {
  const r = (rawModel ?? "").toLowerCase();

  if (source === "claude-code") {
    // Only a Max-subscription Claude orchestrator bills as `max`. Everything else
    // in a claude-code session (DeepSeek/Kimi/GPT bridge workers, `-eu` EU-routed
    // Claude) reached the model through the IU LiteLLM bridge — real IU spend, and
    // already counted per-request by the `litellm` source, so the collector skips
    // it (see claude-code.ts) to avoid double-counting. `unknown` never occurs.
    if (r.startsWith("claude") && !r.endsWith("-eu")) return "max"; // orchestrator on Max
    return "iu";
  }

  // hermes / feuer / opencode all route through the IU LiteLLM bridge.
  return "iu";
}
