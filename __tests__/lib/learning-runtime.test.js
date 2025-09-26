const {
  resolveOddsBand,
  resolveLeagueTier,
  resolveMarketBucket,
  applyCalibration,
  applyLeagueAdjustment,
  applyEvGuard,
  resolveDefaultEvGuard,
} = require("../../lib/learning/runtime");

describe("learning runtime helpers", () => {
  test("resolves odds bands", () => {
    expect(resolveOddsBand(1.52)).toBe("1.50-1.75");
    expect(resolveOddsBand("2.05")).toBe("1.76-2.20");
    expect(resolveOddsBand(2.60)).toBe("2.21+");
    expect(resolveOddsBand("not-a-number")).toBe("UNK");
  });

  test("resolves league tiers", () => {
    expect(resolveLeagueTier({ tier: 1 })).toBe("T1");
    expect(resolveLeagueTier({ tier_level: "2" })).toBe("T2");
    expect(resolveLeagueTier({ id: 39 })).toBe("T1");
    expect(resolveLeagueTier({ name: "English Championship" })).toBe("T2");
    expect(resolveLeagueTier({ name: "Random League" })).toBe("T3");
  });

  test("respects tier overrides from config", () => {
    const config = {
      tier_overrides: {
        "id:555": "T1",
        mls: "T2",
      },
      tier1_ids: [777],
      tier2_ids: [888],
      TIER1_RE: "(Custom Tier One)",
      TIER2_RE: "(Custom Tier Two)",
    };

    expect(resolveLeagueTier({ id: 555 }, config)).toBe("T1");
    expect(resolveLeagueTier({ name: "MLS" }, config)).toBe("T2");
    expect(resolveLeagueTier({ id: 777 }, config)).toBe("T1");
    expect(resolveLeagueTier({ id: 888 }, config)).toBe("T2");
    expect(resolveLeagueTier({ name: "Custom Tier One" }, config)).toBe("T1");
    expect(resolveLeagueTier({ name: "Custom Tier Two" }, config)).toBe("T2");
  });

  test("normalizes market buckets", () => {
    expect(resolveMarketBucket("ou25")).toBe("OU2.5");
    expect(resolveMarketBucket("HT/FT")).toBe("HTFT");
    expect(resolveMarketBucket("1x2")).toBe("1X2");
    expect(resolveMarketBucket("unknown"))
      .toBe("UNKNOWN".toUpperCase());
  });

  test("applies logistic calibration with clamping", () => {
    const baseline = 0.55;
    const doc = {
      type: "logistic",
      intercept: 0.15,
      slope: 1.3,
      samples: 350,
    };
    const { prob, applied } = applyCalibration(baseline, doc);
    expect(applied).toBe(true);
    expect(prob).toBeGreaterThan(0.55);
    expect(prob).toBeLessThanOrEqual(0.62); // ±7pp clamp
  });

  test("ignores calibration with insufficient samples", () => {
    const res = applyCalibration(0.60, { type: "logistic", intercept: 0.1, slope: 1.1, samples: 120 });
    expect(res.prob).toBeCloseTo(0.60);
    expect(res.applied).toBe(false);
  });

  test("applies league adjustment and clamps", () => {
    const res = applyLeagueAdjustment(0.50, { delta_pp: 5.5, samples: 400 });
    expect(res.applied).toBe(true);
    expect(res.delta_pp).toBe(3); // clamped to ±3pp
    expect(res.prob).toBeCloseTo(0.53);
  });

  test("merges EV guard", () => {
    const base = resolveDefaultEvGuard("BTTS");
    const res = applyEvGuard(base, { ev_min: 0.05, samples: 500 });
    expect(res.guard_pp).toBeGreaterThanOrEqual(base);
    expect(res.guard_pp).toBeLessThanOrEqual(8);
    expect(res.applied).toBe(true);
  });
});
