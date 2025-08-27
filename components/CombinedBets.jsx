// FOOTBALL — locked → fallback(24h) + BAN i short cache u fallbacku
useEffect(() => {
  let stop = false;
  (async () => {
    // 1) LOCKED
    const locked = await safeJson("/api/value-bets-locked");
    if (stop) return;
    const list = Array.isArray(locked?.items || locked?.value_bets) ? (locked.items || locked.value_bets) : [];
    if (list.length > 0) {
      setFootball(list);
      setLoading(s => ({ ...s, fb:false }));
      return;
    }

    // 2) FALLBACK sa localStorage cache (120s)
    const cacheKey = "fb_fallback_cache_v1";
    const TTL_MS = 120 * 1000;
    try {
      const raw = localStorage.getItem(cacheKey);
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && Array.isArray(obj.data) && (Date.now() - obj.ts) < TTL_MS) {
          setFootball(obj.data);
          setLoading(s => ({ ...s, fb:false }));
          return;
        }
      }
    } catch {}

    const live = await safeJson("/api/football?hours=24");
    if (stop) return;
    const arr = Array.isArray(live?.football) ? live.football : [];
    const filtered = arr.filter(m => !BAN_REGEX.test(m?.league?.name || ""));

    setFootball(filtered);
    setLoading(s => ({ ...s, fb:false }));

    try {
      localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: filtered }));
    } catch {}
  })();

  return () => { stop = true; };
}, []);
