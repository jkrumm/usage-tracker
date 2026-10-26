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

## Wave 2 — Reconcile: make tracked cost agree with the portal            <!-- status: done -->
The portal is the truth; `make budget` now shows where we diverge. Find the cause of each large divergence
and fix it on our side, or document it as IU's side. **No LLM spend.** Read logs, rates and the DB. Never
re-call models to test.
- [x] `sonar` tracked $30.66 vs portal $0.17 (180x): wrong rate, wrong billing class (Perplexity
      `sonar` billed elsewhere?), or per-request fees counted as tokens? Fix `src/pricing.ts` or the
      classification, then `make reprice` (DRYRUN=1 first).
- [x] `claude-opus-5-5` tracked $6.29 vs portal $49.27, `claude-opus-4-6` $0.01 vs $13.74, and
      `claude-sonnet-5*` low: Anthropic-leg IU traffic that no collector sees, or that is classified
      `max` instead of `iu`. Check claude-code `session_env` base_url/lane attribution (`billing-audit`)
      for IU-key sessions, and the iumac mirror. Name the missing source; add it or fix the attribution.
- [x] `gpt-5.6-terra` +43% and `deepseek-v4.1-flash` +17% over: compare our per-token rates and cache
      pricing against IU's effective rate (portal USD / tracked tokens per model per day). Where the
      gateway returns `usage.cost`, prefer it over computed cost. Adjust rates; reprice.
- [x] 2026-10-22 portal $71.44 vs tracked $32.34: which models carry the gap that day, and which tool made those calls?
- [x] Add a `budget --explain <model>` (or similar) that prints portal vs tracked per day for one model
      with tokens and implied rate, so the next divergence takes minutes to diagnose. Tests.
- [x] Left behind: before/after per-model ratio table for the top 15, and for each remaining gap
      whether it is ours (fixed / not fixable) or IU's.
**Left behind:**
Wave 2 done; `make check` green (262 tests). Zero LLM spend. No further wave is planned.
Before -> after, top of the window (portal / tracked / ratio):

| model | before | after | verdict |
|-|-|-|-|
| sonar | $0.17 / $30.66 / 180x | $0.17 / $0.22 / 1.2x | ours, fixed |
| gpt-5.6-terra | $82.77 / $118.54 / 1.43x | $82.77 / $85.50 / 1.03x | ours, fixed |
| deepseek-v4.1-flash | $270.56 / $317.39 / 1.17x | unchanged | ours, not fixable (below) |
| claude-opus-5-5 | $49.27 / $6.29 / 0.13x | unchanged | calls no collector sees |
| claude-opus-4-6, claude-sonnet-5, claude-sonnet-5-5 | 0.00x / 0.18x / 0.10x | unchanged | same unseen calls |
| claude-haiku-5-5 | 0.86x | unchanged | within noise; opencode/IU mix |

- **sonar:** Perplexity's `usage.cost` is list price plus per-request search fees; IU bills tokens only
  (~$1/M). `IGNORE_REPORTED_COST` in `pricing.ts`: `upsertRecords` and `reprice` now price it from tokens.
- **gpt-5.6-terra:** IU did not bill reasoning tokens until 2026-10-16 ~08:55Z (portal = input+output+cache
  before, the full formula to the cent from 10-17). `Rate.reasoningFreeBefore` encodes the cutoff.
  Both repriced in the live DB (`cleared synced_at`, so `sync` re-pushes them).
- **Anthropic-leg gap (opus 5.5/4.6, sonnet 5/5.5, 10-22 $71 vs $32): not an attribution bug.** Checked:
  no `billing=max` claude-code row has a session with an IU `base_url`; claude-code IU rows exist for every
  IU session; the gateway jsonl logs match the DB row-for-row; bench/review lanes are opencode haiku-eu and
  tracked. `make budget MODEL=claude-opus-5-5` shows quiet days (10-20/21/23) match the portal to the cent
  at ~$8/M, so the rate card is right; the missing spend is calls made with the IU key that touch none of
  our collectors (10-22: opus $32.59 portal vs $0.89 tracked, sonnet-5/5.5 $11 vs $1.2). The caller is not
  identifiable from local data: the portal is daily and has no caller field. Next step is IU-side or a
  per-key log, not this repo.
- **deepseek-v4.1-flash +17% and deepseek-v4-flash 2.6x:** days swing 0.72x..1.73x, so it is not a rate.
  Mixed `reported` (gateway cost) and `computed` rows, plus an assumed off-peak window, and the portal's
  daily buckets are not reproducible from per-call timestamps. Over-estimating is the safe direction;
  the cap number comes from the portal.
- **Portal-only models** (GLM 5.3, Kimi K3, Gemini, ElevenLabs, Fable 5.1, ...): ~$10 total, no tracked
  counterpart; IU-side or tools outside our collectors.
- New: `make budget MODEL=<norm>` (`budget --explain`) for the next divergence.

## Wave 3 — The unseen Claude spend is audio-gateway            <!-- status: active -->
Orchestrator finding (2026-10-26), after Wave 2 concluded "caller not identifiable": audio-gateway logs its own LLM
calls to its own SQLite and **no collector reads it**. `~/SourceRoot/audio-gateway/data/usage.db` (the mini
instance, `com.jkrumm.audio-gateway`, :7719, which runs the podcast pipeline), table `usage_record` (id, ts,
endpoint, model, status, input_tokens, output_tokens, audio_tokens, audio_seconds, input_chars, usage_json, caller,
request_id, …, **no cost column**). It has `claude-opus-5-5` / `claude-opus-4-6` `podcast-segment` rows on 10-19,
10-24 and 10-25 (e.g. 10-24: 507k in / 111k out). The VPS instance (STT/TTS: Gemini TTS, Voxtral) is a second
instance with its own DB. The writer bake-off scripts (`audio-gateway/scripts/writer-bakeoff.ts`,
`writer-lab.ts`) probably do not log at all; the 10-22 spike ($32.59 Opus, $11 Sonnet 5/5.5) fits the writer
bake-off. No LLM spend in this wave.
- [ ] Collector `audio-gateway` (mini instance): incremental read of `audio-gateway/data/usage.db`
      `usage_record` (watermark on id or ts, read-only open). Price LLM rows with the central rate card (use
      `usage_json`'s reported cost where present, as the other IU collectors do), billing `iu`. Price TTS/STT
      rows by audio seconds/chars where the rate card has them, else unpriced and flagged. `sub_tool` =
      endpoint. Tests with a fixture DB.
- [ ] VPS instance: find where its usage DB lives (audio-gateway repo docs / compose file, `ssh vps`;
      read-only). If it is reachable cheaply (an `ssh vps sqlite3 … -json` pull of new rows, the same
      pattern as the iumac mirror), add it as a second source id. If not, record why in Left behind.
- [ ] Bake-off/lab scripts: confirm from the audio-gateway source whether `scripts/writer-*.ts` call
      `recordUsage`. If they bypass it, do not edit audio-gateway (another agent owns it right now). Write
      the finding into Left behind as a follow-up for that repo.
- [ ] Backfill the window (`make backfill` scoped to the new source), then `make budget`: record the per-model
      before/after table for the Claude rows, and what portal spend is still unexplained.
- [ ] AGENTS.md + docs/collectors.md entry; `make check`; commit; push.
**Left behind:**
