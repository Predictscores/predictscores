// pages/api/history.js
import { fetchHistoryAggregation, isValidYmd } from "../../lib/server/history-loader";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  try {
    const qYmd = String(req.query.ymd || "").trim();
    const qDaysRaw = String(req.query.days || "").trim();

    const params = { includeDebug: true };
    if (isValidYmd(qYmd)) {
      params.ymd = qYmd;
    } else {
      const qDays = Number.parseInt(qDaysRaw, 10);
      if (!Number.isFinite(qDays) || qDays <= 0) {
        return res
          .status(200)
          .json({ ok: false, error: "Provide ymd=YYYY-MM-DD or days=<N>" });
      }
      params.days = qDays;
    }

    const data = await fetchHistoryAggregation(params);
    return res.status(200).json(data);
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
