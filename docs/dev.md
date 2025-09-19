# Developer notes

## History KV smoke test

`node scripts/smoke-history.mjs` performs a quick smoke test against the value
bets history snapshots stored in KV. It fetches the latest days, verifies that
at least one backend responds, and calculates the return-on-investment summary
using the same normalization logic as the `/api/history` and `/api/history-roi`
endpoints.

### Environment

Export the credentials for whichever KV backends you want the script to hit:

- `KV_REST_API_URL` and `KV_REST_API_TOKEN` for Vercel KV.
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` for Upstash Redis
  (optional fallback; leave blank to skip it).
- `HISTORY_ALLOWED_MARKETS` (optional) to mirror production market filters when
  computing ROI.

Running under Node.js 18+ matches the production runtime. You can place the
variables in `.env.local` and source it before running the script if you prefer.

### Running the smoke test

```
node scripts/smoke-history.mjs
```

The script prints the backend it is talking to, the keys it probes for each
recent day, and a compact ROI summary. Numbers will vary with live data, but a
healthy run looks similar to the snippet below:

```
$ node scripts/smoke-history.mjs
history smoke (last 14 days)
vercel-kv     hist:2024-05-31 -> items=24 (hist ✅, combined ❌)
vercel-kv     hist:2024-05-30 -> items=17 (hist ✅, combined ✅)
...
ROI: played=41 wins=22 profit=5.6 roi=0.136 winrate=0.54 avg_odds=1.92
Done in 1.2s.
```

If a backend is unreachable or credentials are missing the script will log a
non-zero status for that provider so you can spot configuration issues before
running scheduled jobs.
