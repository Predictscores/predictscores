## Snapshots guard tuning

The scheduled "Snapshots (AM/PM/LATE)" workflow uses a guard window to avoid
double-processing slots while still tolerating delayed cron invocations. The
default window is **75 minutes**. Operations can adjust it without editing the
workflow by defining the repository variable `SNAPSHOT_GUARD_MINUTES`
(`Settings → Secrets and variables → Actions`).

## Crypto signal volatility tuning

`buildSignals` now derives its intraday vote thresholds from realized log
volatility so that 30m/1h/4h votes scale with current market conditions. The
per-timeframe multipliers can be adjusted without redeploying by setting the
following environment variables:

- `CRYPTO_VOL_MULT_M30` (default **0.35**)
- `CRYPTO_VOL_MULT_H1` (default **0.30**)
- `CRYPTO_VOL_MULT_H4` (default **0.25**)

Each multiplier scales the 60-sample log-volatility (expressed in percentage
points) for its timeframe. Positive values increase or decrease sensitivity,
while blank/invalid values fall back to the defaults above. If the volatility
series is unavailable the engine reuses the legacy static thresholds or the
values provided through `opts.thresh` for compatibility.

## CoinGecko Pro API requirement

Both the `/api/crypto` endpoint and the `crypto-watchdog` cron rely on the
CoinGecko Pro markets feed. Deployments must provide a valid
`COINGECKO_API_KEY` environment variable; when it is missing the API now fails
fast with a `coingecko_api_key_missing` error. Configure the variable in the
hosting provider (for example Vercel project settings or GitHub Actions
secrets) so the watchdog and public API remain operational.

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
