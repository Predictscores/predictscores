export type ArraySource = "self" | "items" | "history" | "list" | "none";

export interface JsonReadMeta {
  sourceType: string;
  valueType: string;
  sourceIsString: boolean;
  sourceIsObject: boolean;
  sourceIsArray: boolean;
  valueIsObject: boolean;
  valueIsArray: boolean;
  parsed: boolean;
  empty: boolean;
  error?: string;
}

export interface JsonReadResult<T = unknown> {
  value: T | null;
  meta: JsonReadMeta;
}

export interface ArrayReadMeta extends JsonReadMeta {
  arraySource: ArraySource;
  length: number;
}

export interface ArrayReadResult<T = unknown> {
  array: T[];
  meta: ArrayReadMeta;
}

function describeType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function isEmptyValue(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length === 0;
  return false;
}

function buildMeta(source: unknown, value: unknown, options: { parsed?: boolean; error?: string } = {}): JsonReadMeta {
  const sourceType = describeType(source);
  const valueType = describeType(value);
  const meta: JsonReadMeta = {
    sourceType,
    valueType,
    sourceIsString: sourceType === "string",
    sourceIsObject: sourceType === "object",
    sourceIsArray: sourceType === "array",
    valueIsObject: valueType === "object",
    valueIsArray: valueType === "array",
    parsed: Boolean(options.parsed),
    empty: isEmptyValue(value),
  };
  if (options.error) meta.error = options.error;
  return meta;
}

export function toJson<T = unknown>(val: unknown): JsonReadResult<T> {
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed) {
      return { value: null, meta: buildMeta(val, null, { parsed: false }) };
    }
    try {
      const parsed = JSON.parse(trimmed) as T;
      return { value: parsed, meta: buildMeta(val, parsed, { parsed: true }) };
    } catch {
      return { value: null, meta: buildMeta(val, null, { parsed: false, error: "invalid_json" }) };
    }
  }

  if (val && typeof val === "object") {
    return { value: val as T, meta: buildMeta(val, val, { parsed: false }) };
  }

  if (typeof val === "number" || typeof val === "boolean") {
    return { value: null, meta: buildMeta(val, null, { parsed: false }) };
  }

  return { value: null, meta: buildMeta(val, null, { parsed: false }) };
}

export function arrFromAny<T = unknown>(input: unknown, jsonMeta?: JsonReadMeta): ArrayReadResult<T> {
  let array: T[] = [];
  let arraySource: ArraySource = "none";

  if (Array.isArray(input)) {
    array = input as T[];
    arraySource = "self";
  } else if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (Array.isArray(obj.items)) {
      array = obj.items as T[];
      arraySource = "items";
    } else if (Array.isArray(obj.history)) {
      array = obj.history as T[];
      arraySource = "history";
    } else if (Array.isArray(obj.list)) {
      array = obj.list as T[];
      arraySource = "list";
    }
  }

  const baseMeta = jsonMeta ? { ...jsonMeta } : buildMeta(input, input, { parsed: false });
  const meta: ArrayReadMeta = {
    ...baseMeta,
    valueType: "array",
    valueIsArray: true,
    valueIsObject: false,
    empty: array.length === 0,
    arraySource,
    length: array.length,
  };

  return { array, meta };
}
