import { arrayMeta, jsonMeta } from "./kv-meta";

function normalizePrimitiveValue(val) {
  if (typeof val === "number" || typeof val === "boolean") {
    return val;
  }
  if (val == null) {
    return null;
  }
  return null;
}

export function toJson(val) {
  let value;
  let parseFailed = false;

  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed) {
      value = null;
    } else {
      try {
        value = JSON.parse(trimmed);
      } catch {
        value = null;
        parseFailed = true;
      }
    }
  } else if (val && typeof val === "object") {
    value = val;
  } else {
    value = normalizePrimitiveValue(val);
  }

  const meta = jsonMeta(val, value);
  if (parseFailed) {
    meta.error = "invalid_json";
    meta.parsed = false;
  }

  return { value, meta };
}

function isWrappedJson(input) {
  return (
    input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    Object.prototype.hasOwnProperty.call(input, "value") &&
    Object.prototype.hasOwnProperty.call(input, "meta") &&
    typeof input.meta === "object"
  );
}

export function arrFromAny(input) {
  let sourceValue = input;
  let baseMeta = null;

  if (isWrappedJson(input)) {
    baseMeta = input.meta;
    sourceValue = input.value;
  }

  let array = [];

  if (Array.isArray(sourceValue)) {
    array = sourceValue;
  } else if (sourceValue && typeof sourceValue === "object") {
    if (Array.isArray(sourceValue.items)) {
      array = sourceValue.items;
    } else if (Array.isArray(sourceValue.history)) {
      array = sourceValue.history;
    } else if (Array.isArray(sourceValue.list)) {
      array = sourceValue.list;
    }
  }

  const meta = arrayMeta(sourceValue ?? null, array, baseMeta);
  return { array, meta };
}
