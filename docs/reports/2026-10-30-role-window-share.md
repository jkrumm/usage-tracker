# Window share per spawn, by factory role and effort (FL4 measurement)

**Verdict:** a spawn costs a median of 0.03–1.5 points of the 7-day window and a p90 of 0.2–7.7 (Haiku sessions aside, which are 0), depending
mostly on lane and model; the factory role cannot be measured yet, because only 6 sessions carry one (`FACTORY_ROLE` reaches `usage` from
2026-10-30). Wave 1 made the role visible; this report uses the lane it maps to (`wave_mother` = mother/wave, `worker` =
worker/mechanical, `fan_worker`) as the stand-in and must be re-run after a few days of factory runs. It replaces the
never-measured per-spawn estimate the factory once had.

Data: 2026-10-24 (first quota reading) to 2026-10-30 18:30Z, Max accounts `iu`, `me`, `me2`, `claude-code` sessions. A *spawn* is
a root session (no parent) and its subagent sessions, summed. Share is in **points of the account's window** (1.0 = 1 % of
its 5 h or 7 d window), from `usage.session_window_share` (`docs/usage-schema.md` §Window share). Subagents count toward the
session that spawned them; workers spawned by a mother are sessions of their own and are not in the mother's row.
Only spawns that began after their account's first quota reading and ended at least 30 minutes before its last one are counted (a spawn
partly outside the observed period would show its missing share as 0); the 6 sessions that carry a role are all too recent for that
and fall out. Rows with fewer than 5 spawns are left out.

| Lane | Effort | Model | Spawns | 7d mean | 7d median | 7d p90 | 5h median | 5h p90 |
|-|-|-|-|-|-|-|-|-|
| wave_mother | medium | opus-5-5 | 16 | 3.24 | 1.47 | 7.66 | 8.85 | 47.66 |
| wave_mother | high | opus-5-5 | 43 | 2.16 | 1.18 | 5.67 | 9.30 | 26.13 |
| wave_mother | high | sonnet-5-5 | 45 | 1.10 | 0.36 | 2.28 | 2.00 | 14.87 |
| wave_mother | medium | sonnet-5-5 | 45 | 0.66 | 0.16 | 2.24 | 1.41 | 13.50 |
| fan_worker | medium | opus-5-5 | 18 | 0.90 | 0.70 | 1.65 | 4.79 | 12.51 |
| fan_worker | high | sonnet-5-5 | 153 | 0.20 | 0.11 | 0.43 | 0.67 | 2.90 |
| fan_worker | medium | sonnet-5-5 | 6 | 0.26 | 0.14 | 0.56 | 1.11 | 2.84 |
| worker | medium | sonnet-5-5 | 6 | 0.12 | 0.05 | 0.31 | 0.27 | 2.41 |
| interactive | high | opus-5-5 | 14 | 1.48 | 1.46 | 3.00 | 6.13 | 18.84 |
| interactive | medium | opus-5-5 | 32 | 0.96 | 0.38 | 2.89 | 1.85 | 19.58 |
| interactive | high | sonnet-5-5 | 23 | 0.09 | 0.03 | 0.17 | 0.16 | 0.61 |
| interactive | high + medium | haiku-5-5 | 222 | 0.00 | 0.00 | 0.01 | 0.00 | 0.01 |
| agw_workflow | high | sonnet-5 | 182 | 0.07 | 0.05 | 0.17 | 0.40 | 1.02 |

## What it says

- **Model beats effort.** Within a lane, Opus costs 2–5× a Sonnet spawn (mean) (fan_worker: 0.90 vs 0.20–0.26; wave_mother:
  2.16–3.24 vs 0.66–1.10). Effort cannot be separated from the model in this data: Sonnet runs at `high` and Opus at
  `medium` by default (`config/claude-effort.json`), and the only cell with both is small (fan_worker sonnet, 6 at
  `medium` against 153 at `high`: 0.26 vs 0.20, no difference this sample can resolve).
- **A mother is the expensive spawn**: its median is 0.16–1.47 points of the 7-day window and its p90 2.2–7.7, three to five times a
  fan worker's p90 on the same model. Its 5 h p90 is 13.5–47.7 points: one in ten mothers burns 14 to 48 % of a 5 h window.
- **Haiku interactive sessions are free in window terms** (222 sessions, mean 0.00).
- **The `wave` role has no signal yet**: 6 sessions, all started after the last quota readings the cohort allows.

## How far to trust it

- **Means over medians.** The 7-day meter moves in whole points, so a tick lands in one 15-minute interval and the sessions
  that ran in the other intervals get 0. A median at 0.0x is quantisation, the mean is unbiased. The 5 h window ticks more
  often and is the smoother cross-check; the two rank the cells identically.
- **Residual.** Over the last 7 days the window moved 2,360 5 h points and 377 7 d points across the three accounts; 1.1 % and
  2.7 % of those fell in intervals with no priced Max record (per account up to 2.1 % 5 h, 5.8 % 7 d). Those points are in no
  session's share.
- **Points are not comparable across plans.** `iu` is `max20x`; a point of its window is several times the dollars of a point
  of `me` / `me2` (about $4.5–5 per 5 h point against $1.3–1.4, over 7 days). A row mixing accounts adds points of different
  windows. Re-cut per account before turning a share into a tier decision.

## Reproduce

`make window BY=lane` for the lane totals. The table is:

```sql
WITH bounds AS (
  SELECT account, min(sampled_at) AS lo, max(sampled_at) AS hi FROM usage.quota_samples GROUP BY 1
), tree AS (
  SELECT coalesce(s.parent_session_id, s.id) AS root, s.account, min(s.first_ts) AS f, max(s.last_ts) AS l,
         sum(w.seven_day_pct) AS d7, sum(w.five_hour_pct) AS h5
  FROM usage.sessions s LEFT JOIN usage.session_window_share w ON w.session_id = s.id
  WHERE s.billing = 'max' AND s.source = 'claude-code'
  GROUP BY 1, 2
), spawn AS (
  SELECT r.lane, coalesce(r.lane_detail->>'role', '(none)') AS role, coalesce(r.effort, '(none)') AS effort, r.model,
         coalesce(t.d7, 0) AS d7, coalesce(t.h5, 0) AS h5
  FROM tree t JOIN usage.sessions r ON r.id = t.root JOIN bounds b ON b.account = t.account
  WHERE r.lane <> 'subagent' AND t.f >= b.lo AND t.l <= b.hi - interval '30 minutes'
)
SELECT lane, role, effort, model, count(*) AS n, avg(d7) AS mean7,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY d7) AS p50_7, percentile_cont(0.9) WITHIN GROUP (ORDER BY d7) AS p90_7,
       avg(h5) AS mean5, percentile_cont(0.5) WITHIN GROUP (ORDER BY h5) AS p50_5, percentile_cont(0.9) WITHIN GROUP (ORDER BY h5) AS p90_5
FROM spawn GROUP BY 1, 2, 3, 4 HAVING count(*) >= 5 ORDER BY lane, effort, model;
-- (the Haiku row adds its `high` and `medium` cells, 16 + 206)
```

Re-run it with `GROUP BY role` once `stats --by role` shows a week of factory runs; the program lead takes the role-table
decision (FL4) from that run, not from this one.
