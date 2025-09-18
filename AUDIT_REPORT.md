# Crypto integration audit notes

## CoinGecko FREE endpoint

- All crypto fetchers now call `https://api.coingecko.com/api/v3/coins/markets` using
  the FREE-plan `x-cg-demo-api-key` header. Provide a valid `COINGECKO_API_KEY`
  or requests will fail with `coingecko_api_key_missing` (blank) or
  `coingecko_api_key_invalid` (format/rejection).
- The API (`/api/crypto`) and cron (`/api/cron/crypto-watchdog`) log a
  "CoinGecko env validation" block per invocation that lists the status of
  `COINGECKO_API_KEY`, `UPSTASH_REDIS_REST_URL`, and `UPSTASH_REDIS_REST_TOKEN`
  as `present`, `missing`, or `invalid`. Live fetches are blocked until all three
  are `present` to avoid hitting CoinGecko with an incomplete configuration.

## Quota accounting

- Upstash still enforces the FREE-plan budget (≤30 requests/minute and ≤300
  requests/day). Each reservation prints a `coingecko.quota` structured log with
  the current counters and limits so GitHub Actions and Ops dashboards can prove
  compliance.
- If the guard cannot run (missing Upstash env vars) the handlers log a
  `guard_disabled` entry and stop before attempting CoinGecko calls.

## Operational expectations

- Cached `/api/crypto` responses remain available when live fetches are blocked
  so public consumers keep receiving data while configuration issues are fixed.
- Watchdog and API errors now surface explicit `coingecko_env_incomplete` or
  `coingecko_api_key_invalid` codes, making it easy to alert on misconfigured
  deployments.
