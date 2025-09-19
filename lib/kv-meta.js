function describeType(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function isEmptyValue(value) {
  if (value == null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function detectArraySource(input) {
  if (Array.isArray(input)) return "self";
  if (input && typeof input === "object") {
    if (Array.isArray(input.items)) return "items";
    if (Array.isArray(input.history)) return "history";
    if (Array.isArray(input.list)) return "list";
  }
  return "none";
}

function attemptParse(source) {
  if (typeof source !== "string") {
    return { parsed: false };
  }
  const trimmed = source.trim();
  if (!trimmed) {
    return { parsed: false };
  }
  try {
    JSON.parse(trimmed);
    return { parsed: true };
  } catch {
    return { parsed: false, error: "invalid_json" };
  }
}

export function jsonMeta(source, value) {
  const sourceType = describeType(source);
  const valueType = describeType(value);
  const { parsed, error } = attemptParse(source);
  const meta = {
    sourceType,
    valueType,
    sourceIsString: sourceType === "string",
    sourceIsObject: sourceType === "object",
    sourceIsArray: sourceType === "array",
    valueIsObject: valueType === "object",
    valueIsArray: valueType === "array",
    parsed,
    empty: isEmptyValue(value),
  };
  if (error) meta.error = error;
  return meta;
}

export function arrayMeta(sourceValue, array, baseMeta) {
  const meta = baseMeta ? { ...baseMeta } : jsonMeta(sourceValue, sourceValue);
  meta.valueType = "array";
  meta.valueIsArray = true;
  meta.valueIsObject = false;
  meta.empty = Array.isArray(array) ? array.length === 0 : true;
  meta.arraySource = detectArraySource(sourceValue);
  meta.length = Array.isArray(array) ? array.length : 0;
  return meta;
}
