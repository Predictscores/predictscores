## Snapshots guard tuning

The scheduled "Snapshots (AM/PM/LATE)" workflow uses a guard window to avoid
double-processing slots while still tolerating delayed cron invocations. The
default window is **75 minutes**. Operations can adjust it without editing the
workflow by defining the repository variable `SNAPSHOT_GUARD_MINUTES`
(`Settings → Secrets and variables → Actions`).
