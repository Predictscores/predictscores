# Learning wiring overview

This document describes how the value-bets selector consumes the stored learning
outputs and how to control the feature toggles.

## Feature flags (`cfg:learning`)

The selector reads the `cfg:learning` document from KV on every request. When
the document is missing or malformed every flag defaults to `false` (with
`shadow_mode` defaulting to `true`). Example payload:

```json
{
  "enable_calib": true,
  "enable_evmin": true,
  "enable_league_adj": true,
  "shadow_mode": true
}
```

Flag behaviour:

* `enable_calib` – use bucketed calibration parameters when available.
* `enable_evmin` – use bucketed EV minimum guards.
* `enable_league_adj` – apply per-league probability adjustments.
* `shadow_mode` – compute the learned ranking in parallel and write the
  comparison payload to KV, but continue returning the baseline list. When set
  to `false` the learned list replaces the baseline in the API response.

## Learning buckets and keys

The selector buckets each candidate by:

* market (`BTTS`, `OU2.5`, `FH_OU1.5`, `HTFT`, `1X2`)
* implied odds band (`1.50-1.75`, `1.76-2.20`, `2.21+`)
* league tier (`T1`, `T2`, `T3`)

The following KV keys are optional. When the document is missing or its
`samples` field is `< 200` the selector falls back to the baseline behaviour.

| Purpose | Key format | Expected fields |
| ------- | ---------- | --------------- |
| Calibration | `learn:calib:v2:{market}:{league_tier}:{odds_band}` | `type` (`logistic`, `isotonic`, or delta), `slope`/`intercept` or `points`, `samples` |
| EV guard | `learn:evmin:v2:{market}:{odds_band}` | `ev_min` (fraction) or `ev_min_pp`, `samples` |
| League adjustment | `learn:league_adj:v1:{league_id}` | `delta_pp` or `delta` (fraction), `samples` |

Calibration corrections are clamped to ±7 percentage points, league
adjustments to ±3 pp, and EV minima to the range 0.5–8 pp (merged with the
baseline guard).

## Shadow compare payload

When any learning flag is enabled the selector always computes both the
baseline and the learned lists. The results are written to
`vb:shadow:{ymd}:{slot}` with the following structure:

```json
{
  "baseline": [...],
  "learned": [...],
  "one_x_two_baseline": [...],
  "one_x_two_learned": [...],
  "tickets": {
    "baseline": {...},
    "learned": {...}
  },
  "meta": {
    "ymd": "2024-07-01",
    "slot": "am",
    "flags": {...},
    "shadow_mode": true,
    "generated_at": "2024-07-01T10:30:00.000Z",
    "picks": [
      {
        "fixture_id": 101,
        "market": "BTTS",
        "baseline_edge_pp": 5.2,
        "learned_edge_pp": 6.9,
        "ev_guard_used": 3.0,
        "samples": { "calib": 320, "evmin": 280, "league": 410 }
      }
    ]
  }
}
```

The `picks` array powers the `/api/learning-compare` endpoint and records all
applied adjustments and sample counts. If writing to KV fails the selector logs
the attempt in the debug trace but the response still succeeds with the
baseline list.

## Debugging endpoint

The `/api/learning-compare?ymd=YYYY-MM-DD&slot=am|pm|late` endpoint reads the
shadow payload and returns the top deltas between the baseline and learned
edges together with the EV guard that was applied. It never triggers additional
external API calls.

## Rollback

To disable the learned adjustments set all `enable_*` flags to `false` in the
`cfg:learning` document. The selector immediately reverts to the historical
behaviour. To make the learned ranking live set `shadow_mode` to `false` (leave
other flags untouched) and the selector will start returning the learned list
while still writing the comparison payload for debugging.
