// --- helpers at the bottom of pages/api/value-bets.js ---

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const UP_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// SINGLE-GET with proper fallback (do not return null too early)
async function kvGet(key) {
  if (KV_URL && KV_TOKEN) {
    try {
      const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
        cache: "no-store",
      });
      if (r.ok) {
        const j = await r.json().catch(() => null);
        if (j && j.result != null) return j.result; // only return if found
      }
    } catch {}
  }
  if (UP_URL && UP_TOKEN) {
    try {
      const r = await fetch(`${UP_URL}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${UP_TOKEN}` },
        cache: "no-store",
      });
      if (r.ok) {
        const j = await r.json().catch(() => null);
        if (j && j.result != null) return j.result;
      }
    } catch {}
  }
  return null;
}

// OPTIONAL: multi-get with fallback (if your file uses mget/pipeline)
async function kvMGet(keys = []) {
  const out = new Array(keys.length).fill(null);

  // try KV mget first
  if (KV_URL && KV_TOKEN && keys.length) {
    try {
      const body = { commands: keys.map(k => ["GET", k]) };
      const r = await fetch(`${KV_URL}/pipeline`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${KV_TOKEN}`,
          "content-type": "application/json",
        },
        cache: "no-store",
        body: JSON.stringify(body),
      });
      if (r.ok) {
        const arr = await r.json().catch(() => null);
        if (Array.isArray(arr)) {
          arr.forEach((x, i) => {
            const v = (x && x.result != null) ? x.result : null;
            out[i] = v;
          });
        }
      }
    } catch {}
  }

  // fill missing via Upstash
  if (UP_URL && UP_TOKEN && keys.length) {
    try {
      const missingIdx = out.map((v, i) => v == null ? i : -1).filter(i => i >= 0);
      if (missingIdx.length) {
        const commands = missingIdx.map(i => ["GET", keys[i]]);
        const r = await fetch(`${UP_URL}/pipeline`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${UP_TOKEN}`,
            "content-type": "application/json",
          },
          cache: "no-store",
          body: JSON.stringify({ commands }),
        });
        if (r.ok) {
          const arr = await r.json().catch(() => null);
          if (Array.isArray(arr)) {
            arr.forEach((x, j) => {
              const idx = missingIdx[j];
              const v = (x && x.result != null) ? x.result : null;
              out[idx] = v;
            });
          }
        }
      }
    } catch {}
  }

  return out;
}
