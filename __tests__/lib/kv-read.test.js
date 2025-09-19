import { arrFromAny, toJson } from "../../lib/kv-read";

describe("toJson", () => {
  test("returns null for null inputs", () => {
    expect(toJson(null)).toBeNull();
    expect(toJson(undefined)).toBeNull();
  });

  test("returns objects unchanged", () => {
    const payload = { foo: "bar", nested: { value: 42 } };
    expect(toJson(payload)).toBe(payload);
  });

  test("parses JSON strings and ignores invalid ones", () => {
    expect(toJson('{"foo":1}')).toEqual({ foo: 1 });
    expect(toJson("{not:'valid'}")).toBeNull();
  });
});

describe("arrFromAny", () => {
  test("returns the input array when given an array", () => {
    const arr = [1, 2, 3];
    expect(arrFromAny(arr)).toBe(arr);
  });

  test("pulls from items/history/list arrays", () => {
    expect(arrFromAny({ items: [{ id: 1 }] })).toEqual([{ id: 1 }]);
    expect(arrFromAny({ history: [{ id: 2 }] })).toEqual([{ id: 2 }]);
    expect(arrFromAny({ list: [{ id: 3 }] })).toEqual([{ id: 3 }]);
  });

  test("falls back to empty array when nothing matches", () => {
    expect(arrFromAny({})).toEqual([]);
    expect(arrFromAny({ items: null, history: null })).toEqual([]);
    expect(arrFromAny("oops")).toEqual([]);
  });
});
