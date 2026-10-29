# Reconciliation — legacy gateway collectors ↔ agent-workflows

Run 2026-10-29 ~14:30Z, read-only. Method of Argo's `docs/usage-reconciliation.md`: Argo `POST /query`
(SELECT on `argo.usage_record`) against usage-tracker's local SQLite (`sqlite3 -readonly`), by UTC day,
window 2026-10-22 … 2026-10-29. No `ingest` or `sync` ran. Tokens = input + output + cache read + cache
write + reasoning. No row content was read: only `source`, `sub_tool`, `machine`, timestamps, counts, cost
and the key names of `raw`.

**Window.** `agent-workflows` rows start 2026-10-27 23:20Z (4 verify rows); real traffic from
2026-10-28 08:49Z. The overlap with legacy review is ~21 h (10-28 08:49Z … 10-29 06:33Z). Research has no
concurrent overlap: legacy research went silent 10-28 15:30Z, platform research starts 10-28 23:50Z.

## Sources and where they are written

| Source | Collector | Local | Argo |
|-|-|-|-|
| `agent-workflows` | none (the platform posts to Argo itself) | 0 rows | 3,821 rows, $47.05 |
| `agent-gateway-opencode` | `agent-gateway-opencode.ts` | 48,186 | 48,186 |
| `agent-gateway-iu` | `agent-gateway-iu.ts` | 7,925 | 7,931 |
| `research-gateway` | `research-gateway.ts` | 2,912 | 6,500 |
| `agent-gateway-sessions` | `agent-gateway-sessions.ts` (out of scope) | 17,569 | 17,569 |

## Per day × source (rows / tokens / cost USD; local = Argo on every legacy day)

| Source | Day | Rows | Tokens | Cost |
|-|-|-|-|-|
| agent-gateway-opencode | 10-22 | 3048 | 124499807 | 5.70 |
| agent-gateway-opencode | 10-23 | 1742 | 76773717 | 3.27 |
| agent-gateway-opencode | 10-24 | 1726 | 74649727 | 3.39 |
| agent-gateway-opencode | 10-25 | 1650 | 82088769 | 3.13 |
| agent-gateway-opencode | 10-26 | 1883 | 86546608 | 3.39 |
| agent-gateway-opencode | 10-27 | 3434 | 152952244 | 6.48 |
| agent-gateway-opencode | 10-28 | 1321 | 59420648 | 2.74 |
| agent-gateway-opencode | 10-29 | 185 | 11026528 | 0.52 |
| agent-gateway-iu | 10-22 | 281 | 200376524 | 17.32 |
| agent-gateway-iu | 10-23 | 209 | 194064175 | 10.96 |
| agent-gateway-iu | 10-24 | 181 | 181276123 | 11.14 |
| agent-gateway-iu | 10-25 | 128 | 238072074 | 12.09 |
| agent-gateway-iu | 10-26 | 159 | 121206815 | 8.96 |
| agent-gateway-iu | 10-27 | 243 | 11330120 | 4.66 |
| agent-gateway-iu | 10-28 | 128 | 5952607 | 3.90 |
| agent-gateway-iu | 10-29 | 29 | 980122 | 0.99 |
| research-gateway | 10-22 | 273 | 45403209 | 5.90 |
| research-gateway | 10-23 | 81 | 46380111 | 4.10 |
| research-gateway | 10-24 | 77 | 39624679 | 2.50 |
| research-gateway | 10-25 | 106 | 46515839 | 3.03 |
| research-gateway | 10-26 | 337 | 72181400 | 6.93 |
| research-gateway | 10-27 | 52 | 15197216 | 1.17 |
| research-gateway | 10-28 | 30 | 2459615 | 0.19 |
| agent-gateway-sessions | 10-22 … 10-29 | 667, 350, 387, 273, 310, 718, 465, 50 | 0 | 0.00 |
| agent-workflows (Argo only) | 10-27 | 4 | 580 | — |
| agent-workflows (Argo only) | 10-28 | 1226 | 146619182 | 22.90 |
| agent-workflows (Argo only) | 10-29 | 2591 | 102333195 | 24.14 |

`research-gateway` has no row on 10-29. `agent-workflows` is absent locally by design (concept N6).

## (a) What still writes

| Source | Last row | Verdict |
|-|-|-|
| `research-gateway` | 2026-10-28 15:30Z (jsonl mtime agrees) | **silent ~23 h**; its MCP was deleted 10-29 |
| `agent-gateway-opencode` | 2026-10-29 06:33Z | `review:*` silent since the refusal; **narrative (05:46Z) and excalidraw-diagram (05:11Z) still wrote today**, `dispatch` last 10-27 15:07Z, `check` 10-27 18:08Z |
| `agent-gateway-iu` | 2026-10-29 11:40Z | **live today**: `triage` 11:40Z, `narrative` 05:47Z; `review:adversary`/`review:router` silent since 06:33Z, `prose` since 10-28 16:22Z, `decide` since 10-27 21:11Z |

The OpenCode store holds nothing newer than the last ingested message (store max 06:33:39Z), so nothing
is waiting to be read. `sub_tool` kinds seen since 10-27: opencode — `review:angle` (4,278 rows),
`review:synthesis` (538), `dispatch` (94), `narrative` (16), `excalidraw-diagram` (12), `check` (2); iu —
`review:adversary` (180), `review:router` (146), `triage` (26), `narrative` (23), `decide` (15), `prose`
(10); research-gateway — `lead`, `worker`, `sonar`, `lightpanda`, `tavily`, `tavily-account`, `wayback`.

## (b) Did the legacy volume move to `agent-workflows`?

Argo, rows / cost USD (legacy review = `review:*` rows of both agent-gateway sources):

| Workflow | Day | Legacy rows | Legacy cost | agent-workflows rows | agent-workflows cost |
|-|-|-|-|-|-|
| review | 10-26 | 1918 | 11.12 | 0 | — |
| review | 10-27 | 3530 | 10.34 | 0 | — |
| review | 10-28 | 1433 | 5.31 | 1131 | 22.60 |
| review | 10-29 | 179 | 0.86 | 304 | 4.17 |
| research | 10-26 | 337 | 6.93 | 0 | — |
| research | 10-27 | 52 | 1.17 | 0 | — |
| research | 10-28 | 30 | 0.19 | 26 | 0.29 |
| research | 10-29 | 0 | — | 841 | 13.71 |
| check | 10-27 | 2 | 0.01 | 0 | — |
| check | 10-28 | 0 | — | 1 | 0.00 |

- **Review** moved: legacy `review:*` rows stop 10-29 06:33Z; `agent-workflows` review rows start 10-28
  08:49Z and run hourly through 10-29 14:23Z. Row counts are not comparable (the platform's row grain
  differs and was not audited here); cost is: legacy ≈ $10–11/day on 10-26/27, 10-28 combined ≈ $27.9.
- **Research** moved: `agent-workflows` research from 10-28 23:50Z, legacy silent since 15:30Z. Platform research cost on 10-29
  ($13.71, 841 rows) is far above legacy's ≤ $7/day; the cause was not investigated here.
- **Check** barely overlaps: 2 legacy rows (10-27), 1 platform row (10-28).
- Others on the platform with no legacy twin in these collectors: `podcast`, `image`, `otel`, `prose`,
  `diagram`, `brain`, `door.*`, `cap.*`. The platform's `diagram` starts 10-29 05:02Z and the legacy
  `excalidraw-diagram` ends 05:11Z: a ~9-minute cutover overlap.
- Not moved: `narrative` (opencode + iu rows today, no platform `narrative` row), `triage` (11:40Z today in
  agent-gateway-iu; the platform has `cap.triage` since 12:15Z, a different caller path), `dispatch`
  (agent-gateway until P6).

## (c) Would removing each collector lose a row not otherwise in Argo?

| Collector | Local rows missing from Argo | Argo rows missing locally | Unsynced local rows | Removing it loses |
|-|-|-|-|-|
| `research-gateway` | 0 | 3,588: VPS instance 3,470 (2026-06-17 … 09-25 07:22Z, posted to Argo directly), pre-rename mini rows 118 (09-23 … 09-25) | 0 | **nothing**: all 2,912 local rows are in Argo |
| `agent-gateway-iu` | 0 | 6 (MacBook, 2026-06-11 … 06-29) | — | live source: stays |
| `agent-gateway-opencode` | 0 | 0 | — | live source: stays |

The jsonl log `research-gateway.jsonl` (the file the collector reads) stays on disk, untouched.

## Decision

- **Remove `research-gateway`**: silent since 10-28 15:30Z, MCP deleted, VPS instance silent since
  09-25, replaced by `agent-workflows` research, and Argo already holds every local row.
- **Keep `agent-gateway-opencode`**: `review:*` is gone but `narrative` and `excalidraw-diagram` still wrote
  today and `dispatch` runs until P6. Revisit after P6.
- **Keep `agent-gateway-iu`**: `triage` and `narrative` wrote today (11:40Z, 05:47Z).
- **Keep `agent-gateway-sessions`**: out of scope; it feeds the lane attribution in `models.ts` / `litellm.ts`.
- Rows already in Argo and in the local DB are never deleted. Removing the collector only stops new reads;
  the existing `collector_state` row and `usage_record` history stay.
