// pages/api/crypto-history-day.js
import { arrFromAny, toJson } from "../../lib/kv-read";

export const config = { api: { bodyParser: false } };

// ---- KV helpers ----
function kvBackends() {
  const out = [];
  const aU = process.env.KV_REST_API_URL, aT = process.env.KV_REST_API_TOKEN;
  const bU = process.env.UPSTASH_REDIS_REST_URL, bT = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (aU && aT) out.push({ flavor: "vercel-kv", url: aU.replace(/\/+$/, ""), tok: aT });
  if (bU && bT) out.push({ flavor: "upstash-redis", url: bU.replace(/\/+$/, ""), tok: bT });
  return out;
}
async function kvGETvalue(key) {
  for (const b of kvBackends()) {
    try {
      const r = await fetch(`${b.url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${b.tok}` },
        cache: "no-store",
      });
      const j = await r.json().catch(() => null);
      const res = j && ("result" in j ? j.result : j);
      const obj = toJson(res);
      if (!r.ok) continue;
      return { obj, flavor: b.flavor, kvResult: res };
    } catch {}
  }
  return { obj: null, flavor: null, kvResult: null };
}

const isValidYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

// TZ helpers
function pickTZ() {
  const raw = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: raw });
    return raw;
  } catch {
    return "Europe/Belgrade";
  }
}
const TZ = pickTZ();
const ymdInTZ = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);

// ---- normalize timestamps: seconds / ms / microseconds / ISO ----
function toDateFlexible(ts) {
  if (ts == null) return null;

  if (typeof ts === "string" && /\D/.test(ts)) {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const n0 = Number(ts);
  if (!Number.isFinite(n0)) return null;

  let n = n0;

  if (n < 1e11) n *= 1000;

  while (n > 4e12) n = Math.floor(n / 10);

  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d;
}

export default async function handler(req, res) {
  try {
    const qYmd = String(req.query.ymd || "").trim();
    if (!isValidYmd(qYmd)) {
      return res.status(200).json({ ok: false, error: "Provide ymd=YYYY-MM-DD" });
    }

    const wantDebug = String(req.query?.debug || "") === "1";

    const idxData = await kvGETvalue("crypto:history:index");
    const idxArr = arrFromAny(idxData.obj);
    const ids = idxArr.slice(-800).reverse();

    let debugFlavor = idxData.flavor;
    let debugResult = idxData.kvResult;

    const items = [];
    for (const id of ids) {
      const itData = await kvGETvalue(`crypto:history:item:${id}`);
      if (!debugFlavor && itData.flavor) debugFlavor = itData.flavor;
      if (debugResult === undefined && itData.kvResult !== undefined) debugResult = itData.kvResult;
      const itValue = itData.obj;
      const it = itValue && typeof itValue === "object" ? itValue : null;
      if (!it) continue;

      const d =
        toDateFlexible(it.ts) ||
        toDateFlexible(it.evaluated_ts) ||
        toDateFlexible(it.valid_until);

      if (!d) continue;

      const y = ymdInTZ(d, TZ);
      if (y === qYmd) {
        items.push({
          id,
          ts: it.ts ?? null,
          symbol: it.symbol || it.symbol1 || it.ticker,
          name: it.name || null,
          exchange: it.exchange || null,
          pair: it.pair || null,
          side: it.side || null,
          entry: it.entry ?? null,
          sl: it.sl ?? null,
          tp: it.tp ?? null,
          rr: it.rr ?? null,
          confidence_pct: it.confidence_pct ?? null,
          valid_until: it.valid_until ?? null,
          outcome: it.outcome || null,
          win:
            typeof it.win !== "undefined"
              ? it.win
              : typeof it.won !== "undefined"
              ? it.won
              : null,
          exit_price: it.exit_price ?? null,
          realized_rr: it.realized_rr ?? null,
          evaluated_ts: it.evaluated_ts ?? null,
        });
      } else if (items.length && y !== qYmd) {
        break;
      }
    }

    const decided = items.filter((i) => i.outcome === "tp" || i.outcome === "sl");
    const wins = decided.filter((i) => i.outcome === "tp").length;
    const avgRR = decided.length
      ? decided.reduce((s, i) => s + (Number(i.realized_rr) || 0), 0) / decided.length
      : null;
    const medianRR = decided.length
      ? decided.map((i) => Number(i.realized_rr) || 0).sort((a, b) => a - b)[Math.floor(decided.length / 2)]
      : null;
    const winRate = decided.length ? Math.round((100 * wins) / decided.length) : null;

    const payload = {
      ok: true,
      ymd: qYmd,
      tz: TZ,
      totals: {
        count: items.length,
        decided: decided.length,
        win_rate_pct: winRate,
        avg_rr: avgRR,
        median_rr: medianRR,
      },
      items,
    };

    if (wantDebug) {
      payload.debug = {
        sourceFlavor: debugFlavor || "unknown",
        kvObject: typeof debugResult === "object",
      };
    }

    return res.status(200).json(payload);
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
