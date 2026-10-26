import { expect, test } from "bun:test";
import { monthDoc } from "./fixture.ts";
import { addDays, buildLatest } from "./latest.ts";

test("latest.json follows the Tinycast contract", () => {
  const l = buildLatest(monthDoc());
  expect(l.schema).toBe(1);
  expect(l.limit_usd).toBe(500);
  expect(l.window_days).toBe(30);
  // window = 2026-09-27..2026-10-26: 30 × $1 + the extra $10 today
  expect(l.rolling30_usd).toBe(40);
  // 29 days before today, $1 each
  expect(l.can_spend_today_usd).toBe(471);
  expect(l.daily).toHaveLength(31);
  expect(l.daily[0]).toEqual({ day: "2026-09-26", usd: 1 });
  expect(l.daily.at(-1)).toEqual({ day: "2026-10-26", usd: 11 });
  expect(l.top_models).toEqual([
    { label: "Gpt 5.6 Terra", usd: 10 },
    { label: "Claude Haiku 5 5 Eu", usd: 30 },
  ].sort((a, b) => b.usd - a.usd));
  // 2026-09-27 is the oldest day in the window and leaves tomorrow
  expect(l.dropoff_next7.map((d) => d.day)).toEqual([
    "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03",
  ]);
  expect(l.dropoff_next7.every((d) => d.frees_usd === 1)).toBe(true);
});

test("days the portal omitted count as zero and the window is exactly 30 days", () => {
  const doc = monthDoc();
  doc.rows = [{ label: "X", row: 0, cells: { "2026-09-26": 100, "2026-09-27": 5 } }];
  const l = buildLatest(doc);
  expect(l.rolling30_usd).toBe(5); // 09-26 is day 31: outside the window
  expect(l.daily[0]).toEqual({ day: "2026-09-26", usd: 100 });
});

test("a monthly report is refused", () => {
  expect(() => buildLatest({ ...monthDoc(), granularity: "monthly" })).toThrow(/daily/);
});

test("addDays crosses month and year boundaries", () => {
  expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
});
