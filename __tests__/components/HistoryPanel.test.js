import { sortAndLimitHistoryItems } from "../../components/HistoryPanel";

describe("sortAndLimitHistoryItems", () => {
  test("orders newest kickoff first before applying top limit", () => {
    const rawItems = [
      { fixture_id: "old", kickoff: "2024-06-10T12:00:00Z" },
      { fixture_id: "newer", kickoff: "2024-06-10T15:00:00Z" },
      { fixture_id: "old-day", kickoff: "2024-06-09T20:00:00Z" },
    ];

    const limited = sortAndLimitHistoryItems(rawItems, 2);
    expect(limited.map((it) => it.fixture_id)).toEqual(["newer", "old"]);
  });

  test("falls back to ymd/slot ordering and keeps stability for same-slot items", () => {
    const rawItems = [
      { fixture_id: "day-old-am", ymd: "2024-06-09", slot: "am" },
      { fixture_id: "day-old-pm", ymd: "2024-06-09", slot: "pm" },
      { fixture_id: "new-am-a", ymd: "2024-06-10", slot: "am" },
      { fixture_id: "new-am-b", ymd: "2024-06-10", slot: "am" },
      { fixture_id: "new-pm", ymd: "2024-06-10", slot: "pm" },
    ];

    const limited = sortAndLimitHistoryItems(rawItems, 3);
    expect(limited.map((it) => it.fixture_id)).toEqual([
      "new-pm",
      "new-am-a",
      "new-am-b",
    ]);
  });
});
