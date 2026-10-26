// Scrapes the IU self-service cost report. Runs on the MacBook (iumac) in the
// IU-managed Chrome profile that holds the Entra/Okta session; see
// AGENTS.md "IU portal cost". The API key is read from stdin and never touches
// disk. One JSON document per granularity is printed to stdout (NDJSON).
//
//   echo "$KEY" | bun scrape.ts [daily] [monthly]   headless, default: both
//   bun scrape.ts --login                            headed sign-in, waits up to 5 min
//
// Exit codes: 0 ok, 3 session expired, 1 anything else.
import { chromium, type Page } from "playwright-core";
import { renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildLatest } from "./latest.ts";
import { assemble, type Granularity, type PortalDocument, type RawCapture } from "./parse.ts";

const BASE = "https://ue-self-service.app.iu-it.org";
const ROOT = process.env.IU_PORTAL_ROOT ?? join(homedir(), ".local/share/iu-portal");
const PROFILE = join(ROOT, "profile");
const LATEST = join(ROOT, "latest.json");
const EXPIRED = 3;
const LOGIN_WAIT_MS = 5 * 60_000;
const REPORT_SETTLE_MS = 15_000;
const REPORT_DEADLINE_MS = 90_000;

const SELECTION: Record<Granularity, { range: string; label: string }> = {
  daily: { range: "1 Month", label: "Daily" },
  monthly: { range: "3 Months", label: "Monthly" },
};

class SessionExpired extends Error {}

const onPortal = (page: Page) => new URL(page.url()).host === new URL(BASE).host;

/** Reads the raw numbers; no judgement here (that is parse.ts). */
function readCapture(): RawCapture {
  const text = (el: Element | null | undefined) => el?.textContent?.trim() ?? "";
  const cardAfter = (label: string): string => {
    const p = [...document.querySelectorAll("p.mud-typography")].find((e) => text(e) === label);
    return text(p?.parentElement?.querySelector("h6"));
  };
  const heat = document.querySelector("svg.mud-chart-heat");
  const cells = [...(heat?.querySelectorAll("g.mud-chart-cell") ?? [])].map((g) => {
    const rect = g.querySelector("rect");
    return { x: Number(rect?.getAttribute("x")), y: Number(rect?.getAttribute("y")), value: text(g.querySelector("title")) };
  });
  const rowLabels = [...(heat?.querySelectorAll("text.mud-charts-yaxis") ?? [])].map((t) => {
    const m = /translate\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/.exec(t.parentElement?.getAttribute("transform") ?? "");
    return { y: Number(m?.[2]), text: text(t) };
  });
  const periodLabels = [...document.querySelectorAll("svg:not(.mud-chart-heat) text")]
    .map((t) => text(t))
    .filter((t) => /^(\d{4}-\d{2}-\d{2}|\d{6})$/.test(t));
  return {
    totalText: cardAfter("Total Cost"),
    costCenter: cardAfter("Cost Center") || null,
    periodLabels: [...new Set(periodLabels)],
    cells,
    rowLabels,
  };
}

async function generate(page: Page, granularity: Granularity): Promise<PortalDocument> {
  const { range, label } = SELECTION[granularity];
  await page.getByText(range, { exact: true }).click();
  await page.getByText(label, { exact: true }).click();
  await page.getByRole("button", { name: /generate report/i }).click();
  await page.waitForTimeout(REPORT_SETTLE_MS);

  // The previous report stays on screen until the new one renders, so a parse
  // that passes every consistency check is the only proof the chart is current.
  const deadline = Date.now() + REPORT_DEADLINE_MS;
  for (;;) {
    try {
      return assemble(await page.evaluate(readCapture), granularity);
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await page.waitForTimeout(3_000);
    }
  }
}

/** Tinycast reads this file; atomic so it never sees a half-written one. */
function writeLatest(doc: PortalDocument): void {
  const tmp = `${LATEST}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(buildLatest(doc), null, 2)}\n`);
  renameSync(tmp, LATEST);
}

async function login(): Promise<void> {
  const ctx = await chromium.launchPersistentContext(PROFILE, { channel: "chrome", headless: false });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(`${BASE}/cost-overview`, { waitUntil: "domcontentloaded" });
    const deadline = Date.now() + LOGIN_WAIT_MS;
    while (!(onPortal(page) && (await page.locator("input").count()) > 0)) {
      if (Date.now() > deadline) throw new Error("sign-in not completed within 5 minutes");
      await page.waitForTimeout(1_000);
    }
    console.error("iu-portal: signed in, profile saved");
  } finally {
    await ctx.close();
  }
}

async function scrape(granularities: Granularity[]): Promise<void> {
  const key = (await Bun.stdin.text()).trim();
  if (!key) throw new Error("no API key on stdin");
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: "chrome",
    headless: true,
    viewport: { width: 1600, height: 1200 },
  });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(`${BASE}/cost-overview`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4_000);
    if (!onPortal(page)) throw new SessionExpired("redirected to sign-in");
    await page.locator("input").first().fill(key);
    await page.getByRole("button", { name: /load cost data/i }).click();
    await page.waitForTimeout(6_000);
    let printed = 0;
    for (const g of granularities) {
      try {
        const doc = await generate(page, g);
        if (g === "daily") writeLatest(doc);
        console.log(JSON.stringify(doc));
        printed++;
      } catch (err) {
        // A later granularity failing must not discard a report already captured.
        if (printed === 0) throw err;
        console.error(`iu-portal: ${g} report failed after a successful one: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    await ctx.close();
  }
}

const args = process.argv.slice(2);
try {
  if (args.includes("--login")) await login();
  else {
    const picked = args.filter((a): a is Granularity => a === "daily" || a === "monthly");
    await scrape(picked.length > 0 ? picked : ["daily", "monthly"]);
  }
} catch (err) {
  if (err instanceof SessionExpired) {
    console.error("iu-portal: session expired — run make iu-portal-login");
    process.exit(EXPIRED);
  }
  console.error(`iu-portal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
