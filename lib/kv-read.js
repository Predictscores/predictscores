// lib/kv-read.js
// Helpers for reading KV payloads where values may be raw strings or JSON objects.

export function toJson(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const text = String(value);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (typeof value === "object") {
    return value;
  }
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

export function arrFromAny(input) {
  if (Array.isArray(input)) return input;
  if (input && typeof input === "object") {
    if (Array.isArray(input.items)) return input.items;
    if (Array.isArray(input.history)) return input.history;
    if (Array.isArray(input.list)) return input.list;
  }
  return [];
}

export default { toJson, arrFromAny };
