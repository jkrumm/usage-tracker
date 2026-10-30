# Reconciliation: IU portal actuals vs tracked spend, 2026-10-30

Wave 2 step 4. Window: the portal's rolling 30 days 2026-10-01..10-30 (fetched 2026-10-30 ~11:00Z), per IU key, by UTC day.
Method: `make budget` (portal `usage.iu_portal_cost` against `usage.records_unique`, `billing = 'api_key'`), then per
day and model queries on `usage.records` and the portal cells, token sums, hours, sources, lanes and machines. Read-only except for the
changes listed under "Shipped". Dollar figures are USD.

## Result

| Key | Portal rolling-30 | Tracked at the start of this step | After 0006 (DeepSeek back on the catalog) | After 0007/0008 (mirror copies marked) |
|-|-|-|-|-|
| personal | 595.30 | 608.17 (+12.87) | 533.00 (-62.30) | **501.76 (-93.54)** |
| athena-team | 154.42 | 154.73 (+0.31) | 154.73 | **154.75 (+0.33)** |

The personal key looked reconciled (+2%) only because two errors cancelled the holes: the DeepSeek overrides overstated `deepseek-v4-pro`
and `deepseek-v4.1-flash` by $75 (portal fit, below) and the audio-gateway calls were stored twice ($31 in October). The honest
gap is **-$93.54** (tracked is 84% of the portal). Where it sits (personal):

| Category | USD | Share |
|-|-|-|
| B. 2026-10-22: Claude (opus-5-5, sonnet-5, sonnet-5-5, haiku-5-5) the portal bills and no row records | -43.08 | 46% |
| B. 2026-10-13/14: 24 h hole between the `opencode` and `agent-gateway-opencode` collectors (deepseek flash/pro) | -20.46 | 22% |
| A. haiku-5-5 cache-write TTL (OpenCode reports one cache-write total, all counted as 5m) | -11.11 | 12% |
| A. deepseek-v4.1-flash catalog schedule (0.95x on 26 clean days) | -9.83 | 11% |
| A. deepseek-v4-pro catalog schedule (0.76x) | -4.99 | 5% |
| A. gpt-5.6-terra reasoning cutoff (we bill reasoning from 08:55Z on 10-16, IU from ~12:00Z) | +2.79 | |
| B. other portal-only cells (fable-5-1, gpt-6-astra, gemini-4-argon, embeddings, ...) | -3.77 | |
| C. tracked, never billed by the portal (grok-4.7 0.70, opus-5-5 0.74 on 10-07, ...) | +1.94 | |
| E. scatter, both sides present, none above $1.7 | -5.02 | 5% |
| **Total** | **-93.54** | |

Unexplained after this table: the E row, $5.02 (5%), plus the attribution of the 10-22 and 10-13/14 holes to a *named producer*, which
the data does not give (below). Team key: +$0.33 over the window, but not for a good reason: it is -$9.7 up to 10-26 (build phase,
no producer rows) and +$10.0 from 10-27 (athena-teamchat chat-turn cost above the portal).

Legend of the category column: **A** our rate or schedule is off, **B** calls no collector sees (portal-only), **C** rows we track that
the portal does not bill to this key (mirror copies, non-IU services), **D** day-edge / timezone noise, **E** other. D has no entry: both
calendars are UTC, and no flagged day is a midnight shift (10-13/14 checked by hour; the 10-22 shortfall is whole models, not a day edge).

## Per key, per day

### personal

| Day | Portal | Tracked (raw) | Tracked (unique) | Delta | Ratio | Flag | Category and driver |
|-|-|-|-|-|-|-|-|
| 2026-10-01 | 17.72 | 16.79 | 16.78 | -0.94 | 0.95x |  | E. deepseek-v4.1-flash -1.19 (0.89x of the portal), catalog schedule noise |
| 2026-10-02 | 3.54 | 2.66 | 2.66 | -0.88 | 0.75x |  | E. gpt-6-luna portal-only 0.53 (small email/hermes calls), deepseek -0.33 |
| 2026-10-03 | 0.04 | 0.04 | 0.04 | -0.00 | 0.90x |  |  |
| 2026-10-04 | 4.07 | 4.04 | 4.04 | -0.03 | 0.99x |  |  |
| 2026-10-05 | 12.11 | 11.01 | 11.01 | -1.10 | 0.91x |  | A. deepseek-v4.1-flash -0.87 (0.89x) |
| 2026-10-06 | 9.37 | 9.03 | 9.03 | -0.34 | 0.96x |  |  |
| 2026-10-07 | 18.45 | 19.16 | 19.16 | +0.71 | 1.04x |  | C. claude-opus-5-5 tracked 0.74 (agent-gateway-iu), no opus cell in the portal that day |
| 2026-10-08 | 10.57 | 8.66 | 8.66 | -1.91 | 0.82x |  | B. claude-haiku-5-5 portal-only 1.05 (first day of the 'Haiku 5 5 Eu' label; tracked only 0.04 from hermes), deepseek -0.85 |
| 2026-10-09 | 12.32 | 12.02 | 12.02 | -0.30 | 0.98x |  |  |
| 2026-10-10 | 15.35 | 15.60 | 15.60 | +0.25 | 1.02x |  |  |
| 2026-10-11 | 7.44 | 7.51 | 7.51 | +0.07 | 1.01x |  |  |
| 2026-10-12 | 4.64 | 4.64 | 4.61 | -0.03 | 0.99x |  |  |
| 2026-10-13 | 21.50 | 15.83 | 15.83 | -5.67 | 0.74x | off | **B. OpenCode collector handover.** deepseek-v4.1-flash -5.29: the last `opencode` row is 10-13 12:34Z, the first `agent-gateway-opencode` row 10-14 12:36Z |
| 2026-10-14 | 42.72 | 27.93 | 27.93 | -14.79 | 0.65x | off | **B. same 24 h hole.** deepseek-v4.1-flash -12.34, deepseek-v4-pro -2.42 (the pro/flash traffic of the agent-gateway OpenCode workers before 12:36Z) |
| 2026-10-15 | 28.70 | 27.63 | 27.63 | -1.07 | 0.96x |  | A. deepseek-v4-pro -0.89 (0.68x) |
| 2026-10-16 | 41.06 | 41.45 | 41.45 | +0.39 | 1.01x |  | A. gpt-5.6-terra +2.83: reasoning billed from 08:55Z, the portal fits ~12:00Z; pro -1.63 |
| 2026-10-17 | 38.90 | 33.77 | 33.77 | -5.13 | 0.87x |  | A/B. pro -1.61 (0.56x), haiku-5-5 -1.44 (cache-write TTL); portal-only claude-fable-5-1 0.78, gpt-6-astra 0.37, opus +0.34 (calls no collector rows) |
| 2026-10-18 | 40.77 | 38.97 | 38.97 | -1.80 | 0.96x |  | A. haiku-5-5 -1.67 (0.85x, cache-write TTL) |
| 2026-10-19 | 43.12 | 50.31 | 40.93 | -2.19 | 0.95x |  | C. was +7.19: audio-gateway mirror copies ($9.38) marked; left: deepseek -0.75, haiku -0.64, gpt-6.1-sol portal-only 0.37 |
| 2026-10-20 | 5.75 | 5.47 | 5.47 | -0.28 | 0.95x |  |  |
| 2026-10-21 | 10.08 | 9.38 | 9.38 | -0.70 | 0.93x |  |  |
| 2026-10-22 | 71.44 | 28.36 | 28.36 | -43.08 | 0.40x | off | **B. Claude on the IU Bedrock route, no collector row.** opus-5-5 -31.70, sonnet-5 -5.42, sonnet-5-5 -4.37, haiku-5-5 -0.88 (see 'The 2026-10-22 hole') |
| 2026-10-23 | 17.91 | 16.41 | 16.40 | -1.51 | 0.92x |  | A. haiku-5-5 -1.05 (0.75x) |
| 2026-10-24 | 18.58 | 22.83 | 18.15 | -0.43 | 0.98x |  | C. was +4.25: audio-gateway mirror (opus-5-5 $4.25 twice) marked; now within $0.50 |
| 2026-10-25 | 26.87 | 26.30 | 22.54 | -4.33 | 0.84x |  | B/A. deepseek -1.85, glm-5.3 portal 2.57 vs tracked 0.87 (audio-gateway, partial coverage), haiku -1.09; grok-4.7 +0.70 tracked, not billed |
| 2026-10-26 | 46.38 | 54.23 | 40.87 | -5.51 | 0.88x |  | B/A. was +7.85: mirror copies ($14.00) marked; left: haiku -1.16, opus-5-5 -1.09, gpt-6.1-sol -1.06, deepseek -0.93, sonnet-5-5 -0.59 (audio-gateway calls only one store saw) |
| 2026-10-27 | 13.78 | 12.43 | 12.43 | -1.35 | 0.90x |  | A. haiku-5-5 -1.04 (0.86x) |
| 2026-10-28 | 8.72 | 7.37 | 7.37 | -1.35 | 0.84x |  | A. deepseek -0.70, haiku-5-5 -0.65 |
| 2026-10-29 | 3.39 | 3.16 | 3.16 | -0.23 | 0.93x |  |  |
| 2026-10-30 | 0.01 | 0.01 | 0.01 | +0.00 | 1.17x |  |  |
| **Total** | **595.30** | **533.00** | **501.76** | **-93.54** | 0.84x | | |


### athena-team

| Day | Portal | Tracked (raw) | Tracked (unique) | Delta | Ratio | Flag | Category and driver |
|-|-|-|-|-|-|-|-|
| 2026-10-22 | 0.29 | 0.08 | 0.08 | -0.21 | 0.28x |  | B. first team-key day; only 3 athena-teamchat chat-turn rows |
| 2026-10-23 | 4.86 | 4.00 | 4.00 | -0.86 | 0.82x |  | B. athena-teamchat chat-turn rows only (OpenCode's own cost, 4.00 vs 2.48 as deepseek tokens) |
| 2026-10-24 | 5.76 | 4.39 | 4.39 | -1.37 | 0.76x | off | B. portal deepseek 5.75 vs 4.39 tracked (chat-turn cost); build-phase calls with no producer row (evals, extractor/judge) |
| 2026-10-25 | 12.57 | 7.13 | 7.13 | -5.44 | 0.57x | off | **B.** portal deepseek 12.56 vs 7.13: build-phase use of the team key that no source recorded (AGENTS: eval runs, `epx web ask`, relay logs), 1,116 chat-turn rows only |
| 2026-10-26 | 4.97 | 3.19 | 3.19 | -1.78 | 0.64x | off | B. same: portal deepseek 4.97 vs 3.19 |
| 2026-10-27 | 3.15 | 4.08 | 4.08 | +0.93 | 1.29x |  | E. chat-turn cost 3.86 vs portal 3.15 |
| 2026-10-28 | 48.82 | 54.47 | 54.47 | +5.65 | 1.12x |  | C/E. agent-workflows ties to the portal per model (sonnet-5-5 16.95 vs 16.97, opus, gemini, pplx to the cent); the surplus is athena-teamchat chat-turn cost (21.59) and the `research-gateway` engine pseudo-model (9.33) |
| 2026-10-29 | 64.97 | 67.20 | 67.20 | +2.23 | 1.03x |  | C/E. same mix |
| 2026-10-30 | 9.03 | 10.39 | 10.39 | +1.36 | 1.15x |  | C/E. same mix (partial day) |
| **Total** | **154.42** | **154.93** | **154.93** | **+0.51** | 1.00x | | |


### Pooled portal vs tracked per model (personal, 2026-10-01..10-30, days 10-08, 10-13, 10-14 and 10-22 excluded)

| Model | Portal | Tracked | Tracked / portal | Days |
|-|-|-|-|-|
| deepseek-v4.1-flash | 199.71 | 190.72 | 0.95 | 26 |
| claude-haiku-5-5 | 76.29 | 66.19 | 0.87 | 18 |
| gpt-5.6-terra | 61.81 | 64.61 | 1.05 | 18 |
| claude-opus-5-5 | 29.08 | 27.63 | 0.95 | 11 |
| claude-haiku-4-5 | 26.81 | 28.38 | 1.06 | 9 |
| deepseek-v4-pro | 20.44 | 15.45 | 0.76 | 14 |
| gpt-6.1-sol | 10.05 | 8.54 | 0.85 | 3 |
| claude-opus-4-6 | 6.77 | 6.52 | 0.96 | 2 |
| gpt-6-luna | 3.41 | 2.34 | 0.69 | 13 |
| gemini-3.8-flash | 3.29 | 2.69 | 0.82 | 6 |
| glm-5.3 | 2.57 | 0.87 | 0.34 | 1 |
| claude-sonnet-5-5 | 2.16 | 1.52 | 0.70 | 3 |
| kimi-k3 | 1.86 | 1.85 | 1.00 | 2 |


## The flagged days

### Personal 2026-10-22: -$43.08 (the largest hole)

Portal that day: opus-5-5 32.59, deepseek-v4.1-flash 13.74, gpt-5.6-terra 7.25, sonnet-5 6.61, haiku-5-5 6.52, sonnet-5-5 4.37, haiku-4-5
0.23, pro 0.10. Deepseek and terra tie to within 3%; the Claude cells are 50.32 against 7.72 tracked (agent-gateway-iu opus 0.89,
claude-code api_key sonnet-5 1.19, agent-gateway-opencode haiku 5.61, claude-code haiku 0.03).

- **Not a Max misclassification at scale.** 100 Max sessions that day have a `session_env` line (empty `base_url`, i.e. the default
  endpoint); 187 sessions have none, but together they hold 566 rows and $4.75 list value, all `claude-sonnet-5` but nine haiku rows, all between 08:06Z
  and 09:22Z, lane `other` / `agw_workflow`, one to three rows per session: a headless worker burst. That is the best match for the
  sonnet-5 gap (portal 6.61 vs tracked 1.19 + 4.74 = 5.93 if those rows were IU-billed). They are *not* reclassified: nothing in the data
  proves their key, and the same shape was `api_key` before 10-01 (via the agent-gateway attribution) and `max` after.
- **Not a duplicate:** no mirror pair exists that day; agent-workflows did not exist yet; the team key was idle (0.29).
- **Opus 31.70** has no matching rows at all. One Max session (`71b3c7c3`, wave_mother, basalt-ui, 05:09-14:22Z, 562 rows) happens to
  have an opus-5-5 list value of $32.63, 3% from the gap, but it carries a `session_env` line with the Max account and no
  `ANTHROPIC_BASE_URL`; read as a coincidence unless the owner knows otherwise.
- **Producer: not named by the data.** Candidates, in order of fit: an IU-key Claude Code session launched without the hook
  (`ca` on a host whose hook log was never mirrored), and Athena build-phase work on the personal key on the day the team key first
  appeared (plausible, not shown: the same Claude mix the Athena relay serves). The IU rate for opus-5-5 is list (below), so the amount is real
  usage, not a rate effect. Action for the owner: ask what ran on the IU key that day.

### Personal 2026-10-13 and 10-14: -$5.67 and -$14.79

deepseek-v4.1-flash portal 13.99 / 30.85 against tracked 8.70 / 18.51, deepseek-v4-pro 3.55 against 1.13 on 10-14. On every other
day from 10-04 the same model ties at 0.96-1.00x. Cause: the OpenCode traffic of the agent-gateway workers has no collector for 24 h.
The `opencode` collector's last row is 2026-10-13 12:34:45Z (and `~/.local/share/opencode/opencode.db` itself ends at 12:34:45Z, so
nothing is waiting to be read there); `agent-gateway-opencode` starts at 10-14 12:36:05Z. Between them
the other sources (agent-gateway-iu, research-gateway, claude-code) keep writing, which is why the hole is partial: 10-13 lost its
afternoon/evening OpenCode share, 10-14 its first 12.6 h. Hourly rows show the shape: `opencode` 271+449 rows in 10-13 11:00-12:59Z,
then nothing until `agent-gateway-opencode` 10-14 12:00Z. Missing is about $17.6 of deepseek flash plus $2.4 of pro. Not recoverable
from this host.

### Personal 2026-10-24 (+4.25), 10-19 (+7.19), 10-26 (+7.85): double counting (category C)

The audio gateway was recorded twice (see "Dedup"). On 10-24 claude-opus-5-5 $4.25 (22 rows) sits in `audio-gateway` and
`audio-gateway-mini` with identical tokens; 10-19 has $9.38, 10-26 $14.00. After the marks the three days are -0.43, -2.19, -5.51.

### Team key 2026-10-24, 10-25, 10-26: -$1.37, -$5.44, -$1.78

Only `athena-teamchat` rows exist on these days (778, 2,243 and 757 rows, model NULL, cost = OpenCode's own figure). Portal: deepseek-v4.1-flash
5.75, 12.56, 4.97 against tracked 4.39, 7.13, 3.19. The shortfall is the build-phase use the AGENTS gotcha lists (eval runs through the
relay with the same key, `epx web ask`, relay logs) plus OpenCode's price table being cheaper than IU's for these turns. Priced as
deepseek tokens the chat-turn rows come to 2.48 / 1.68 / 2.73 on 10-23 / 10-24 / 10-25, so the shortfall is not a pricing mistake of ours:
the portal sees calls these rows do not contain. Cumulative delta: -0.2 (10-22), -1.1, -2.4, -7.9, -9.7 (10-26), then -8.7, -3.1, -0.9 and +0.3 (10-30) as
agent-workflows and the larger chat-turn rows arrive.

## Rates: what the data supports

**Claude on Bedrock/Azure (IU's EU route).** Pooled over the days with full coverage (10-08, 10-13, 10-14, 10-22 excluded), personal key:

| Model | Portal | Tracked | Tracked / portal | Reading |
|-|-|-|-|-|
| claude-opus-5-5 | 29.08 | 27.63 | 0.95 | list price: on every clean day the agent-gateway-iu rows equal the portal to the cent (10-20 0.33, 10-21 0.38, 10-23 0.37, 10-27 0.59, 10-28 1.29, 10-29 0.55; 10-24 and 10-25 after the mirror copies: 4.74 vs 4.74, 5.55 vs 5.56) |
| claude-sonnet-5-5 | 2.16 | 1.52 | 0.70 | 10-25: 0.20 vs 0.20; 10-26 short because audio-gateway saw only part of the calls |
| claude-sonnet-5 | 6.95 | 1.28 | 0.18 | portal-only 10-22 (see above) |
| claude-haiku-4-5 | 26.81 | 28.38 | 1.06 | tracked/portal is 1.04-1.10 on 10 consecutive days (claude-code rows with the real 5m/1h split): IU bills ~0.94x list, effect $1.88 |
| claude-haiku-5-5 | 76.29 | 66.19 | 0.87 | not a multiple: 0.74-1.00 by day |
| claude-opus-4-6 | 6.77 | 6.52 | 0.96 | the 1.93x was the mirror copies (exactly 2.00x on 09-28 and 10-19) |

IU's EU rate is **not a fixed multiple of list** (opus-5-5 1.00, haiku-4-5 0.94, haiku-5-5 above 1.0), so no Claude override is written.
Haiku 5.5: with input, output and cache read at list (0.1 / 0.5 / 0.01), the cache-write rate that closes each day is 0.124 on 10-14/15
(= the 5m rate 0.125) and 0.14-0.29 on the others (1h is 0.20): a mix of 5m and 1h writes. OpenCode reports one cache-write total, the
collector counts it all as 5m, so $11.1 stays open. A blended override would also reprice Max rows and the claude-code rows that have the
real split; the fix belongs in the source (a TTL split), not in a price row.

**DeepSeek.** The catalog schedule (0006): `deepseek-v4.1-flash` ties at 0.97-1.00x on most days, 0.95x pooled; `deepseek-v4-pro` is
1.00x on the OpenCode-collector days (10-05..12) and 0.5-0.85x on the agent-gateway-opencode days (10-14..23), -$5 pooled, left open: the
portal's mix of peak and off-peak hours for pro is between the catalog schedule and the no-off-peak override the first fit tried (1.18x).

**Other models.** `gpt-5.6-terra` ties to the cent on every day but 10-16 (+2.83): the reasoning-free cutoff of 08:55Z
fits the portal to the cent only if it is moved to about 12:00Z (billed reasoning after 12:00Z on 10-16 is $2.80). Not changed: under $5, and
it would mean rewriting the stored token columns of that day. `glm-5.3` (portal 2.57 vs 0.87, one day, 5 audio-gateway rows),
`gemini-4-argon` (portal 0.41, 131 k tokens, one day: ~$3/M blended, no split possible), `gpt-6.1-sol` (0.85x, 3 days) are each under $5.

## Unpriced rows

`billing = 'api_key' AND cost_source = 'none'`, live: **10,904 rows before and after** (all personal key; the 1,631 of the plan is stale).
1,148 of them are marked mirror copies. Every model is explained; none gets a price because the portal total of all of them is
about $2 for the 30 days (under the $5 line) and most have no token counts to price.

| Category | Rows | With tokens | Tokens | Models | Why unpriced, evidence |
|-|-|-|-|-|-|
| ElevenLabs TTS | 5,368 | 0 | 0 | v3, flash-v2.5 | per character, the collectors store no tokens; portal bills them ($1.29 flash-v2.5 + $0.20 v3 over 30 days, 33 cells), too small to model |
| research-gateway tool calls | 2,052 | 0 | 0 | (model NULL) | search/fetch tool calls (tavily, wayback, lightpanda), no LLM tokens, no portal label |
| Transcription | 1,783 | 1,454 | 1.50 M | gpt-4o-transcribe(-diarize, -mini), gpt-transcribe, voxtral-mini-transcribe-3-0 and realtime, whisper | per audio minute; the tokens are text tokens only; no portal label for any of them on the personal key |
| Speech synthesis | 1,441 | 1,303 | 2.00 M | gemini-3.1-flash-tts-preview, gemini-3.8-flash(-lite)-tts, gpt-4o-mini-tts, tts-1 | audio tokens/characters not stored; portal: gemini-3.1-flash-tts-preview $0.02 for the whole window |
| Image tools | 16 | 4 | 5 k | recraft-remove-background, recraft-vectorize, remove-background, real-esrgan, birefnet, gpt-image-1.5 | per image |
| Local model | 52 | 52 | 4.60 M | gemma4-agent | free (hermes, 2026-04-14/16) |
| Placeholders, tests | 115 | 0 | 0 | `<synthetic>`, none, NULL, wrong-model-name, glm-5.3-flash-nonexistent | not calls |
| Unknown to the catalog | 77 | 65 | 3.96 M | hermes (21 rows, argo 2026-06..08, 3.34 M tokens: the model was never recorded), pplx-decider-v1-27b (4), decision-1 (2), gemini-4-argon (16, 10-26, 131 k tokens, portal $0.41 for the day), gemini-3.1-flash / gemini-3-flash (12), gpt-5.6 (20, image-gen, 94 k tokens), deepseek-v4p1-flash (2, Fireworks route) | no price to derive: one portal point per model at most, all under $1 |

No migration for this step; `make reprice` live moved only the DeepSeek rows (46,617, 0006). Agent-workflows rows (team key) have no unpriced rows:
the platform reports its own cost for TTS, transcription, images and tools ($1.9 of it, `gemini-3.8-flash-tts`, `voxtral`, `tavily-extract`,
`recraft-*`, `gpt-image-2.5-*`, is not a portal cell: services IU does not bill on that key, category C).

## Dedup

**Collectors vs agent-workflows: no overlap.** agent-workflows rows start 2026-10-27 23:20Z (4,541 rows, $71.87, 2,318 runs; team key
4,404 rows $70.04, personal 137 rows $1.83).

- Row level, every other `api_key` row of the same key within [ts - 10 s, ts + duration + 10 s] of an agw row: 2,142 candidate pairs, all
  with `athena-teamchat` (model NULL, so never the same model; 0 with equal tokens) and 4 with `agent-gateway-opencode` (same model,
  tokens differ, $0.007). With the same model and tokens within 5% inside +-60 s: **0 pairs**.
- Per model on the team key, 10-28..30: agent-workflows alone reaches the portal for every model it names: sonnet-5-5 16.95 vs 16.97, opus-5-5
  0.57 vs 0.57, gemini-3.8-flash 0.35 vs 0.35, pplx-decider 0.18 vs 0.18, haiku-5-5 21.15 vs 19.62 (+1.53, the `eu.anthropic` spelling),
  gpt-6.1-sol 3.78 vs 4.58, terra 2.58 vs 9.27. If athena-teamchat recorded any of those calls too, the sum would exceed the portal. The
  remainder (portal deepseek 57.65 + terra 6.69 + sol 0.80 = 65.1) is covered by athena-teamchat (61.8) and the agw `research-gateway`
  engine rows (9.33, a pseudo-model: the research engine's reported cost, no portal label) with +6 to spare, i.e. at most that much
  overlap, in the chat-turn cost figure rather than in rows.
- Personal key, 10-28..29: legacy review/research rows and agw rows are different calls (the legacy gateways ran their own steps until
  10-29 06:33Z); tracked/portal stays 0.84 and 0.93, no inflation. `agent-gateway-sessions` rows carry no tokens.
- The `research-gateway` rows inside agent-workflows (257 rows, $9.33) are the platform's accounting of the research engine; 170 of
  those runs also have separate step rows (deepseek, sonar: $0.02-0.05 each against $0.2-0.5 for the engine row), most have none. Kept.

**Found instead: the audio/image gateway family stores every call twice** (pre-dating agent-workflows). Two stores fed `usage.records`:
the collector read the gateway log (`audio-gateway` @ host label, `audio-gateway-vps`) and the gateway pushed to Argo
(`audio-gateway-mini`, `audio-gateway` @ `mini`/`vps`). Scan of all `api_key` pairs (same key and model, equal token counts, 10 s): only this
family, plus `image-gen-gateway`/`image-gateway` calls that two hops of the same chain logged.

| Copy marked (source, machine) | Rows | USD | of which 2026-10 |
|-|-|-|-|
| audio-gateway-mini, mini | 637 | 37.64 | 21.69 |
| audio-gateway-vps, vps | 1,563 | 23.96 | 0.06 |
| audio-gateway, Mac mini | 54 | 9.82 | 9.38 |
| image-gen-gateway, vps | 16 | 0.81 | 0 |
| image-gateway, vps | 8 | 0.11 | 0.11 |
| **Total** | **2,278** | **72.34** | **31.23** |

Evidence it is double counting rather than two calls: claude-opus-4-6 tracked exactly 2.00x the portal on 09-28 (13.94 vs 6.97) and 10-19
(13.03 vs 6.52); gemini-3.8-flash 1.94 / 1.99 / 2.01x on 09-28, 10-19, 10-24; opus-5-5 on 10-24 equals the portal to the cent once one copy
is dropped; the pairs differ only in how reasoning is split (871 output + 3,898 reasoning in the collector, 4,769 output in the push).
Rule, view and undo: `docs/usage-schema.md` "Duplicates". Migration 0007 shipped the rule and the first pass (1,965 rows), 0008
compared reasoning and cache writes as sums (+313).

## Shipped

| Migration | Applied live | What |
|-|-|-|
| `0006_drop_deepseek_overrides.sql` | yes, then `make reprice` live: 46,617 rows (v4-pro 11,792: 2,103.26 to 733.54; v4-flash 9,859: 303.33 to 99.41; v4.1-flash 24,966: 312.84 to 235.63) | the three DeepSeek supersede rows of 0005 deleted: the catalog schedule fits the portal (v4.1-flash 0.96x vs 1.39x with the 16:30-00:30 window, v4-pro 0.89x vs 1.18x) |
| `0007_gateway_duplicates.sql` | yes | `usage.record_duplicates`, view `usage.records_unique`, `usage.flag_gateway_duplicates()`, first pass 1,965 rows |
| `0008_gateway_duplicates_token_sums.sql` | yes | the rule compares output + reasoning and cache writes as sums, +313 rows |

`budget` and `stats` read `records_unique`. No row was deleted and no stored cost changed except the DeepSeek reprice.

## Open

1. Name the producer of the 10-22 Claude spend ($43): what ran on the personal IU key that day.
2. Collect or accept the 10-13/14 OpenCode hole ($20 of the personal key; not recoverable here).
3. Haiku 5.5 cache-write TTL ($11): needs the 5m/1h split from OpenCode, a collector change.
4. `deepseek-v4-pro` off-peak share ($5) and the terra cutoff (~12:00Z on 10-16, $2.8): small, left.
5. Readers of `usage.records` other than usage-tracker (the dashboard) must read `usage.records_unique` to match the portal.
6. Team key: the build-phase gap (-$9.7 to 10-26) stays unsourced, and athena-teamchat chat-turn cost runs ~$10 above the portal from 10-27.

## Appendix: `make budget` after the changes

```
IU cap [personal] — rolling 30 days 2026-10-01..2026-10-30 (portal fetched 2.1h ago)
rolling30        $595.30 of $500.00   OVER by $95.30
can spend today  -$95.29   (cap − the 29 days before today)
burn 7d          $16.82/day   rolling30 in 7 days at that burn: $647.73

drop-off, next 7 days (a day leaves the window tomorrow, the day after, …)
day             frees   headroom
2026-10-01     $17.72    -$77.58
2026-10-02      $3.54    -$74.04
2026-10-03      $0.04    -$74.00
2026-10-04      $4.07    -$69.93
2026-10-05     $12.11    -$57.82
2026-10-06      $9.37    -$48.45
2026-10-07     $18.45    -$30.00

per day: portal vs tracked (billing=api_key); delta = tracked − portal, flag |delta| > max($1, 20% of portal)
                portal    tracked      delta  ratio
2026-10-01      $17.72     $16.78     -$0.94  0.95x
2026-10-02       $3.54      $2.66     -$0.88  0.75x
2026-10-03       $0.04      $0.04     -$0.00  0.90x
2026-10-04       $4.07      $4.04     -$0.03  0.99x
2026-10-05      $12.11     $11.01     -$1.10  0.91x
2026-10-06       $9.37      $9.03     -$0.34  0.96x
2026-10-07      $18.45     $19.16      $0.71  1.04x
2026-10-08      $10.57      $8.66     -$1.91  0.82x
2026-10-09      $12.32     $12.02     -$0.30  0.98x
2026-10-10      $15.35     $15.60      $0.25  1.02x
2026-10-11       $7.44      $7.51      $0.07  1.01x
2026-10-12       $4.64      $4.61     -$0.03  0.99x
2026-10-13      $21.50     $15.83     -$5.67  0.74x  <-- off
2026-10-14      $42.72     $27.93    -$14.79  0.65x  <-- off
2026-10-15      $28.70     $27.63     -$1.07  0.96x
2026-10-16      $41.06     $41.45      $0.39  1.01x
2026-10-17      $38.90     $33.77     -$5.13  0.87x
2026-10-18      $40.77     $38.97     -$1.80  0.96x
2026-10-19      $43.12     $40.93     -$2.19  0.95x
2026-10-20       $5.75      $5.47     -$0.28  0.95x
2026-10-21      $10.08      $9.38     -$0.70  0.93x
2026-10-22      $71.44     $28.36    -$43.08  0.40x  <-- off
2026-10-23      $17.91     $16.40     -$1.51  0.92x
2026-10-24      $18.58     $18.15     -$0.43  0.98x
2026-10-25      $26.87     $22.54     -$4.33  0.84x
2026-10-26      $46.38     $40.87     -$5.51  0.88x
2026-10-27      $13.78     $12.43     -$1.35  0.90x
2026-10-28       $8.72      $7.37     -$1.35  0.84x
2026-10-29       $3.39      $3.16     -$0.23  0.93x
2026-10-30       $0.01      $0.01      $0.00  1.17x

per model, window total (top 15)
                                         portal    tracked      delta  ratio
deepseek-v4.1-flash                     $266.59    $238.67    -$27.92  0.90x
claude-haiku-5-5                         $84.85     $72.70    -$12.15  0.86x
gpt-5.6-terra                            $77.11     $79.84      $2.73  1.04x
claude-opus-5-5                          $61.67     $29.26    -$32.41  0.47x  <-- off
claude-haiku-4-5                         $34.06     $35.94      $1.88  1.06x
deepseek-v4-pro                          $24.55     $16.66     -$7.89  0.68x  <-- off
gpt-6.1-sol                              $10.05      $8.54     -$1.51  0.85x
claude-sonnet-5                           $6.95      $1.28     -$5.67  0.18x  <-- off
claude-opus-4-6                           $6.77      $6.52     -$0.25  0.96x
claude-sonnet-5-5                         $6.53      $1.63     -$4.90  0.25x  <-- off
gpt-6-luna                                $3.57      $2.38     -$1.19  0.67x  <-- off
gemini-3.8-flash                          $3.29      $2.69     -$0.60  0.82x
glm-5.3                                   $2.57      $0.87     -$1.70  0.34x  <-- off
kimi-k3                                   $1.86      $1.85     -$0.01  1.00x
deepseek-v4-flash                         $0.89      $1.02      $0.13  1.15x

portal spend we do not track (other tools, missing collector, IU-side calls)
  flash-v2.5                                $0.83
  claude-fable-5-1                          $0.78
  gemini-4-argon                            $0.47
  gpt-6-astra                               $0.37
  Claude Sonnet 5 5 Eu                      $0.11
  gpt-5.6-luna                              $0.10
  v3                                        $0.08
  Gpt 6.1 Terra                             $0.08
  Text Embedding 3 Large                    $0.04
  Clef Flash                                $0.03
  gemini-3.1-flash-tts-preview              $0.02
  Jev Latest                                $0.02
  Gemini 2.5 Pro                            $0.01
  Gpt 5 Search Api                          $0.01
  Gemini 2.5 Pro Eu                         $0.01
  Gemini 3.5 Flash Eu                       $0.01
  Gemini 4 Argon Eu                         $0.01
  Text Embedding Ada 002                    $0.01

tracked spend the portal does not bill (our rate card prices something IU does not charge)
  grok-4.7                                  $0.70
  gpt-image-2.5-flare                       $0.28
  decision-1                                $0.10
  gpt-image-2.5-sunburst                    $0.05

monthly reconciliation (portal monthly total vs sum of stored daily cells)
  2026-08  portal $199.65  daily cells $0.00
  2026-09  portal $504.09  daily cells $48.00
  2026-10  portal $596.46  daily cells $595.30

IU cap [athena-team] — rolling 30 days 2026-10-01..2026-10-30 (portal fetched 2.1h ago)
rolling30        $154.42 of $500.00   headroom $345.58
can spend today  $354.61   (cap − the 29 days before today)
burn 7d          $21.32/day   rolling30 in 7 days at that burn: $303.69

drop-off, next 7 days (a day leaves the window tomorrow, the day after, …)
day             frees   headroom
2026-10-01      $0.00    $345.58
2026-10-02      $0.00    $345.58
2026-10-03      $0.00    $345.58
2026-10-04      $0.00    $345.58
2026-10-05      $0.00    $345.58
2026-10-06      $0.00    $345.58
2026-10-07      $0.00    $345.58

per day: portal vs tracked (billing=api_key); delta = tracked − portal, flag |delta| > max($1, 20% of portal)
                portal    tracked      delta  ratio
2026-10-01       $0.00      $0.00      $0.00      -
2026-10-02       $0.00      $0.00      $0.00      -
2026-10-03       $0.00      $0.00      $0.00      -
2026-10-04       $0.00      $0.00      $0.00      -
2026-10-05       $0.00      $0.00      $0.00      -
2026-10-06       $0.00      $0.00      $0.00      -
2026-10-07       $0.00      $0.00      $0.00      -
2026-10-08       $0.00      $0.00      $0.00      -
2026-10-09       $0.00      $0.00      $0.00      -
2026-10-10       $0.00      $0.00      $0.00      -
2026-10-11       $0.00      $0.00      $0.00      -
2026-10-12       $0.00      $0.00      $0.00      -
2026-10-13       $0.00      $0.00      $0.00      -
2026-10-14       $0.00      $0.00      $0.00      -
2026-10-15       $0.00      $0.00      $0.00      -
2026-10-16       $0.00      $0.00      $0.00      -
2026-10-17       $0.00      $0.00      $0.00      -
2026-10-18       $0.00      $0.00      $0.00      -
2026-10-19       $0.00      $0.00      $0.00      -
2026-10-20       $0.00      $0.00      $0.00      -
2026-10-21       $0.00      $0.00      $0.00      -
2026-10-22       $0.29      $0.08     -$0.21  0.28x
2026-10-23       $4.86      $4.00     -$0.86  0.82x
2026-10-24       $5.76      $4.39     -$1.37  0.76x  <-- off
2026-10-25      $12.57      $7.13     -$5.44  0.57x  <-- off
2026-10-26       $4.97      $3.19     -$1.78  0.64x  <-- off
2026-10-27       $3.15      $4.08      $0.93  1.29x
2026-10-28      $48.82     $54.47      $5.65  1.12x
2026-10-29      $64.97     $67.20      $2.23  1.03x
2026-10-30       $9.03     $10.39      $1.36  1.15x

per model, window total (top 15)
                                         portal    tracked      delta  ratio
deepseek-v4.1-flash                     $102.77     $13.59    -$89.18  0.13x  <-- off
?                                         $0.00     $84.70     $84.70      -  <-- off
claude-haiku-5-5                         $19.62     $20.72      $1.10  1.06x
Claude Sonnet 5 5 Eu                     $16.97      $0.00    -$16.97  0.00x  <-- off
claude-sonnet-5-5                         $0.00     $16.95     $16.95      -  <-- off
research-gateway                          $0.00      $9.33      $9.33      -  <-- off
Gpt 6.1 Terra                             $9.27      $0.00     -$9.27  0.00x  <-- off
gpt-6.1-sol                               $4.58      $3.78     -$0.80  0.82x
openai.gpt-6.1-terra                      $0.00      $2.58      $2.58      -  <-- off
claude-opus-5-5                           $0.57      $0.57     -$0.00  1.00x
gemini-3.8-flash-tts                      $0.00      $0.57      $0.57      -
eu.anthropic.claude-haiku-5-5             $0.00      $0.43      $0.43      -
voxtral-mini-transcribe-3-0               $0.00      $0.36      $0.36      -
gemini-3.8-flash                          $0.35      $0.35     -$0.00  0.99x
tavily-extract                            $0.00      $0.30      $0.30      -

portal spend we do not track (other tools, missing collector, IU-side calls)
  Claude Sonnet 5 5 Eu                     $16.97
  Gpt 6.1 Terra                             $9.27
  gemini-3.5-flash                          $0.05

tracked spend the portal does not bill (our rate card prices something IU does not charge)
  ?                                        $84.70
  claude-sonnet-5-5                        $16.95
  research-gateway                          $9.33
  openai.gpt-6.1-terra                      $2.58
  gemini-3.8-flash-tts                      $0.57
  eu.anthropic.claude-haiku-5-5             $0.43
  voxtral-mini-transcribe-3-0               $0.36
  tavily-extract                            $0.30
  gpt-image-2.5-flare                       $0.20
  gemini-3.8-flash-lite-tts                 $0.08
  recraft-remove-background                 $0.07
  gpt-image-2.5-sunburst                    $0.04
  recraft-vectorize                         $0.01
  flash-v2.5                                $0.00
  microsoft-decision-1                      $0.00
  gpt-6-luna                                $0.00
```
