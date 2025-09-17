import { evalPick, normalizeMarketPick } from "../lib/learning/eval";

describe("normalizeMarketPick", () => {
  test("normalizes 1X2 market and code", () => {
    const pick = normalizeMarketPick({ market: "1x2", pick_code: "1" });
    expect(pick).toEqual({ market: "1X2", pick_code: "1" });
  });

  test("normalizes BTTS codes with prefix", () => {
    const pick = normalizeMarketPick({ market: "BTTS", pick_code: "BTTS:Y" });
    expect(pick).toEqual({ market: "BTTS", pick_code: "Y" });
  });

  test("normalizes OU2.5 decimal codes", () => {
    const pick = normalizeMarketPick({ market: "OU2.5", pick_code: "O2.5" });
    expect(pick).toEqual({ market: "OU2.5", pick_code: "O" });
  });

  test("normalizes HTFT prefixed codes", () => {
    const pick = normalizeMarketPick({ market: "HTFT", pick_code: "HTFT:HH" });
    expect(pick).toEqual({ market: "HTFT", pick_code: "HH" });
  });
});

describe("evalPick", () => {
  test("evaluates 1X2 home win", () => {
    const pick = normalizeMarketPick({ market: "1x2", pick_code: "1" });
    const score = { ftH: 2, ftA: 0, htH: 1, htA: 0 };
    expect(evalPick(pick, score, { normalized: true })).toBe(1);
  });

  test("evaluates OU2.5 over and under", () => {
    const overPick = normalizeMarketPick({ market: "OU2.5", pick_code: "O2.5" });
    const underPick = normalizeMarketPick({ market: "OU2.5", pick_code: "U2.5" });
    const overScore = { ftH: 3, ftA: 1, htH: 2, htA: 0 };
    const underScore = { ftH: 1, ftA: 1, htH: 0, htA: 0 };
    expect(evalPick(overPick, overScore, { normalized: true })).toBe(1);
    expect(evalPick(underPick, underScore, { normalized: true })).toBe(1);
  });

  test("evaluates BTTS yes/no variants", () => {
    const yesPick = normalizeMarketPick({ market: "BTTS", pick_code: "BTTS:Y" });
    const noPick = normalizeMarketPick({ market: "BTTS", pick_code: "BTTS:N" });
    const yesScore = { ftH: 2, ftA: 1, htH: 1, htA: 1 };
    const noScore = { ftH: 2, ftA: 0, htH: 1, htA: 0 };
    expect(evalPick(yesPick, yesScore, { normalized: true })).toBe(1);
    expect(evalPick(noPick, noScore, { normalized: true })).toBe(1);
    expect(evalPick(yesPick, noScore, { normalized: true })).toBe(0);
  });

  test("evaluates HTFT selections with prefixes", () => {
    const pick = normalizeMarketPick({ market: "HT-FT", pick_code: "HTFT:HH" });
    const score = { ftH: 2, ftA: 1, htH: 1, htA: 0 };
    expect(evalPick(pick, score, { normalized: true })).toBe(1);
    const miss = normalizeMarketPick({ market: "HTFT", pick_code: "HTFT:HD" });
    expect(evalPick(miss, score, { normalized: true })).toBe(0);
  });

  test("parses stringified score payloads", () => {
    const pick = normalizeMarketPick({ market: "BTTS", pick_code: "BTTS:Y" });
    const score = JSON.stringify({ ftH: 1, ftA: 1, htH: 0, htA: 0 });
    expect(evalPick(pick, score, { normalized: true })).toBe(1);
  });
});
