# Backfill proof: `argo.usage_record` + SQLite archive to `usage.records`

Argo snapshot taken 2026-10-30T12:23:27.422Z (one repeatable-read transaction, read-only over ssh), SQLite archive read-only (849,223 rows), written by `scripts/backfill-argo.ts` into schema `usage` of database `shared`. Every number below comes from that run; the script is idempotent and re-runnable (`make backfill-argo`).

## Result

|  | rows | cost USD |
|-|-|-|
| Argo table (snapshot) | 871,402 | 69111.84 |
| SQLite archive | 849,223 | 67682.47 |
| `usage.records` after the backfill | 871,861 | 62272.80 |

Buckets that do not close: **0** of 74 (a bucket closes when rows and all five token kinds match exactly and the cost matches to the cent). Records in the database for keys outside the backfilled set (added by the live pipeline since the snapshot, counted in the closure): 461. Records missing after the write: 0. Token differences on matched keys: none.

## Where the difference comes from

Argo total, minus what the new key collapses, plus what only SQLite holds, plus the store swap and the repricing, is the backfilled total:

| step | rows | USD |
|-|-|-|
| Argo table | 871,402 | 69111.84 |
| (i) duplicates collapsed by the key `(source, source_id)` | -2 | +0.00 |
| rows not backfilled (unparseable ts or unknown grain) | -0 | +0.00 |
| rows added to the database by the live pipeline since the snapshot (outside the set) | +461 | +21.44 |
| (ii) rows only SQLite holds | +0 | +0.00 |
| store swap: SQLite's exact cost instead of Argo's float4 | 0 | -0.000003 |
| (iii) rate tables re-derive the cost (priced both ways, no 1h cache write) | 457,739 | -4141.20 |
| (iv) the same, rows with 1h cache writes | 335,306 | -2570.38 |
| (v) lost a price (old cost, now NULL) | 4,217 | -69.65 |
| (v) newly priced (old NULL) | 636 | +7.16 |
| (v) unpriced before and after | 7,422 | +0.00 |
| provider-reported cost kept verbatim | 65,239 | +0.000000 |
| reported cost ignored (`IGNORE_REPORTED_COST`) | 841 | -86.42 |
| **`usage.records`** | 871,861 | 62272.80 |

Closure check: Argo 69111.84 -6839.05 = 62272.80 (explained sum 62272.80).

## Per source

| source | Argo rows | dup rows | SQLite-only | live-added rows | database rows | Argo $ | dup $ | SQLite-only $ | swap $ | repricing $ | live-added $ | database $ | diff (cents) |
|-|-|-|-|-|-|-|-|-|-|-|-|-|-|
| agent-gateway-iu | 7,931 | 0 | 0 | 0 | 7,931 | 331.77 | 0.00 | 0.00 | +0.000001 | -61.06 | 0.00 | 270.71 | 0 |
| agent-gateway-opencode | 48,186 | 0 | 0 | 0 | 48,186 | 86.24 | 0.00 | 0.00 | +0.000000 | +0.00 | 0.00 | 86.24 | 0 |
| agent-gateway-sessions | 17,569 | 0 | 0 | 0 | 17,569 | 0.00 | 0.00 | 0.00 | +0.000000 | +0.00 | 0.00 | 0.00 | 0 |
| agent-workflows | 4,533 | 0 | 0 | 0 | 4,533 | 75.53 | 0.00 | 0.00 | +0.000000 | -3.67 | 0.00 | 71.86 | 0 |
| argo | 184 | 0 | 0 | 0 | 184 | 0.01 | 0.00 | 0.00 | +0.000000 | +0.35 | 0.00 | 0.36 | 0 |
| astra | 14 | 0 | 0 | 0 | 14 | 3.86 | 0.00 | 0.00 | +0.000000 | +0.00 | 0.00 | 3.86 | 0 |
| astroclaw | 1 | 0 | 0 | 0 | 1 | 0.00 | 0.00 | 0.00 | +0.000000 | -0.00 | 0.00 | 0.00 | 0 |
| athena-teamchat | 6,714 | 0 | 0 | 5 | 6,719 | 84.69 | 0.00 | 0.00 | +0.000000 | +0.00 | 0.01 | 84.70 | 0 |
| audio-gateway | 6,423 | 0 | 0 | 0 | 6,423 | 135.33 | 0.00 | 0.00 | +0.000000 | -41.69 | 0.00 | 93.64 | 0 |
| audio-gateway-mini | 1,349 | 0 | 0 | 0 | 1,349 | 59.01 | 0.00 | 0.00 | +0.000000 | -20.74 | 0.00 | 38.27 | 0 |
| audio-gateway-vps | 3,661 | 0 | 0 | 0 | 3,661 | 23.93 | 0.00 | 0.00 | -0.000000 | +0.23 | 0.00 | 24.16 | 0 |
| audio-proxy | 389 | 0 | 0 | 0 | 389 | 6.26 | 0.00 | 0.00 | -0.000000 | -6.08 | 0.00 | 0.18 | 0 |
| claude-code | 727,912 | 0 | 0 | 454 | 728,366 | 65034.66 | 0.00 | 0.00 | -0.000005 | -5410.30 | 21.43 | 59645.79 | 0 |
| codex | 481 | 0 | 0 | 0 | 481 | 90.95 | 0.00 | 0.00 | +0.000000 | -0.00 | 0.00 | 90.95 | 0 |
| email-gateway | 105 | 0 | 0 | 0 | 105 | 0.01 | 0.00 | 0.00 | +0.000000 | +0.00 | 0.00 | 0.01 | 0 |
| feuer | 4,621 | 0 | 0 | 0 | 4,621 | 2332.90 | 0.00 | 0.00 | +0.000001 | -1134.42 | 0.00 | 1198.48 | 0 |
| hermes | 5,259 | 0 | 0 | 2 | 5,261 | 247.21 | 0.00 | 0.00 | +0.000000 | -31.41 | 0.00 | 215.79 | 0 |
| image-gateway | 47 | 0 | 0 | 0 | 47 | 0.44 | 0.00 | 0.00 | +0.000000 | -0.44 | 0.00 | 0.00 | 0 |
| image-gen-gateway | 68 | 0 | 0 | 0 | 68 | 1.77 | 0.00 | 0.00 | +0.000000 | -1.77 | 0.00 | 0.00 | 0 |
| litellm | 6,932 | 0 | 0 | 0 | 6,932 | 234.50 | 0.00 | 0.00 | +0.000000 | -115.54 | 0.00 | 118.96 | 0 |
| modelpick | 472 | 0 | 0 | 0 | 472 | 43.77 | 0.00 | 0.00 | +0.000000 | -1.92 | 0.00 | 41.85 | 0 |
| opencode | 22,051 | 0 | 0 | 0 | 22,051 | 64.71 | 0.00 | 0.00 | -0.000000 | -19.80 | 0.00 | 44.91 | 0 |
| research-gateway | 6,500 | 2 | 0 | 0 | 6,498 | 254.30 | 0.00 | 0.00 | +0.000000 | -12.23 | 0.00 | 242.07 | 0 |

## Per source and month (UTC)

| source | month | Argo rows | dup | SQLite-only | live-added | database rows | Argo $ | dup $ | SQLite-only $ | repricing $ | live-added $ | database $ | diff (cents) |
|-|-|-|-|-|-|-|-|-|-|-|-|-|-|
| agent-gateway-iu | 2026-05 | 5 | 0 | 0 | 0 | 5 | 0.03 | 0.00 | 0.00 | -0.01 | 0.00 | 0.02 | 0 |
| agent-gateway-iu | 2026-06 | 24 | 0 | 0 | 0 | 24 | 1.13 | 0.00 | 0.00 | +0.00 | 0.00 | 1.13 | 0 |
| agent-gateway-iu | 2026-07 | 71 | 0 | 0 | 0 | 71 | 2.12 | 0.00 | 0.00 | +0.31 | 0.00 | 2.43 | 0 |
| agent-gateway-iu | 2026-08 | 81 | 0 | 0 | 0 | 81 | 5.11 | 0.00 | 0.00 | +0.00 | 0.00 | 5.11 | 0 |
| agent-gateway-iu | 2026-09 | 432 | 0 | 0 | 0 | 432 | 37.31 | 0.00 | 0.00 | -7.38 | 0.00 | 29.93 | 0 |
| agent-gateway-iu | 2026-10 | 7,318 | 0 | 0 | 0 | 7,318 | 286.06 | 0.00 | 0.00 | -53.98 | 0.00 | 232.08 | 0 |
| agent-gateway-opencode | 2026-10 | 48,186 | 0 | 0 | 0 | 48,186 | 86.24 | 0.00 | 0.00 | +0.00 | 0.00 | 86.24 | 0 |
| agent-gateway-sessions | 2026-05 | 19 | 0 | 0 | 0 | 19 | 0.00 | 0.00 | 0.00 | +0.00 | 0.00 | 0.00 | 0 |
| agent-gateway-sessions | 2026-06 | 247 | 0 | 0 | 0 | 247 | 0.00 | 0.00 | 0.00 | +0.00 | 0.00 | 0.00 | 0 |
| agent-gateway-sessions | 2026-07 | 476 | 0 | 0 | 0 | 476 | 0.00 | 0.00 | 0.00 | +0.00 | 0.00 | 0.00 | 0 |
| agent-gateway-sessions | 2026-08 | 687 | 0 | 0 | 0 | 687 | 0.00 | 0.00 | 0.00 | +0.00 | 0.00 | 0.00 | 0 |
| agent-gateway-sessions | 2026-09 | 3,019 | 0 | 0 | 0 | 3,019 | 0.00 | 0.00 | 0.00 | +0.00 | 0.00 | 0.00 | 0 |
| agent-gateway-sessions | 2026-10 | 13,121 | 0 | 0 | 0 | 13,121 | 0.00 | 0.00 | 0.00 | +0.00 | 0.00 | 0.00 | 0 |
| agent-workflows | 2026-10 | 4,533 | 0 | 0 | 0 | 4,533 | 75.53 | 0.00 | 0.00 | -3.67 | 0.00 | 71.86 | 0 |
| argo | 2026-06 | 16 | 0 | 0 | 0 | 16 | 0.00 | 0.00 | 0.00 | +0.00 | 0.00 | 0.00 | 0 |
| argo | 2026-08 | 82 | 0 | 0 | 0 | 82 | 0.01 | 0.00 | 0.00 | +0.29 | 0.00 | 0.30 | 0 |
| argo | 2026-09 | 15 | 0 | 0 | 0 | 15 | 0.00 | 0.00 | 0.00 | +0.01 | 0.00 | 0.01 | 0 |
| argo | 2026-10 | 71 | 0 | 0 | 0 | 71 | 0.01 | 0.00 | 0.00 | +0.04 | 0.00 | 0.05 | 0 |
| astra | 2026-09 | 14 | 0 | 0 | 0 | 14 | 3.86 | 0.00 | 0.00 | +0.00 | 0.00 | 3.86 | 0 |
| astroclaw | 2026-09 | 1 | 0 | 0 | 0 | 1 | 0.00 | 0.00 | 0.00 | -0.00 | 0.00 | 0.00 | 0 |
| athena-teamchat | 2026-10 | 6,714 | 0 | 0 | 5 | 6,719 | 84.69 | 0.00 | 0.00 | +0.00 | 0.01 | 84.70 | 0 |
| audio-gateway-mini | 2026-09 | 706 | 0 | 0 | 0 | 706 | 30.26 | 0.00 | 0.00 | -14.27 | 0.00 | 15.98 | 0 |
| audio-gateway-mini | 2026-10 | 643 | 0 | 0 | 0 | 643 | 28.75 | 0.00 | 0.00 | -6.46 | 0.00 | 22.29 | 0 |
| audio-gateway-vps | 2026-06 | 198 | 0 | 0 | 0 | 198 | 0.15 | 0.00 | 0.00 | +0.00 | 0.00 | 0.15 | 0 |
| audio-gateway-vps | 2026-07 | 556 | 0 | 0 | 0 | 556 | 0.23 | 0.00 | 0.00 | +0.00 | 0.00 | 0.23 | 0 |
| audio-gateway-vps | 2026-08 | 616 | 0 | 0 | 0 | 616 | 0.44 | 0.00 | 0.00 | +0.01 | 0.00 | 0.46 | 0 |
| audio-gateway-vps | 2026-09 | 1,729 | 0 | 0 | 0 | 1,729 | 23.10 | 0.00 | 0.00 | +0.16 | 0.00 | 23.26 | 0 |
| audio-gateway-vps | 2026-10 | 562 | 0 | 0 | 0 | 562 | 0.00 | 0.00 | 0.00 | +0.06 | 0.00 | 0.06 | 0 |
| audio-gateway | 2026-06 | 91 | 0 | 0 | 0 | 91 | 0.92 | 0.00 | 0.00 | -0.80 | 0.00 | 0.12 | 0 |
| audio-gateway | 2026-07 | 559 | 0 | 0 | 0 | 559 | 4.28 | 0.00 | 0.00 | -4.04 | 0.00 | 0.24 | 0 |
| audio-gateway | 2026-08 | 709 | 0 | 0 | 0 | 709 | 3.87 | 0.00 | 0.00 | -3.29 | 0.00 | 0.58 | 0 |
| audio-gateway | 2026-09 | 2,962 | 0 | 0 | 0 | 2,962 | 68.40 | 0.00 | 0.00 | -27.74 | 0.00 | 40.66 | 0 |
| audio-gateway | 2026-10 | 2,102 | 0 | 0 | 0 | 2,102 | 57.87 | 0.00 | 0.00 | -5.83 | 0.00 | 52.04 | 0 |
| audio-proxy | 2026-05 | 106 | 0 | 0 | 0 | 106 | 1.54 | 0.00 | 0.00 | -1.48 | 0.00 | 0.05 | 0 |
| audio-proxy | 2026-06 | 283 | 0 | 0 | 0 | 283 | 4.72 | 0.00 | 0.00 | -4.59 | 0.00 | 0.13 | 0 |
| claude-code | 2026-04 | 2,307 | 0 | 0 | 0 | 2,307 | 255.12 | 0.00 | 0.00 | +0.00 | 0.00 | 255.12 | 0 |
| claude-code | 2026-05 | 30,842 | 0 | 0 | 0 | 30,842 | 3912.46 | 0.00 | 0.00 | -0.00 | 0.00 | 3912.46 | 0 |
| claude-code | 2026-06 | 21,369 | 0 | 0 | 0 | 21,369 | 3219.58 | 0.00 | 0.00 | -0.00 | 0.00 | 3219.58 | 0 |
| claude-code | 2026-07 | 85,769 | 0 | 0 | 0 | 85,769 | 8724.48 | 0.00 | 0.00 | +84.36 | 0.00 | 8808.83 | 0 |
| claude-code | 2026-08 | 135,412 | 0 | 0 | 0 | 135,412 | 15523.20 | 0.00 | 0.00 | -0.07 | 0.00 | 15523.13 | 0 |
| claude-code | 2026-09 | 169,347 | 0 | 0 | 0 | 169,347 | 12258.46 | 0.00 | 0.00 | -113.10 | 0.00 | 12145.36 | 0 |
| claude-code | 2026-10 | 282,866 | 0 | 0 | 454 | 283,320 | 21141.36 | 0.00 | 0.00 | -5381.49 | 21.43 | 15781.30 | 0 |
| codex | 2026-09 | 481 | 0 | 0 | 0 | 481 | 90.95 | 0.00 | 0.00 | -0.00 | 0.00 | 90.95 | 0 |
| email-gateway | 2026-10 | 105 | 0 | 0 | 0 | 105 | 0.01 | 0.00 | 0.00 | +0.00 | 0.00 | 0.01 | 0 |
| feuer | 2026-05 | 2,207 | 0 | 0 | 0 | 2,207 | 231.91 | 0.00 | 0.00 | +0.00 | 0.00 | 231.91 | 0 |
| feuer | 2026-06 | 2,414 | 0 | 0 | 0 | 2,414 | 2101.00 | 0.00 | 0.00 | -1134.42 | 0.00 | 966.57 | 0 |
| hermes | 2026-04 | 140 | 0 | 0 | 0 | 140 | 10.46 | 0.00 | 0.00 | +0.00 | 0.00 | 10.46 | 0 |
| hermes | 2026-05 | 707 | 0 | 0 | 0 | 707 | 63.61 | 0.00 | 0.00 | +0.00 | 0.00 | 63.61 | 0 |
| hermes | 2026-06 | 181 | 0 | 0 | 0 | 181 | 18.69 | 0.00 | 0.00 | -12.02 | 0.00 | 6.67 | 0 |
| hermes | 2026-07 | 506 | 0 | 0 | 0 | 506 | 17.02 | 0.00 | 0.00 | -12.19 | 0.00 | 4.83 | 0 |
| hermes | 2026-08 | 1,679 | 0 | 0 | 0 | 1,679 | 65.36 | 0.00 | 0.00 | -7.07 | 0.00 | 58.29 | 0 |
| hermes | 2026-09 | 1,783 | 0 | 0 | 0 | 1,783 | 63.04 | 0.00 | 0.00 | +2.18 | 0.00 | 65.22 | 0 |
| hermes | 2026-10 | 263 | 0 | 0 | 2 | 265 | 9.01 | 0.00 | 0.00 | -2.32 | 0.00 | 6.70 | 0 |
| image-gateway | 2026-10 | 47 | 0 | 0 | 0 | 47 | 0.44 | 0.00 | 0.00 | -0.44 | 0.00 | 0.00 | 0 |
| image-gen-gateway | 2026-07 | 31 | 0 | 0 | 0 | 31 | 0.74 | 0.00 | 0.00 | -0.74 | 0.00 | 0.00 | 0 |
| image-gen-gateway | 2026-08 | 1 | 0 | 0 | 0 | 1 | 0.02 | 0.00 | 0.00 | -0.02 | 0.00 | 0.00 | 0 |
| image-gen-gateway | 2026-09 | 34 | 0 | 0 | 0 | 34 | 1.01 | 0.00 | 0.00 | -1.00 | 0.00 | 0.00 | 0 |
| image-gen-gateway | 2026-10 | 2 | 0 | 0 | 0 | 2 | 0.01 | 0.00 | 0.00 | -0.01 | 0.00 | 0.00 | 0 |
| litellm | 2026-05 | 1,031 | 0 | 0 | 0 | 1,031 | 53.55 | 0.00 | 0.00 | +0.00 | 0.00 | 53.55 | 0 |
| litellm | 2026-06 | 3,985 | 0 | 0 | 0 | 3,985 | 167.14 | 0.00 | 0.00 | -104.26 | 0.00 | 62.88 | 0 |
| litellm | 2026-07 | 1,915 | 0 | 0 | 0 | 1,915 | 13.81 | 0.00 | 0.00 | -11.28 | 0.00 | 2.53 | 0 |
| litellm | 2026-08 | 1 | 0 | 0 | 0 | 1 | 0.00 | 0.00 | 0.00 | -0.00 | 0.00 | 0.00 | 0 |
| modelpick | 2026-08 | 340 | 0 | 0 | 0 | 340 | 39.33 | 0.00 | 0.00 | -0.86 | 0.00 | 38.47 | 0 |
| modelpick | 2026-09 | 132 | 0 | 0 | 0 | 132 | 4.44 | 0.00 | 0.00 | -1.06 | 0.00 | 3.38 | 0 |
| opencode | 2026-05 | 13 | 0 | 0 | 0 | 13 | 5.25 | 0.00 | 0.00 | -0.05 | 0.00 | 5.20 | 0 |
| opencode | 2026-06 | 6 | 0 | 0 | 0 | 6 | 0.05 | 0.00 | 0.00 | -0.03 | 0.00 | 0.02 | 0 |
| opencode | 2026-07 | 1 | 0 | 0 | 0 | 1 | 0.44 | 0.00 | 0.00 | -0.36 | 0.00 | 0.08 | 0 |
| opencode | 2026-09 | 5,386 | 0 | 0 | 0 | 5,386 | 10.52 | 0.00 | 0.00 | -1.89 | 0.00 | 8.64 | 0 |
| opencode | 2026-10 | 16,645 | 0 | 0 | 0 | 16,645 | 48.44 | 0.00 | 0.00 | -17.47 | 0.00 | 30.98 | 0 |
| research-gateway | 2026-06 | 58 | 0 | 0 | 0 | 58 | 4.14 | 0.00 | 0.00 | +0.06 | 0.00 | 4.20 | 0 |
| research-gateway | 2026-07 | 366 | 0 | 0 | 0 | 366 | 18.07 | 0.00 | 0.00 | +4.59 | 0.00 | 22.66 | 0 |
| research-gateway | 2026-08 | 2,016 | 0 | 0 | 0 | 2,016 | 87.55 | 0.00 | 0.00 | +2.01 | 0.00 | 89.55 | 0 |
| research-gateway | 2026-09 | 1,545 | 2 | 0 | 0 | 1,543 | 83.32 | 0.00 | 0.00 | -18.88 | 0.00 | 64.44 | 0 |
| research-gateway | 2026-10 | 2,515 | 0 | 0 | 0 | 2,515 | 61.22 | 0.00 | 0.00 | +0.00 | 0.00 | 61.22 | 0 |

## Tokens per source and month

Backfilled token kinds from `usage.records`. The last column is the difference to Argo after dedup (plus SQLite-only rows, minus skipped rows, plus the store swap) as `rows/input/output/cache_read/cache_write/reasoning`; `0` means every kind matches exactly. Argo stores one cache-write total, so `cache_write_5m + cache_write_1h` is compared with it; the 1h part comes from SQLite. Reasoning counts the unbilled terra tokens kept in `raw.reasoningTokensUnbilled`.

| source | month | input | output | cache_read | cache_write_5m | cache_write_1h | reasoning | diff vs Argo |
|-|-|-|-|-|-|-|-|-|
| agent-gateway-iu | 2026-05 | 8,626 | 1,711 | 0 | 0 | 0 | 0 | 0 |
| agent-gateway-iu | 2026-06 | 715,786 | 6,664 | 0 | 0 | 0 | 0 | 0 |
| agent-gateway-iu | 2026-07 | 877,920 | 28,890 | 0 | 0 | 0 | 138,600 | 0 |
| agent-gateway-iu | 2026-08 | 2,446,475 | 16,012 | 0 | 0 | 0 | 365,331 | 0 |
| agent-gateway-iu | 2026-09 | 30,403,834 | 14,622,479 | 342,617,902 | 0 | 0 | 972,585 | 0 |
| agent-gateway-iu | 2026-10 | 264,216,179 | 111,175,572 | 3,263,748,369 | 0 | 0 | 21,400,052 | 0 |
| agent-gateway-opencode | 2026-10 | 19,843,879 | 18,275,676 | 1,925,305,705 | 282,436,650 | 0 | 35,460,916 | 0 |
| agent-gateway-sessions | 2026-05 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| agent-gateway-sessions | 2026-06 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| agent-gateway-sessions | 2026-07 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| agent-gateway-sessions | 2026-08 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| agent-gateway-sessions | 2026-09 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| agent-gateway-sessions | 2026-10 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| agent-workflows | 2026-10 | 23,089,506 | 4,718,552 | 243,609,430 | 70,783,614 | 0 | 18,296,732 | 0 |
| argo | 2026-06 | 2,583,145 | 20,353 | 0 | 0 | 0 | 0 | 0 |
| argo | 2026-08 | 813,539 | 48,301 | 0 | 0 | 0 | 0 | 0 |
| argo | 2026-09 | 4,332 | 9,942 | 0 | 0 | 0 | 0 | 0 |
| argo | 2026-10 | 193,563 | 27,742 | 0 | 0 | 0 | 25,126 | 0 |
| astra | 2026-09 | 47,275 | 49,713 | 1,915 | 0 | 0 | 17,904 | 0 |
| astroclaw | 2026-09 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| athena-teamchat | 2026-10 | 80,045,442 | 9,098,383 | 2,045,925,894 | 0 | 0 | 0 | 0 |
| audio-gateway-mini | 2026-09 | 3,508,466 | 389,707 | 332,672 | 0 | 0 | 0 | 0 |
| audio-gateway-mini | 2026-10 | 4,950,181 | 1,665,071 | 8,893,845 | 0 | 0 | 0 | 0 |
| audio-gateway-vps | 2026-06 | 55,055 | 117,967 | 14,336 | 0 | 0 | 149,099 | 0 |
| audio-gateway-vps | 2026-07 | 329,075 | 255,507 | 18,304 | 0 | 0 | 230,445 | 0 |
| audio-gateway-vps | 2026-08 | 79,574 | 211,088 | 52,736 | 0 | 0 | 344,515 | 0 |
| audio-gateway-vps | 2026-09 | 3,480,015 | 685,416 | 74,386 | 0 | 0 | 91,642 | 0 |
| audio-gateway-vps | 2026-10 | 68,081 | 132,200 | 5 | 0 | 0 | 1,953 | 0 |
| audio-gateway | 2026-06 | 37,799 | 197,238 | 384 | 0 | 0 | 1,320 | 0 |
| audio-gateway | 2026-07 | 347,379 | 485,952 | 0 | 0 | 0 | 0 | 0 |
| audio-gateway | 2026-08 | 137,378 | 557,695 | 0 | 0 | 0 | 535 | 0 |
| audio-gateway | 2026-09 | 7,360,926 | 1,073,258 | 393,418 | 0 | 0 | 172,319 | 0 |
| audio-gateway | 2026-10 | 10,936,929 | 2,837,280 | 13,473,502 | 118,967 | 0 | 2,024,247 | 0 |
| audio-proxy | 2026-05 | 50,526 | 83,040 | 0 | 0 | 0 | 0 | 0 |
| audio-proxy | 2026-06 | 123,252 | 321,116 | 0 | 0 | 0 | 0 | 0 |
| claude-code | 2026-04 | 20,444 | 1,760,499 | 346,578,531 | 7,570,441 | 0 | 0 | 0 |
| claude-code | 2026-05 | 1,515,777 | 27,502,058 | 5,263,422,195 | 107,770,763 | 0 | 0 | 0 |
| claude-code | 2026-06 | 6,163,263 | 30,309,644 | 3,403,412,315 | 84,284,628 | 28,307,966 | 0 | 0 |
| claude-code | 2026-07 | 11,716,659 | 70,374,924 | 12,376,680,657 | 244,829,451 | 150,580,564 | 0 | 0 |
| claude-code | 2026-08 | 4,810,280 | 98,723,822 | 22,682,538,844 | 346,452,920 | 211,853,067 | 13,753,151 | 0 |
| claude-code | 2026-09 | 144,033,620 | 105,477,378 | 27,266,120,814 | 286,352,516 | 320,180,279 | 39,737,887 | 0 |
| claude-code | 2026-10 | 3,304,010 | 212,530,165 | 44,129,776,716 | 495,469,618 | 635,585,739 | 78,003,249 | 0 |
| codex | 2026-09 | 78,747 | 171,852 | 47,583,754 | 2,583,515 | 0 | 83,203 | 0 |
| email-gateway | 2026-10 | 74,178 | 5,766 | 0 | 0 | 0 | 2,609 | 0 |
| feuer | 2026-05 | 141,845,431 | 8,589,742 | 392,478,436 | 0 | 0 | 0 | 0 |
| feuer | 2026-06 | 1,395,925,161 | 16,778,159 | 212,411,702 | 0 | 0 | 0 | 0 |
| hermes | 2026-04 | 4,518,114 | 144,048 | 1,989,750 | 2,399,077 | 0 | 0 | 0 |
| hermes | 2026-05 | 2,580,893 | 345,737 | 14,206,024 | 14,367,610 | 0 | 0 | 0 |
| hermes | 2026-06 | 12,581,121 | 488,195 | 9,869,706 | 18,094 | 0 | 0 | 0 |
| hermes | 2026-07 | 9,626,770 | 365,323 | 45,788,672 | 0 | 0 | 494,726 | 0 |
| hermes | 2026-08 | 28,615,982 | 1,204,867 | 281,100,193 | 23,390,042 | 0 | 2,887,999 | 0 |
| hermes | 2026-09 | 59,945,863 | 15,785,247 | 1,826,713,065 | 41,603,196 | 0 | 7,027,394 | 0 |
| hermes | 2026-10 | 7,230,858 | 1,698,857 | 485,367,105 | 5,379,903 | 0 | 1,228,438 | 0 |
| image-gateway | 2026-10 | 25,071 | 13,890 | 14,237 | 0 | 0 | 0 | 0 |
| image-gen-gateway | 2026-07 | 71,410 | 37,332 | 0 | 0 | 0 | 0 | 0 |
| image-gen-gateway | 2026-08 | 169 | 716 | 0 | 0 | 0 | 0 | 0 |
| image-gen-gateway | 2026-09 | 21,974 | 34,414 | 4,736 | 0 | 0 | 0 | 0 |
| image-gen-gateway | 2026-10 | 4,782 | 932 | 0 | 0 | 0 | 0 | 0 |
| litellm | 2026-05 | 51,908,930 | 830,137 | 4,842,154 | 0 | 0 | 7,043 | 0 |
| litellm | 2026-06 | 135,769,549 | 1,728,981 | 88,254,471 | 0 | 0 | 426,821 | 0 |
| litellm | 2026-07 | 664,031 | 1,013,108 | 168,749,056 | 0 | 0 | 361,250 | 0 |
| litellm | 2026-08 | 84 | 16 | 0 | 0 | 0 | 16 | 0 |
| modelpick | 2026-08 | 3,598,378 | 985,713 | 29,237,483 | 2,925,505 | 0 | 171,904 | 0 |
| modelpick | 2026-09 | 2,801,535 | 433,806 | 8,050,524 | 0 | 0 | 98,589 | 0 |
| opencode | 2026-05 | 4,098,138 | 97,483 | 5,055,998 | 53,268 | 0 | 0 | 0 |
| opencode | 2026-06 | 52,730 | 166 | 115,200 | 0 | 0 | 120 | 0 |
| opencode | 2026-07 | 90,124 | 20,645 | 4,250,624 | 0 | 0 | 13,053 | 0 |
| opencode | 2026-09 | 17,228,555 | 1,513,928 | 564,717,114 | 221,684 | 0 | 2,559,353 | 0 |
| opencode | 2026-10 | 55,768,984 | 3,011,639 | 1,232,545,253 | 203,610 | 0 | 10,284,415 | 0 |
| research-gateway | 2026-06 | 8,962,814 | 275,989 | 0 | 0 | 0 | 67,277 | 0 |
| research-gateway | 2026-07 | 79,375,061 | 3,695,812 | 30,141,952 | 0 | 0 | 917,593 | 0 |
| research-gateway | 2026-08 | 481,503,537 | 25,070,584 | 286,442,511 | 0 | 0 | 13,886,799 | 0 |
| research-gateway | 2026-09 | 218,454,261 | 13,598,775 | 142,168,541 | 0 | 0 | 6,979,789 | 0 |
| research-gateway | 2026-10 | 171,018,349 | 38,119,831 | 423,878,523 | 0 | 0 | 22,527,752 | 0 |

## (i) Duplicates collapsed by the new key

Argo's key is `(source, source_id, machine)`; the new one is `(source, source_id)`. In this snapshot 2 Argo row(s) share a key with another: 0 tokens, $0.00. The ~$3,081 quoted for the old key does not reproduce on this table; no duplicate of that size exists in `argo.usage_record` or between it and SQLite.

| source | source_id | kept (machine) | kept from | dropped rows (machine: cost) |
|-|-|-|-|-|
| research-gateway | `tavily-account` | Mac mini (M2 Pro) | sqlite | vps: NULL, mini: NULL |

## (ii) Rows present in one store only

- In SQLite, not in Argo: **0** rows, $0.00 (rows ingested after the last sync).
- In Argo, not in SQLite: **22,177** rows, $1429.37, written from the Argo row (posted by agent-workflows, the VPS gateways, email-gateway, Argo itself, or a gateway whose collector was retired):

| source | rows | Argo $ |
|-|-|-|
| agent-gateway-iu | 6 | 0.26 |
| agent-workflows | 4,533 | 75.53 |
| argo | 184 | 0.01 |
| astroclaw | 1 | 0.00 |
| audio-gateway | 4,201 | 74.61 |
| audio-gateway-mini | 1,349 | 59.01 |
| claude-code | 7,165 | 1024.54 |
| email-gateway | 105 | 0.01 |
| image-gateway | 47 | 0.44 |
| image-gen-gateway | 68 | 1.77 |
| litellm | 932 | 12.71 |
| research-gateway | 3,586 | 180.47 |

- In both stores: 849,223 keys, written from SQLite. Token difference between the two rows: 0 (absolute sum over buckets). Cost difference (SQLite exact minus Argo float4): $-0.000003.

## (iii) Cost re-derived by the rate tables, by model

Rows priced both before and after (not provider-reported). `old` is the stored `cost_usd` (`pricing.ts` with `FAMILY_PRICING` and the IU rate card), `new` is `usage.compute_cost`. Sorted by absolute delta; this is the table to build IU `price_overrides` from for the `api_key` rows (the portal stays the truth there).

| model | billing | rows | old $ | new $ | delta $ | delta % | of which old family-fallback rows | their delta $ |
|-|-|-|-|-|-|-|-|-|
| claude-sonnet-5-5 | max | 142,752 | 10948.45 | 5481.04 | -5467.41 | -49.9% | 142,752 | -5467.41 |
| deepseek-v4-pro | api_key | 11,792 | 2035.24 | 733.54 | -1301.70 | -64.0% | 0 | +0.00 |
| deepseek-v4.1-flash | api_key | 24,963 | 315.95 | 235.53 | -80.43 | -25.5% | 0 | +0.00 |
| claude-sonnet-5 | max | 221,442 | 11059.06 | 11137.51 | +78.45 | +0.7% | 5,705 | +0.00 |
| deepseek-v4-flash | api_key | 9,802 | 60.47 | 99.38 | +38.91 | +64.3% | 0 | +0.00 |
| gpt-5.6-luna | api_key | 2,559 | 58.84 | 80.02 | +21.17 | +36.0% | 0 | +0.00 |
| claude-sonnet-5-5 | api_key | 20 | 2.30 | 1.52 | -0.78 | -34.0% | 20 | -0.78 |
| kimi-k2.7-code | api_key | 76 | 1.20 | 0.86 | -0.34 | -28.0% | 0 | +0.00 |
| gpt-5.6-terra | api_key | 1,909 | 100.43 | 100.75 | +0.32 | +0.3% | 0 | +0.00 |
| claude-haiku-5-5 | max | 2,340 | 15.38 | 15.59 | +0.22 | +1.4% | 0 | +0.00 |

35 further model/billing groups differ by less than $0.005 each (375,390 rows, -0.0006 in total).

Provider-reported rows: 65,239 rows kept their stored cost as `cost_reported_usd`; mismatches: none (identical). 269 of them reported $0 and stay reported $0.

## (iv) The 1h cache-write repricing effect

Argo has no `cache_write_1h_tokens`; every row that exists in SQLite keeps its exact split and is priced with the catalog's 1h rate. `new without split` is the same rows priced with all cache writes at the 5m rate (what the Argo data alone would give).

| source | rows with 1h writes | 1h tokens | new $ | new without split $ | split is worth $ |
|-|-|-|-|-|-|
| claude-code | 335,538 | 1,346,507,615 | 32796.89 | 29155.45 | +3641.43 |

Repricing delta on rows with 1h writes: 335,306 rows, -2570.38 (the old figure priced 1h at its own rate as well, so this is the rate-table difference, not the split). Rows that exist only in Argo and carry cache writes (no split available, all priced at the 5m rate): 8,632 rows, 110,989,100 tokens, $1061.16 old cost.

## (v) Rows without a price (cost NULL)

### Had a stored cost, now NULL (4,217 rows, $69.65)

| model | billing | rows | of which zero-token | tokens | old cost lost $ | sources |
|-|-|-|-|-|-|-|
| v3 | api_key | 1,795 | 1,795 | 0 | 39.56 | audio-gateway, audio-gateway-mini |
| gemini-3.1-flash-tts-preview | api_key | 513 | 3 | 751,128 | 9.39 | audio-gateway, audio-proxy |
| flash-v2.5 | api_key | 657 | 657 | 0 | 7.95 | audio-gateway, audio-gateway-mini |
| gpt-4o-transcribe | api_key | 682 | 37 | 731,079 | 4.71 | audio-gateway, audio-proxy |
| gpt-image-2 | api_key | 65 | 0 | 106,925 | 3.01 | agent-gateway-iu, audio-gateway, audio-gateway-mini, audio-gateway-vps, image-gen-gateway |
| gemini-3.8-flash-tts | api_key | 68 | 0 | 203,763 | 1.61 | audio-gateway, audio-gateway-mini |
| voxtral-mini-transcribe-3-0 | api_key | 106 | 0 | 52,654 | 1.09 | audio-gateway |
| gpt-image-2.5-flare | api_key | 49 | 0 | 21,992 | 0.55 | audio-gateway, audio-gateway-mini, image-gateway, image-gen-gateway |
| glm-5.1 | api_key | 12 | 0 | 830,492 | 0.38 | modelpick |
| mimo-v2.5-pro | api_key | 12 | 7 | 369,967 | 0.32 | modelpick |
| gemini-3.8-flash-lite-tts | api_key | 118 | 0 | 58,690 | 0.31 | audio-gateway |
| gpt-transcribe | api_key | 35 | 35 | 0 | 0.21 | audio-gateway, audio-gateway-mini |
| gpt-5.6 | api_key | 3 | 0 | 16,011 | 0.14 | image-gen-gateway |
| gpt-image-1.5 | api_key | 4 | 0 | 5,021 | 0.12 | image-gen-gateway |
| gpt-image-2.5-sunburst | api_key | 5 | 0 | 4,770 | 0.06 | image-gateway, image-gen-gateway |
| recraft-remove-background | api_key | 6 | 6 | 0 | 0.06 | image-gateway |
| qwen3.7-max | api_key | 2 | 1 | 21,666 | 0.06 | modelpick |
| gemini-3-pro-preview | api_key | 2 | 0 | 26,938 | 0.05 | agent-gateway-iu, opencode |
| recraft-vectorize | api_key | 3 | 3 | 0 | 0.03 | image-gateway |
| remove-background | api_key | 1 | 1 | 0 | 0.02 | image-gateway |
| nvidia-nemotron-3-super-120b-a12b | api_key | 2 | 0 | 126,271 | 0.01 | modelpick |
| whisper | api_key | 2 | 2 | 0 | 0.00 | audio-gateway, audio-proxy |
| real-esrgan | api_key | 1 | 1 | 0 | 0.00 | image-gateway |
| birefnet | api_key | 1 | 1 | 0 | 0.00 | astroclaw |
| pplx-decider-v1-27b | api_key | 4 | 0 | 12,200 | 0.00 | email-gateway |
| decision-1 | api_key | 2 | 0 | 2,060 | 0.00 | email-gateway |
| gemma4-agent | api_key | 52 | 0 | 4,602,749 | 0.00 | hermes |
| glm-5.2 | api_key | 7 | 7 | 0 | 0.00 | modelpick |
| nemotron-3-ultra | api_key | 5 | 5 | 0 | 0.00 | modelpick |
| gpt-4o-mini-tts | api_key | 2 | 2 | 0 | 0.00 | audio-proxy |
| none | api_key | 1 | 1 | 0 | 0.00 | image-gateway |

### NULL before and after (7,422 rows)

| model | billing | rows | of which zero-token | tokens | old cost lost $ | sources |
|-|-|-|-|-|-|-|
| v3 | api_key | 2,064 | 2,064 | 0 | 0.00 | audio-gateway, audio-gateway-mini, audio-gateway-vps |
| (null) | api_key | 2,062 | 2,062 | 0 | 0.00 | audio-gateway-vps, research-gateway |
| flash-v2.5 | api_key | 852 | 852 | 0 | 0.00 | audio-gateway, audio-gateway-mini, audio-gateway-vps |
| gpt-4o-transcribe | api_key | 709 | 114 | 662,349 | 0.00 | audio-gateway, audio-gateway-vps |
| <synthetic> | max | 563 | 563 | 0 | 0.00 | claude-code |
| gemini-3.1-flash-tts-preview | api_key | 340 | 6 | 481,793 | 0.00 | audio-gateway, audio-gateway-vps |
| gemini-3.8-flash-lite-tts | api_key | 223 | 104 | 59,294 | 0.00 | audio-gateway, audio-gateway-vps |
| gemini-3.8-flash-tts | api_key | 176 | 22 | 445,161 | 0.00 | audio-gateway, audio-gateway-mini, audio-gateway-vps |
| voxtral-mini-transcribe-3-0 | api_key | 156 | 50 | 52,654 | 0.00 | audio-gateway, audio-gateway-vps |
| <synthetic> | api_key | 98 | 98 | 0 | 0.00 | claude-code |
| gpt-transcribe | api_key | 61 | 61 | 0 | 0.00 | audio-gateway, audio-gateway-mini, audio-gateway-vps |
| whisper | api_key | 26 | 26 | 0 | 0.00 | audio-gateway, audio-gateway-vps |
| hermes | api_key | 21 | 0 | 3,343,844 | 0.00 | argo |
| gpt-5.6 | api_key | 17 | 0 | 77,977 | 0.00 | image-gen-gateway |
| gemini-4-argon | api_key | 16 | 0 | 382,243 | 0.00 | audio-gateway |
| gemini-3.1-flash | api_key | 9 | 9 | 0 | 0.00 | audio-gateway-vps |
| clef | unknown | 5 | 5 | 0 | 0.00 | email-gateway |
| clef-flash | unknown | 4 | 4 | 0 | 0.00 | email-gateway |
| glm-5.3-flash-nonexistent | api_key | 3 | 3 | 0 | 0.00 | agent-gateway-sessions |
| wrong-model-name | api_key | 3 | 3 | 0 | 0.00 | audio-gateway |
| gemini-3-flash | api_key | 3 | 3 | 0 | 0.00 | audio-proxy |
| gpt-4o-mini-transcribe | api_key | 2 | 0 | 54 | 0.00 | audio-gateway, audio-gateway-vps |
| gpt-4o-transcribe-diarize | api_key | 2 | 2 | 0 | 0.00 | audio-gateway, audio-gateway-vps |
| voxtral-mini-transcribe-realtime-2602 | api_key | 2 | 2 | 0 | 0.00 | audio-gateway, audio-gateway-vps |
| deepseek-v4p1-flash | api_key | 2 | 0 | 115,386 | 0.00 | hermes |
| claude-does-not-exist-9 | max | 1 | 1 | 0 | 0.00 | agent-gateway-sessions |
| tts-1 | api_key | 1 | 1 | 0 | 0.00 | audio-gateway-vps |
| gpt-image-2 | api_key | 1 | 1 | 0 | 0.00 | image-gen-gateway |

### NULL before, priced now (636 rows, $0.00 old)

| model | billing | rows | of which zero-token | tokens | old cost lost $ | sources |
|-|-|-|-|-|-|-|
| gemini-2.5-flash-lite | api_key | 275 | 0 | 117,187 | 0.00 | hermes |
| gemini-3.5-flash-lite | api_key | 168 | 0 | 163,122 | 0.00 | audio-gateway-vps |
| claude-sonnet-5 | max | 105 | 0 | 10,252,837 | 0.00 | claude-code |
| deepseek-v4-flash | api_key | 57 | 0 | 40,457 | 0.00 | argo |
| gemini-3.1-pro-preview | api_key | 15 | 0 | 261,702 | 0.00 | audio-gateway-vps |
| claude-haiku-5-5 | api_key | 5 | 0 | 1,099,911 | 0.00 | agent-workflows |
| gpt-6-luna | api_key | 3 | 0 | 178,971 | 0.00 | argo |
| gemini-2.5-flash | api_key | 3 | 1 | 2,131 | 0.00 | audio-gateway-vps, hermes |
| deepseek-v4.1-flash | api_key | 2 | 0 | 1,760,763 | 0.00 | agent-workflows |
| claude-sonnet-4-6 | api_key | 2 | 1 | 89,882 | 0.00 | argo |
| glm-5.3 | api_key | 1 | 1 | 0 | 0.00 | audio-gateway |

Reported cost ignored: 841 rows -86.42 (`sonar`: tokens price it, the vendor figure includes search fees).

## (vi) Everything else

Counters from the union step:

- agent-gateway-sessions: workspace empty in SQLite, filled from Argo: 7,482
- agent-workflows: grain step written as session: 4,533
- argo: machine empty (stored NULL): 184
- astroclaw: grain request written as message: 1
- audio-gateway-mini: grain request written as message: 1,349
- audio-gateway: grain request written as message: 4,201
- billing openrouter -> unknown: 47
- claude-code: account empty in SQLite, filled from Argo: 328
- claude-code: workspace empty in SQLite, filled from Argo: 669,453
- codex: workspace empty in SQLite, filled from Argo: 473
- email-gateway: grain request written as message: 105
- feuer: subTool empty in SQLite, filled from Argo: 4
- feuer: workspace empty in SQLite, filled from Argo: 4
- image-gateway: grain request written as message: 47
- image-gen-gateway: grain request written as message: 68
- litellm: workspace empty in SQLite, filled from Argo: 2,595
- project differs (Argo keeps a shortened form; the SQLite path is written): 812,547
- ts spelled differently in both stores (same instant): 6,014

- Billing / account / IU key as stored: every backfilled row carries the stored values (checked on all matched keys).
- `account` stored on a non-Max row and dropped (the column rule: Max rows only): 328.
- Argo billing `openrouter` is not in the writer's vocabulary and is written `unknown`: 47 rows.
- Malformed or non-object `raw` JSON (kept as `{legacyRaw: ...}` or dropped): 0.
- Rows not backfilled: none (every ts parses, every grain is known)

### Zero-token marker rows (kept as records)

| source | rows | old cost $ | now NULL |
|-|-|-|-|
| agent-gateway-iu | 89 | 0.00 | 0 |
| agent-gateway-opencode | 31 | 0.00 | 0 |
| agent-gateway-sessions | 17,569 | 0.00 | 4 |
| agent-workflows | 404 | 9.71 | 0 |
| argo | 1 | 0.00 | 0 |
| astroclaw | 1 | 0.00 | 1 |
| athena-teamchat | 36 | 0.00 | 0 |
| audio-gateway | 3,371 | 30.16 | 3,336 |
| audio-gateway-mini | 701 | 17.55 | 698 |
| audio-gateway-vps | 1,815 | 0.00 | 1,814 |
| audio-proxy | 12 | 0.00 | 12 |
| claude-code | 6,589 | 0.00 | 661 |
| email-gateway | 9 | 0.00 | 9 |
| feuer | 16 | 0.00 | 0 |
| image-gateway | 12 | 0.11 | 12 |
| image-gen-gateway | 1 | 0.00 | 1 |
| litellm | 75 | 0.00 | 0 |
| modelpick | 55 | 0.00 | 20 |
| opencode | 31 | 0.00 | 0 |
| research-gateway | 2,113 | 0.00 | 2,052 |

Total: 32,931 rows with no tokens of any kind.

### Model normalization (old `model_norm` -> new `model`)

| old -> new | rows |
|-|-|
| claude-sonnet-5[1m] -> claude-sonnet-5 | 5,748 |
| elevenlabs/v3 -> v3 | 1,729 |
| perplexity/pplx-decider-v1-27b -> pplx-decider-v1-27b | 1,099 |
| claude-haiku-5-5-eu -> claude-haiku-5-5 | 998 |
| elevenlabs/flash-v2.5 -> flash-v2.5 | 853 |
| deepseek/deepseek-v4.1-flash -> deepseek-v4.1-flash | 470 |
| claude-sonnet-5-5-eu -> claude-sonnet-5-5 | 82 |
| bedrock/eu.anthropic.claude-haiku-5-5 -> eu.anthropic.claude-haiku-5-5 | 73 |
| deepseek-flash -> deepseek-v4-flash | 72 |
| cloudflare/clef -> clef | 25 |
| cloudflare/clef-flash -> clef-flash | 22 |
| clef-eu -> clef | 17 |
| recraft-ai/recraft-remove-background -> recraft-remove-background | 13 |
| vertex_ai_eu/gemini-3.8-flash -> gemini-3.8-flash | 12 |
| claude-opus-5[1m] -> claude-opus-5 | 4 |
| recraft-ai/recraft-vectorize -> recraft-vectorize | 4 |
| elevenlabs/wrong-model-name -> wrong-model-name | 2 |
| decision-1-eu -> decision-1 | 2 |
| men1scus/birefnet -> birefnet | 1 |
| nightmareai/real-esrgan -> real-esrgan | 1 |
| bria/remove-background -> remove-background | 1 |

## Lanes (records)

| source | lane: rows |
|-|-|
| agent-gateway-iu | agw_workflow 7,931 |
| agent-gateway-opencode | agw_workflow 48,186 |
| agent-gateway-sessions | agw_workflow 17,569 |
| agent-workflows | agw_workflow 4,533 |
| argo | other 184 |
| astra | other 14 |
| astroclaw | other 1 |
| athena-teamchat | other 6,719 |
| audio-gateway | agw_workflow 6,423 |
| audio-gateway-mini | other 1,349 |
| audio-gateway-vps | agw_workflow 3,661 |
| audio-proxy | agw_workflow 389 |
| claude-code | interactive 461,400, wave_mother 115,633, agw_workflow 73,749, fan_worker 45,399, worker 31,352, other 833 |
| codex | interactive 481 |
| email-gateway | other 105 |
| feuer | other 4,621 |
| hermes | hermes 5,261 |
| image-gateway | other 47 |
| image-gen-gateway | other 68 |
| litellm | agw_workflow 6,932 |
| modelpick | other 472 |
| opencode | agw_workflow 13,443, interactive 8,608 |
| research-gateway | agw_workflow 6,498 |

## Sessions

54,925 sessions, 838,038 records linked to one. Sessions whose first/last timestamp differ from the span of their records: 0.

| source | lane: sessions |
|-|-|
| agent-gateway-opencode | agw_workflow 8,400 |
| agent-gateway-sessions | agw_workflow 17,569 |
| agent-workflows | agw_workflow 2,310 |
| claude-code | agw_workflow 6,356, interactive 3,024, fan_worker 668, wave_mother 483, worker 329, other 201 |
| codex | interactive 12 |
| feuer | other 4,621 |
| hermes | hermes 3,056 |
| modelpick | other 472 |
| opencode | agw_workflow 597, interactive 329 |
| research-gateway | agw_workflow 6,498 |

Samples:

- largest Claude Code session: `claude-code` `ff4008a8-d92f-4871-be2c-b10b1493de99`, lane `interactive`, billing `max`, account iu, key none, 7114 records, 2026-09-01T21:24:39.004Z to 2026-09-02T12:12:33.671Z
- a Hermes session: `hermes` `20260414_201333_bb9f7855`, lane `hermes`, billing `api_key`, account none, key personal, 1 records, 2026-04-14T18:13:33.443Z to 2026-04-14T18:13:33.443Z
- an agent-workflows run: `agent-workflows` `01a181b3-6ca9-768a-86d9-49d1531bcb81`, lane `agw_workflow`, billing `api_key`, account none, key personal, 4 records, 2026-10-28T08:49:44.483Z to 2026-10-28T08:49:49.977Z

## Runs and idempotency

| run at (UTC) | seconds | rows in union | inserted | skipped: row exists (insert-only) | rows written or changed |
|-|-|-|-|-|-|
| 2026-10-30T12:30:43 | 197 | 871,400 | 871,400 | 0 | 871,400 |
| 2026-10-30T12:33:48 | 79 | 871,400 | 0 | 4,533 | 283,612 |
| 2026-10-30T12:36:22 | 63 | 871,400 | 0 | 4,533 | 16,866 |
| 2026-10-30T12:37:29 | 71 | 871,400 | 0 | 4,533 | 0 |
| 2026-10-30T12:39:35 | 71 | 871,400 | 0 | 4,533 | 0 |

Reading the table. Run 1 is the initial load (an earlier load, 12:23Z, was deleted and redone after a fix: with insert-only, a session created by the run
must arrive in one call, otherwise its span stays narrow). Runs 2 and 3 are not idempotency runs: the Postgres ingest LaunchAgent started its own first
full scan at 12:25Z (killed at its 600 s deadline at 12:35Z) and rewrote rows of the same keys from the transcripts and tables while the backfill ran, so
the backfill restored its content (283,612 then 16,866 rows, none of them new). Runs 4 and 5, with the live pipeline idle between its 900 s ticks, are the
idempotency proof: 0 rows written or changed, 4,533 agent-workflows rows skipped as already present. A source the live pipeline re-reads in full every run
(Hermes, Feuer, Athena) will show as changed again whenever a tick lands between two backfill runs; that is two writers with different row content for
one key, not a flaw in either run.

"Written or changed" counts rows whose `ingested_at` equals the run's start stamp: the writer touches `ingested_at` only on an insert or a real change, so a second run must show 0. Per-source counts of the last run:

| source | rows | inserted | skipped: row exists |
|-|-|-|-|
| agent-gateway-iu | 7,931 | 0 | 0 |
| agent-gateway-opencode | 48,186 | 0 | 0 |
| agent-gateway-sessions | 17,569 | 0 | 0 |
| agent-workflows | 4,533 | 0 | 4,533 |
| argo | 184 | 0 | 0 |
| astra | 14 | 0 | 0 |
| astroclaw | 1 | 0 | 0 |
| athena-teamchat | 6,714 | 0 | 0 |
| audio-gateway | 6,423 | 0 | 0 |
| audio-gateway-mini | 1,349 | 0 | 0 |
| audio-gateway-vps | 3,661 | 0 | 0 |
| audio-proxy | 389 | 0 | 0 |
| claude-code | 727,912 | 0 | 0 |
| codex | 481 | 0 | 0 |
| email-gateway | 105 | 0 | 0 |
| feuer | 4,621 | 0 | 0 |
| hermes | 5,259 | 0 | 0 |
| image-gateway | 47 | 0 | 0 |
| image-gen-gateway | 68 | 0 | 0 |
| litellm | 6,932 | 0 | 0 |
| modelpick | 472 | 0 | 0 |
| opencode | 22,051 | 0 | 0 |
| research-gateway | 6,498 | 0 | 0 |

