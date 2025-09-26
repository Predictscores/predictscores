// pages/api/debug/tiers.js

import { readTierMetrics } from "../../../lib/kv-meta";
import { runFootballSelector } from "../football";

export const config = { api: { bodyParser: false } };

function normalizeSlot(value) {
  if (typeof value !== "string") return "";
  const lower = value.trim().toLowerCase();
  return ["late", "am", "pm"].includes(lower) ? lower : "";
}

function normalizeYmd(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : "";
}

export default async function handler(req, res) {
  try {
    const rawYmd = normalizeYmd(String(req.query?.ymd ?? ""));
    const rawSlot = normalizeSlot(req.query?.slot);

    if (rawYmd && rawSlot) {
      const result = await runFootballSelector({
        ymd: rawYmd,
        slot: rawSlot,
        wantDebug: true,
        storeMetrics: false,
      });

      const summary = {
        ...result.summary,
        ymd: result.ymd,
        slot: result.slot,
        recordedAt: new Date().toISOString(),
      };

      return res.status(200).json({
        ok: true,
        mode: "recomputed",
        summary,
        debug: { reads: result.reads },
      });
    }

    const stored = await readTierMetrics();
    if (stored) {
      return res.status(200).json({
        ok: true,
        mode: "stored",
        summary: stored,
      });
    }

    return res.status(200).json({ ok: true, mode: "missing", summary: null });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String(err?.message || err) });
  }
}
