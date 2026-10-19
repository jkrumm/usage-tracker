import { PRICING } from "./pricing.ts";

// Read-only comparison of PRICING's peak rates against Requesty's public
// catalogue. Requesty reports per-token USD; PRICING is per 1M tokens.

export const REQUESTY_MODELS_URL = "https://router.requesty.ai/v1/models";

/** IU id -> Requesty id. Peak rates only: the off-peak window is IU-side and stays hand-maintained. */
export const REQUESTY_MAP: Readonly<Record<string, string>> = {
  "deepseek-v4.1-flash": "deepseek/deepseek-v4.1-flash",
};

const TOLERANCE = 0.01;

export interface RequestyModel {
  id: string;
  input_price: number;
  output_price: number;
  cached_price: number;
}

export async function fetchRequestyModels(): Promise<RequestyModel[]> {
  const res = await fetch(REQUESTY_MODELS_URL);
  if (!res.ok) throw new Error(`requesty models: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: RequestyModel[] };
  return body.data ?? [];
}

function fmt(usdPerM: number): string {
  return String(Number(usdPerM.toFixed(6)));
}

function drifted(local: number, upstream: number): boolean {
  if (local === 0) return upstream !== 0;
  return Math.abs(upstream - local) / Math.abs(local) > TOLERANCE;
}

export function checkPricingDrift(
  models: RequestyModel[],
  map: Readonly<Record<string, string>> = REQUESTY_MAP,
): { lines: string[]; ok: boolean } {
  const byId = new Map(models.map((m) => [m.id, m]));
  const lines: string[] = [];
  let ok = true;

  for (const [iuId, upstreamId] of Object.entries(map)) {
    const local = PRICING[iuId];
    if (!local) {
      lines.push(`${iuId}: missing from PRICING`);
      ok = false;
      continue;
    }
    const remote = byId.get(upstreamId);
    if (!remote) {
      lines.push(`${iuId} -> ${upstreamId}: missing upstream`);
      ok = false;
      continue;
    }

    const fields: Array<[string, number, number]> = [
      ["input", local.input, remote.input_price * 1e6],
      ["output", local.output, remote.output_price * 1e6],
      ["cached", local.cacheRead, remote.cached_price * 1e6],
    ];
    const isDrift = fields.some(([, l, u]) => drifted(l, u));
    if (isDrift) ok = false;
    const detail = fields.map(([name, l, u]) => `${name} ${fmt(l)} vs ${fmt(u)}`).join(", ");
    lines.push(`${iuId} -> ${upstreamId}: ${isDrift ? "drift" : "ok"} (${detail})`);
  }

  return { lines, ok };
}
