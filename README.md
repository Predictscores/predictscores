## Snapshots guard tuning

The scheduled "Snapshots (AM/PM/LATE)" workflow uses a guard window to avoid
double-processing slots while still tolerating delayed cron invocations. The
default window is **75 minutes**. Operations can adjust it without editing the
workflow by defining the repository variable `SNAPSHOT_GUARD_MINUTES`
(`Settings → Secrets and variables → Actions`).

## Value bets meta stats schema

`/api/cron/enrich` now persists a compact stats payload for each team under
`meta.stats.home` and `meta.stats.away`. All numeric fields are JSON numbers so
they remain serializable and easy to consume in follow-up jobs.

Each team block is optional and uses the following keys when data is available:

- `form`: recent sequence (latest 6 chars from API form string, only `W/D/L`).
- `played`: object with `{ h, a, t }` counts (home, away, total).
- `gf_avg` / `ga_avg`: average goals scored / conceded per match `{ h, a, t }`.
- `gf_tot` / `ga_tot`: total goals scored / conceded in the season `{ h, a, t }`.
- `win_pct`, `lose_pct`, `draw_pct`: percentage (0–100) splits by result `{ h, a, t }`.
- `btts_pct`: both teams to score percentage `{ h, a, t }`.
- `over25_pct` / `under25_pct`: over/under 2.5 goal percentages `{ h, a, t }`.
- `clean_pct`: clean sheet percentage `{ h, a, t }`.
- `fail_pct`: failed-to-score percentage `{ h, a, t }`.
- `xg`: expected goals summary, `{ f, a }` for scored and conceded (if provided).

Consumers should treat every key as optional and default to the aggregate (`t`)
when a side-specific sample (`h`/`a`) is missing or based on a very small
number of matches.
