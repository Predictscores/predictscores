import { arrFromAny, toJson } from "../../lib/kv-read";

describe("toJson", () => {
  test("returns null metadata for null inputs", () => {
    const result = toJson(null);

    expect(result.value).toBeNull();
    expect(result.meta.sourceType).toBe("null");
    expect(result.meta.valueType).toBe("null");
    expect(result.meta.parsed).toBe(false);
    expect(result.meta.empty).toBe(true);
  });

  test("returns plain objects as-is without parsing", () => {
    const payload = { foo: "bar", nested: { value: 42 } };
    const result = toJson(payload);

    expect(result.value).toBe(payload);
    expect(result.meta.sourceIsObject).toBe(true);
    expect(result.meta.valueIsObject).toBe(true);
    expect(result.meta.parsed).toBe(false);
    expect(result.meta.empty).toBe(false);
  });

  test("gracefully handles invalid JSON strings", () => {
    const result = toJson("{not: 'valid'}");

    expect(result.value).toBeNull();
    expect(result.meta.sourceIsString).toBe(true);
    expect(result.meta.parsed).toBe(false);
    expect(result.meta.error).toBe("invalid_json");
  });
});

describe("arrFromAny", () => {
  test("returns direct arrays with self source metadata", () => {
    const input = [1, 2, 3];
    const result = arrFromAny(input);

    expect(result.array).toBe(input);
    expect(result.meta.arraySource).toBe("self");
    expect(result.meta.length).toBe(3);
    expect(result.meta.valueIsArray).toBe(true);
  });

  test("uses items arrays when available", () => {
    const input = { items: [{ id: 1 }] };
    const result = arrFromAny(input);

    expect(result.array).toEqual(input.items);
    expect(result.meta.arraySource).toBe("items");
    expect(result.meta.length).toBe(1);
    expect(result.meta.valueIsObject).toBe(false);
  });

  test("falls back to history arrays when items is not an array", () => {
    const input = { items: null, history: [{ id: 2 }] };
    const result = arrFromAny(input);

    expect(result.array).toEqual(input.history);
    expect(result.meta.arraySource).toBe("history");
    expect(result.meta.length).toBe(1);
  });

  test("falls back to list arrays when other keys are unavailable", () => {
    const input = { items: "x", history: {}, list: [{ id: 3 }] };
    const result = arrFromAny(input);

    expect(result.array).toEqual(input.list);
    expect(result.meta.arraySource).toBe("list");
    expect(result.meta.length).toBe(1);
  });
});
