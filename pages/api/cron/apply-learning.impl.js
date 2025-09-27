// pages/api/cron/apply-learning.impl.js
// Drop-in: writes canonical lock vb:day:<ymd>:last, emits minimal tier telemetry,
// and persists a compact vb:history:<ymd> for the History tab.

export default async function applyLearningImpl({ kv, todayYmd, candidates }) {
  // 1) score/select (you already have your logic; keep it)
  const finalList = Array.isArray(candidates) ? candidates.filter(Boolean) : [];

  // 2) HARDEN TIER and normalize items (no crashes)
  const normalize = (it) => {
    const fixture = it.fixture || it;
    const safeTier = it.tier ?? it?.league?.tier ?? it?.tierGuess ?? null;
    return {
      id: fixture?.id ?? it.id,
      league: it.league?.name ?? it.league ?? null,
      home: it.home?.name ?? it.home ?? fixture?.teams?.home?.name ?? null,
      away: it.away?.name ?? it.away ?? fixture?.teams?.away?.name ?? null,
      ko: it.ko ?? it.datetime ?? fixture?.date ?? null,
      market: it.market ?? null,
      pick: it.pick ?? it.selection ?? null,
      odds: it.odds ?? it.price ?? null,
      confidence: it.confidence ?? it.conf ?? null,
      tier: safeTier,
    };
  };

  const normalized = finalList.map(normalize);

  // 3) WRITE the canonical daily lock
  const lockKey = `vb:day:${todayYmd}:last`;
  await kv.set(lockKey, JSON.stringify({ items: normalized, ymd: todayYmd, ts: new Date().toISOString() }));

  // 4) WRITE history snapshot (compact, read-only)
  const historyKey = `vb:history:${todayYmd}`;
  const historyDoc = normalized.map((x) => ({
    id: x.id, league: x.league, home: x.home, away: x.away,
    ko: x.ko, market: x.market, pick: x.pick, odds: x.odds, confidence: x.confidence, tier: x.tier
  }));
  await kv.set(historyKey, JSON.stringify({ items: historyDoc, ymd: todayYmd }));

  // 5) Minimal telemetry (so you can see why list might be empty)
  const t = { t1: 0, t2: 0, t3: 0, nullish: 0 };
  for (const x of normalized) {
    if (x.tier === 1) t.t1++; else if (x.tier === 2) t.t2++; else if (x.tier === 3) t.t3++; else t.nullish++;
  }
  await kv.set(`vb:telemetry:tiers:${todayYmd}`, JSON.stringify({ ...t, total: normalized.length, ymd: todayYmd }));

  return { ok: true, ymd: todayYmd, count: normalized.length };
}
