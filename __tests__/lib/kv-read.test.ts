import { arrFromAny, toJson } from "../../lib/kv-read";

describe("toJson", () => {
  it("parses JSON strings", () => {
    const payload = toJson('{"items":[{"id":1}]}');
    expect(payload).toEqual({ items: [{ id: 1 }] });
  });

  it("returns objects unchanged", () => {
    const obj = { items: [{ id: 2 }] };
    expect(toJson(obj)).toBe(obj);
  });

  it("returns null for malformed JSON", () => {
    expect(toJson("not-json")).toBeNull();
  });
});

describe("arrFromAny", () => {
  it("returns arrays unchanged", () => {
    const arr = [{ id: "direct" }];
    expect(arrFromAny(arr)).toBe(arr);
  });

  it("extracts items from nested objects", () => {
    const base = [{ id: "nested" }];
    expect(arrFromAny({ items: base })).toBe(base);
  });

  it("reads history lists", () => {
    const base = [{ id: "history" }];
    expect(arrFromAny({ history: base })).toBe(base);
  });

  it("reads list fallback", () => {
    const base = [{ id: "list" }];
    expect(arrFromAny({ list: base })).toBe(base);
  });

  it("returns an empty array for malformed input", () => {
    expect(arrFromAny({ other: [] })).toEqual([]);
    expect(arrFromAny(null)).toEqual([]);
    expect(arrFromAny(undefined)).toEqual([]);
  });
});
