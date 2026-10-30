import { ALIASES } from "./aliases.ts";
import type { PriceBook, PriceRow } from "./cost.ts";
import { normalizeLiteLLM, normalizeOpenRouter, type OpenRouterModel } from "./normalize.ts";
import litellmSnapshot from "./fixtures/litellm-snapshot.json";
import openRouterSnapshot from "./fixtures/openrouter-snapshot.json";
import { OPENROUTER_PREFIX, type SyncDeps } from "./sync.ts";

// Committed catalog fixtures (the keys our aliases reference, copied from the live files) so no test touches the
// network. The litellm snapshot is the 2026-10-30 download.

export const LITELLM_FIXTURE = litellmSnapshot as Record<string, unknown>;
export const OPENROUTER_FIXTURE = openRouterSnapshot.data as OpenRouterModel[];
export const FIXTURE_SINCE = new Date("2026-10-01T00:00:00Z");
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

export function fixtureDeps(over: Partial<SyncDeps> & { litellm?: Record<string, unknown> } = {}): SyncDeps {
  return {
    fetchLiteLLM: async () => over.litellm ?? LITELLM_FIXTURE,
    fetchOpenRouter: async () => OPENROUTER_FIXTURE,
    now: () => FIXTURE_SINCE,
    log: silent,
    ...over,
  };
}

/** The price book the fixture sync produces, built without a database. */
export function fixtureBook(): PriceBook {
  const prices: PriceRow[] = [];
  const keys = [...new Set(ALIASES.map((a) => a.modelKey))];
  for (const key of keys) {
    const schedule = key.startsWith(OPENROUTER_PREFIX)
      ? normalizeOpenRouter(OPENROUTER_FIXTURE.find((m) => m.id === key.slice(OPENROUTER_PREFIX.length)))
      : normalizeLiteLLM(LITELLM_FIXTURE[key]);
    if (schedule) prices.push({ id: prices.length + 1, modelKey: key, validFrom: FIXTURE_SINCE, schedule });
  }
  return { aliases: new Map(ALIASES.map((a) => [a.model, a.modelKey])), prices, overrides: [] };
}
