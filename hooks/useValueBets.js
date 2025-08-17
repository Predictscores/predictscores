// FILE: hooks/useValueBets.js
// Hook za čitanje zaključanog feeda sa pametnim keširanjem.
// - Ne kešira prazne rezultate
// - Ključ keša: vb_locked_<YYYY-MM-DD>
// - TTL 5 min + stale-while-revalidate
// - Auto-retry kada API signalizuje ensure-started/ensure-wait ili ako je lista prazna
// - Radi i kada je SMART45_FLOAT_ENABLED=1 (overlay polja samo prosleđujemo)

import { useEffect, useMemo, useRef, useState } from "react";

const TZ = "Europe/Belgrade";
const TTL_MS = 5 * 60 * 1000; // 5 min
const LS_PREFIX = "vb_locked_";

/** Vrati YYYY-MM-DD u Europe/Belgrade */
function todayYMD() {
  try {
    const d = new Date();
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    });
    return fmt.format(d); // 2025-08-17
  } catch {
    // fallback bez vremenske zone
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }
}

function readLS(key) {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeLS(key, value) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function removeLS(key) {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(key);
  } catch {}
}

/**
 * useValueBets
 * options:
 *   - forceNoCache: bool (za debug)
 *   - retryMs: broj ms za auto-retry (default 25000)
 */
export default function useValueBets(options = {}) {
  const retryMs = typeof options.retryMs === "number" ? options.retryMs : 25000;
  const forceNoCache = !!options.forceNoCache;

  const [bets, setBets] = useState([]);
  const [meta, setMeta] = useState(null);
  const [source, setSource] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshedAt, setRefreshedAt] = useState(null);

  const abortRef = useRef(null);
  const retryTimer = useRef(null);

  const lsKey = useMemo(() => `${LS_PREFIX}${todayYMD()}`, []);

  useEffect(() => {
    // SSR guard
    if (typeof window === "undefined") return;

    // Ako postoji validan keš i nije istekao — prikaži odmah (SWV će svakako povući sveže)
    if (!forceNoCache) {
      const cached = readLS(lsKey);
      if (cached && Array.isArray(cached.data)) {
        const freshEnough = Date.now() - (cached.ts || 0) < TTL_MS;
        if (freshEnough) {
          setBets(cached.data || []);
          setMeta(cached.meta || null);
          setSource("cache");
          setLoading(false);
        }
      }
    }

    // Stale-While-Revalidate: uvek povuci sveže u pozadini
    const controller = new AbortController();
    abortRef.current = controller;

    const fetchNow = async () => {
      try {
        const r = await fetch("/api/value-bets-locked", {
          cache: "no-store",
          signal: controller.signal,
        });
        const j = await r.json();

        const arr = Array.isArray(j?.value_bets) ? j.value_bets : [];
        const apiDay = j?.day || todayYMD();
        const apiSource = j?.source || "network";

        // Ako je odgovor za drugi dan (posle ponoći), promeni ključ i očisti stari
        if (apiDay !== todayYMD()) {
          const newKey = `${LS_PREFIX}${apiDay}`;
          removeLS(lsKey);
          // prebacujemo keš na novi dan (ako imamo podatke)
          if (arr.length > 0) {
            writeLS(newKey, { ts: Date.now(), day: apiDay, data: arr, meta: j?.meta || null });
          }
        } else {
          // Ako imamo LISTU — ažuriraj state; keširaj samo ako NIJE prazno
          if (arr.length > 0) {
            writeLS(lsKey, { ts: Date.now(), day: apiDay, data: arr, meta: j?.meta || null });
          }
        }

        // Uvek prikaži najnovije stanje iz mreže (i ako je prazno — prikaži prazno,
        // ali ga NE upisujemo u keš, da se ne “zalepi”)
        setBets(arr);
        setMeta(j?.meta || null);
        setSource(apiSource);
        setError(null);
        setRefreshedAt(new Date().toISOString());
        setLoading(false);

        // Auto-retry: ako je ensure-* signal ili je prazno, pokušaj opet posle kratkog vremena
        const ensure = apiSource === "ensure-started" || apiSource === "ensure-wait";
        if (ensure || arr.length === 0) {
          if (retryTimer.current) clearTimeout(retryTimer.current);
          retryTimer.current = setTimeout(() => {
            // mala “ping” provera bez rušenja UI-ja
            refetch();
          }, retryMs);
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(String(e?.message || e));
        setLoading(false);
        // u slučaju greške probaj blagi retry
        if (retryTimer.current) clearTimeout(retryTimer.current);
        retryTimer.current = setTimeout(() => {
          refetch();
        }, retryMs);
      }
    };

    fetchNow();

    return () => {
      try { controller.abort(); } catch {}
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lsKey, forceNoCache]);

  const refetch = async () => {
    if (abortRef.current) {
      try { abortRef.current.abort(); } catch {}
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/value-bets-locked", {
        cache: "no-store",
        signal: controller.signal,
      });
      const j = await r.json();
      const arr = Array.isArray(j?.value_bets) ? j.value_bets : [];
      const apiDay = j?.day || todayYMD();

      if (apiDay === todayYMD() && arr.length > 0) {
        writeLS(lsKey, { ts: Date.now(), day: apiDay, data: arr, meta: j?.meta || null });
      }

      setBets(arr);
      setMeta(j?.meta || null);
      setSource(j?.source || "network");
      setRefreshedAt(new Date().toISOString());
      setLoading(false);

      const ensure = j?.source === "ensure-started" || j?.source === "ensure-wait";
      if (ensure || arr.length === 0) {
        if (retryTimer.current) clearTimeout(retryTimer.current);
        retryTimer.current = setTimeout(() => {
          refetch();
        }, 20000);
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(String(e?.message || e));
      setLoading(false);
    }
  };

  return { bets, meta, source, loading, error, refreshedAt, refetch, clearCache: () => removeLS(lsKey) };
}
