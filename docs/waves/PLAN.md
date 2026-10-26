# IU portal cost — the real number against the $500/month cap
**Goal:** usage-tracker pulls IU's own cost report (the self-service portal, the number that counts against
the $500 employee cap, a **rolling 30-day window**, not a calendar month) every few hours. `make budget`
then shows rolling30, headroom, can-spend-today, the next-7-day drop-off, the 7-day burn, and portal vs our
own IU-billed estimate per day and model. We keep our own tracking: the point is comparison, never replacement.
**Gate:** `make check` green, plus one **live** `make iu-portal` run whose row count and October total are
recorded in Left behind. Zero LLM spend: this is scraping, not calling models.

## Established — do not re-derive (verified 2026-10-26 from the mini)

- **No API carries cost.** The IU gateway answers 501 on `/openai/v1/{usage,key/info,spend/logs,…}`. The
  only source is the portal `https://ue-self-service.app.iu-it.org/cost-overview`, a Blazor Server +
  MudBlazor app behind Microsoft Entra SSO (careerpartner tenant → Okta). Plain curl gets a 302 to
  login.microsoftonline.com.
- **Auth path that works:** headless Chrome on the **MacBook** (`ssh iumac`, IU-managed with Company
  Portal) through `playwright-core` (1.64.1, `channel: "chrome"`, no browser download) and a dedicated
  persistent profile at `~/.local/share/iu-portal/profile` on iumac. The owner signed in once headed
  (email `<iu-login-email>` → Okta). Every run since is headless and silent. Tooling is
  installed at `~/.local/share/iu-portal/tool` on iumac (package.json + playwright-core).
- **The key never touches disk:** `secrets-run read op://common/anthropic/API_KEY | ssh iumac 'cd
  ~/.local/share/iu-portal/tool && bun scrape.ts'`. The script reads the key from stdin.
- **Page flow** (prototype, since replaced by `tools/iu-portal/scrape.ts`): goto `/cost-overview`
  (`waitUntil: "domcontentloaded"`; **never** `networkidle`, because Blazor's long-polling never idles) →
  if `page.url()` is not on the portal host, the session expired (exit with a distinct code and the message
  "run make iu-portal-login") → fill the first `input` with the key → click button `/load cost data/i` →
  click text `1 Month` + `Daily` (or `3 Months` + `Monthly`) → click `/generate report/i` → wait ~15–20 s.
- **Parse the heatmap, not the bar chart.** `svg.mud-chart-heat` holds one `g.mud-chart-cell` per
  model × period: `<rect x=… y=…>` and `<title>VALUE</title>` (exact USD). Row labels are
  `<g transform="translate(X, Y)"><text class="mud-charts-yaxis">Model Label</text>`, where label Y = cell
  `y + 4`. Columns follow ascending `x` and map in order onto the period labels of the "Cost Breakdown by
  Period" bar chart (`2026-09-26…2026-10-26` daily, `072026…102026` monthly). Do it in `page.evaluate` on
  the DOM, not with regex on HTML. Also read "Total Cost" (`$577.93`) and "Cost Center".
  Validated: the cell sum equals Total Cost to the cent (577.93 over 1 month daily, 1243.36 over 3 months
  monthly). October MTD was **$530.89** on 2026-10-26, already over the cap.
- Labels are prettified ids: `Claude Haiku 5 5 Eu` = `claude-haiku-5-5-eu`, `Gpt 5.6 Terra` =
  `gpt-5.6-terra`, `Deepseek/deepseek V4.1 Flash`. Map them to our normalized models by comparing
  `lower(alnum-only)` of both sides; keep the raw label as well. Two different ids can share a label
  (`Deepseek V4.1 Flash` twice). Store **both** rows by label + row index, never merge them silently.
- The legend lists ~180 models; most rows are all zeros. Store only non-zero cells.
- Interactions: usage-tracker's LaunchAgent runs on the **mini** every 900 s. The MacBook may be asleep or
  away: then `ssh iumac` fails, and the run must skip quietly and leave freshness to `health`.

## Owner correction (2026-10-26, folded into Wave 1)
- The cap is a ROLLING 30-day window. `budget`: rolling30 (last 30 daily values, today included) vs 500,
  headroom, can-spend-today (500 − the 29 days before today), next-7-day drop-off, 7-day burn and the
  projected rolling30 in 7 days. Calendar-month totals are reconciliation data only.
- Per model and per day: portal vs tracked, delta, ratio; flag |delta| > max($1, 20%); list portal models
  with zero tracked cost and tracked models absent from the portal.
- Tinycast contract: every successful scrape writes `~/.local/share/iu-portal/latest.json` on iumac
  (atomic; schema 1: fetched_at, limit_usd, window_days, rolling30_usd, can_spend_today_usd, daily[31],
  top_models[10], dropoff_next7[7]), computed in `tools/iu-portal/latest.ts`. An expired session leaves
  the previous file untouched.

## Wave 1 — Portal cost collector + budget report            <!-- status: done -->
- [x] `tools/iu-portal/scrape.ts`: the prototype as a real script. Key from stdin, prints one JSON
      document to stdout: `{ fetched_at, cost_center, total_usd, granularity, periods[], rows: [{label,
      row, cells: {period: usd}}] }`. Exit codes: 0 ok, 3 session expired, 1 other. `make
      iu-portal-setup` syncs `tools/iu-portal/` to iumac `~/.local/share/iu-portal/tool` and runs `bun
      install` there. `make iu-portal-login` runs it headed through
      `~/SourceRoot/dotfiles/scripts/ask-human.sh ask '…' --cmd '…'` (pushes a dialog to the MacBook). A
      headed run waits up to 5 min for sign-in.
- [x] Table `iu_portal_cost(day TEXT, label TEXT, row INTEGER, model TEXT NULL, cost_usd REAL,
      fetched_at INTEGER, PRIMARY KEY(day,label,row))`, the same pattern as `quota_sample` in
      `src/schema.ts`. Upsert, latest fetch wins (today's value grows). Plus `iu_portal_total(month,
      total_usd, fetched_at)` from a monthly run, which serves as the reconciliation anchor.
- [x] A collector hook in `ingest`, throttled to one portal fetch per 4 h (track the last fetch time),
      daily granularity over 1 month plus a monthly run. Register a `staleAfterHours: 48` freshness
      entry, so `health` flags an expired session or a MacBook that has been away a long time. A failed
      ssh or an expired session must **not** fail the other collectors. It logs a one-line reason.
- [x] `budget` CLI command + `make budget`: month-to-date portal total vs `$500`, linear month-end
      projection, days left, daily burn of the last 7 days. Below that, a per-model table for the month:
      portal USD vs usage-tracker's own `billing = iu` USD (`usage_record`), with delta and ratio, top 15
      by portal cost. Plus a line for portal spend that has no tracked counterpart (calls we do not see:
      other tools, the portal's own tests).
- [x] Tests (scratch DB, fixture DOM JSON, no network). AGENTS.md: the new source, the iumac
      dependency, the login runbook, and the gotcha that the portal is the truth while
      `usage_record.cost_usd` is an estimate. `docs/collectors.md` entry.
- [x] Live: `make iu-portal-setup && make iu-portal`, then `make budget`. Paste the output head into
      Left behind.
**Left behind:**
Wave 1 done; `make check` green (255+ tests), live run verified 2026-10-26. No further wave is planned.
- Live: `make iu-portal-setup && make iu-portal` stored **235 daily cells** (2026-09-26..2026-10-26,
  cell sum $578.25 = Total Cost at scrape time; 49 cells unmatched to a tracked model). October
  calendar total **$530.25** from daily cells (monthly run: $531.39). `latest.json` written on iumac.
- `make budget` head: `rolling30 $572.82 of $500.00 OVER by $72.82`, `can spend today -$65.59`,
  `burn 7d $22.55/day`, rolling30 in 7 days at that burn $666.81; next 7 drop-off days free only
  $63.87 in total, so the headroom stays negative through 2026-10-03's drop.
- **Where we are wrong (first read, for a follow-up):** `sonar` tracked $30.60 vs portal $0.17
  (rate or billing class), `claude-opus-5-5` tracked $6.29 vs portal $49.27, `claude-opus-4-6` $0.01 vs
  $13.74, `claude-sonnet-5*` and `gpt-5.6-terra` (+43%) also off; 2026-10-22 portal $71.44 vs tracked
  $32.34. Portal-only spend: GLM 5.3, Kimi K3, Gemini, ElevenLabs, Fable 5.1 (~$9.7 total).
- Mechanics worth knowing: `make iu-portal-setup` rsyncs with `--delete` (the prototype's
  `capture*.ts` on iumac are gone); the daily report replaces its whole window in `iu_portal_cost`;
  an expired session backs off 4 h; `health` stale after 48 h. `make iu-portal-login` was not exercised
  (needs a human at the MacBook); the headless path was.
(Argo dashboard series for the portal numbers is a follow-up in the argo repo, not this wave.)
