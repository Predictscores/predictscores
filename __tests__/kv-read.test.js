import { arrFromAny, toJson } from "../lib/kv-read";

describe("toJson", () => {
  it("returns objects unchanged", () => {
    const obj = { a: 1 };
    expect(toJson(obj)).toBe(obj);
  });

  it("parses JSON strings", () => {
    expect(toJson('{"x":42}')).toEqual({ x: 42 });
  });

  it("returns null for invalid inputs", () => {
    expect(toJson("nope")).toBeNull();
    expect(toJson(null)).toBeNull();
  });
});

describe("arrFromAny", () => {
  it("returns arrays as-is", () => {
    const arr = [1, 2, 3];
    expect(arrFromAny(arr)).toBe(arr);
  });

  it("extracts items-like properties", () => {
    expect(arrFromAny({ items: [1] })).toEqual([1]);
    expect(arrFromAny({ history: [2] })).toEqual([2]);
    expect(arrFromAny({ list: [3] })).toEqual([3]);
  });

  it("falls back to empty array", () => {
    expect(arrFromAny({ foo: [1] })).toEqual([]);
    expect(arrFromAny(undefined)).toEqual([]);
  });
});
