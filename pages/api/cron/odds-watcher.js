name: Odds watcher

on:
  schedule:
    - cron: "*/15 8-23 * * *"
  workflow_dispatch: {}

concurrency:
  group: odds-watcher
  cancel-in-progress: true

jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Refresh odds window for current slot
        run: |
          set -euo pipefail
          TZZ="Europe/Belgrade"
          H=$(TZ=$TZZ date +%H)
          if   [ "$H" -lt 10 ]; then SLOT=late
          elif [ "$H" -lt 15 ]; then SLOT=am
          else SLOT=pm; fi
          echo "Resolved: SLOT=$SLOT"
          curl -fsS \
            --connect-timeout 10 \
            --max-time 240 \
            --retry 3 \
            --retry-all-errors \
            --retry-delay 8 \
            --retry-max-time 300 \
            "https://predictscores.vercel.app/api/cron/refresh-odds?slot=$SLOT"
