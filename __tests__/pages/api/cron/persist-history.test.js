import { persistHistory } from "../../../../pages/api/cron/apply-learning.impl.js";

describe("persistHistory", () => {
  test("writes arrays to both history keys", async () => {
    const writes = [];
    const kvClient = {
      setJSON: jest.fn(async (key, value) => {
        writes.push({ key, value });
        return { ok: true, saves: [{ flavor: "mock", ok: true }] };
      }),
    };
    const trace = [];
    const history = [{ id: 1 }, { id: 2 }];

    await expect(
      persistHistory("2024-07-04", history, trace, [], { slot: "am", kvClient })
    ).resolves.toBeUndefined();

    expect(kvClient.setJSON).toHaveBeenCalledTimes(2);
    expect(writes.map((entry) => entry.key)).toEqual([
      "hist:2024-07-04",
      "hist:day:2024-07-04",
    ]);
    for (const entry of writes) {
      expect(Array.isArray(entry.value)).toBe(true);
      expect(entry.value).toEqual(history);
    }
    const okEntries = trace.filter((item) => item.ok === true);
    expect(okEntries).toHaveLength(2);
    expect(okEntries.map((entry) => entry.scope)).toEqual(["list", "day"]);
  });

  test("records failures without throwing", async () => {
    const kvClient = {
      setJSON: jest
        .fn()
        .mockImplementationOnce(async () => ({ ok: true, saves: [] }))
        .mockImplementationOnce(async () => {
          throw new Error("boom");
        }),
    };
    const trace = [];
    const history = [{ id: 1 }];

    await expect(
      persistHistory("2024-07-05", history, trace, [], { kvClient })
    ).resolves.toBeUndefined();

    expect(kvClient.setJSON).toHaveBeenCalledTimes(2);
    const failure = trace.find((entry) => entry.ok === false && entry.key === "hist:day:2024-07-05");
    expect(failure).toBeTruthy();
    expect(failure.error).toContain("boom");
  });
});
