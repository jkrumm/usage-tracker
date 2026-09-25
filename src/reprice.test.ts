import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SCHEMA } from "./schema.ts";
import { reprice } from "./reprice.ts";

function seed(costUsd: number | null, costSource: string, model = "gpt-5.6-luna"): Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  db.prepare(
    `INSERT INTO usage_record
      (source, source_id, grain, ts, model, model_norm, billing,
       input_tokens, output_tokens, cost_usd, cost_source, ingested_at, synced_at)
     VALUES ('hermes','a','message','2026-08-01T00:00:00Z',$model,$model,'iu',
             100000, 100000, $cost, $source, '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z')`,
  ).run({ $model: model, $cost: costUsd, $source: costSource });
  return db;
}

describe("reprice", () => {
  test("rewrites a row priced at a stale rate and clears synced_at", () => {
    // 100k in + 100k out — deliberately under pricing.ts's 272k long-context
    // threshold, so this exercises reprice and not the surcharge schedule.
    const db = seed(0.07, "computed"); // old luna rate: $0.10/$0.60
    const result = reprice(db);

    expect(result.changed).toBe(1);
    const row = db
      .query<{ cost_usd: number; synced_at: string | null }, []>(
        "SELECT cost_usd, synced_at FROM usage_record",
      )
      .get();
    expect(row?.cost_usd).toBeCloseTo(0.14, 10); // $0.20 in + $1.20 out
    expect(row?.synced_at).toBeNull();
    db.close();
  });

  test("leaves an already-correct row alone, synced_at included", () => {
    const db = seed(0.14, "computed");
    const result = reprice(db);

    expect(result.changed).toBe(0);
    const row = db
      .query<{ synced_at: string | null }, []>("SELECT synced_at FROM usage_record").get();
    expect(row?.synced_at).toBe("2026-08-02T00:00:00Z");
    db.close();
  });

  test("prices a row the table could not price before", () => {
    const db = seed(null, "none");
    expect(reprice(db).changed).toBe(1);
    const row = db.query<{ cost_source: string }, []>("SELECT cost_source FROM usage_record").get();
    expect(row?.cost_source).toBe("computed");
    db.close();
  });

  test("dry run reports without writing", () => {
    const db = seed(0.7, "computed");
    const result = reprice(db, { dryRun: true });

    expect(result.changed).toBe(1);
    expect(result.dryRun).toBe(true);
    const row = db.query<{ cost_usd: number }, []>("SELECT cost_usd FROM usage_record").get();
    expect(row?.cost_usd).toBe(0.7);
    db.close();
  });

  test("--model narrows the scan", () => {
    const db = seed(0.7, "computed", "some-unpriced-model");
    const result = reprice(db, { model: "gpt-5.6-luna" });
    expect(result.scanned).toBe(0);
    expect(result.changed).toBe(0);
    db.close();
  });
});

describe("reprice — vendor-reported cost", () => {
  test("never rewrites a cost_source 'reported' row, even for a priced model", () => {
    // The model is priced, so without the reported guard this row would be
    // recomputed to 0.14; the vendor's per-call cost must survive.
    const db = seed(0.42, "reported");
    const result = reprice(db);

    expect(result.changed).toBe(0);
    const row = db
      .query<{ cost_usd: number; cost_source: string; synced_at: string | null }, []>(
        "SELECT cost_usd, cost_source, synced_at FROM usage_record",
      )
      .get();
    expect(row?.cost_usd).toBe(0.42);
    expect(row?.cost_source).toBe("reported");
    expect(row?.synced_at).toBe("2026-08-02T00:00:00Z");
    db.close();
  });
});

describe("reprice — rates removed from the table", () => {
  test("never rewrites a priced row to unpriced", () => {
    const db = seed(5.25, "computed", "gemini-3.1-flash-tts-preview");
    const result = reprice(db);

    expect(result.changed).toBe(0);
    expect(result.preserved).toBe(1);
    const row = db
      .query<{ cost_usd: number; synced_at: string | null }, []>(
        "SELECT cost_usd, synced_at FROM usage_record",
      )
      .get();
    expect(row?.cost_usd).toBe(5.25);
    expect(row?.synced_at).toBe("2026-08-02T00:00:00Z");
    db.close();
  });
});
