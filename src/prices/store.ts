import type { SQL } from "bun";
import type { OverrideRow, PriceBook, PriceRow } from "./cost.ts";
import { canonDecimal, type OffPeak, type Schedule, type Tier } from "./normalize.ts";

// usage.prices rows <-> Schedule. Postgres hands numerics back as text with the stored scale, so they are
// canonicalised before any comparison.

const dec = (v: unknown): string | null => (v === null || v === undefined ? null : canonDecimal(String(v)));
const json = <T>(v: unknown): T | null => (v === null || v === undefined ? null : typeof v === "string" ? (JSON.parse(v) as T) : (v as T));

export function rowSchedule(row: Record<string, unknown>): Schedule {
  return {
    rates: {
      input: dec(row.input) as string,
      output: dec(row.output) as string,
      cache_read: dec(row.cache_read),
      cache_write_5m: dec(row.cache_write_5m),
      cache_write_1h: dec(row.cache_write_1h),
    },
    batch: json(row.batch),
    tiers: json<Tier[]>(row.tiers),
    offPeak: json<OffPeak>(row.off_peak),
  };
}

export interface NewPrice {
  modelKey: string;
  validFrom: Date;
  schedule: Schedule;
  source: "litellm" | "openrouter" | "seed-git";
  sourceRef: string;
  fetchedAt: Date;
}

/** Returns true when a row was written (false = that (model_key, valid_from) already exists). */
export async function insertPrice(sql: SQL, p: NewPrice): Promise<boolean> {
  const s = p.schedule;
  // Cast through text: a string bound straight to jsonb is stored as a JSON string scalar.
  const j = (v: unknown) => (v === null ? null : JSON.stringify(v));
  const rows = await sql`
    INSERT INTO usage.prices
      (model_key, valid_from, input, output, cache_read, cache_write_5m, cache_write_1h, batch, tiers, off_peak,
       source, source_ref, fetched_at)
    VALUES
      (${p.modelKey}, ${p.validFrom}, ${s.rates.input}::numeric, ${s.rates.output}::numeric, ${s.rates.cache_read}::numeric,
       ${s.rates.cache_write_5m}::numeric, ${s.rates.cache_write_1h}::numeric, ${j(s.batch)}::text::jsonb, ${j(s.tiers)}::text::jsonb,
       ${j(s.offPeak)}::text::jsonb, ${p.source}, ${p.sourceRef}, ${p.fetchedAt})
    ON CONFLICT (model_key, valid_from) DO NOTHING
    RETURNING id`;
  return rows.length > 0;
}

/** Every stored price row of the given keys, oldest first. */
export async function loadTimelines(sql: SQL, keys: string[]): Promise<Map<string, PriceRow[]>> {
  const out = new Map<string, PriceRow[]>(keys.map((k) => [k, []]));
  if (keys.length === 0) return out;
  const rows = await sql`SELECT * FROM usage.prices WHERE model_key IN ${sql(keys)} ORDER BY model_key, valid_from`;
  for (const r of rows) {
    out.get(String(r.model_key))?.push({
      id: Number(r.id),
      modelKey: String(r.model_key),
      validFrom: new Date(r.valid_from as string | Date),
      schedule: rowSchedule(r),
    });
  }
  return out;
}

/** The whole price book (aliases, prices, overrides) for the pure cost functions. */
export async function loadPriceBook(sql: SQL): Promise<PriceBook> {
  const aliases = new Map<string, string>();
  for (const a of await sql`SELECT model, model_key FROM usage.price_aliases`) aliases.set(String(a.model), String(a.model_key));
  const prices: PriceRow[] = (await sql`SELECT * FROM usage.prices`).map((r: Record<string, unknown>) => ({
    id: Number(r.id),
    modelKey: String(r.model_key),
    validFrom: new Date(r.valid_from as string | Date),
    schedule: rowSchedule(r),
  }));
  const overrides: OverrideRow[] = (await sql`SELECT * FROM usage.price_overrides`).map((r: Record<string, unknown>) => ({
    id: Number(r.id),
    model: String(r.model),
    validFrom: new Date(r.valid_from as string | Date),
    validTo: r.valid_to ? new Date(r.valid_to as string | Date) : null,
    supersedesPrices: Boolean(r.supersedes_prices),
    schedule: rowSchedule(r),
  }));
  return { aliases, prices, overrides };
}
