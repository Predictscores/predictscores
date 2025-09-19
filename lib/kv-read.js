export function toJson(val) {
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  if (val && typeof val === "object") {
    return val;
  }

  if (typeof val === "number" || typeof val === "boolean") {
    return null;
  }

  return null;
}

export function arrFromAny(input) {
  if (Array.isArray(input)) {
    return input;
  }

  if (input && typeof input === "object") {
    if (Array.isArray(input.items)) {
      return input.items;
    }
    if (Array.isArray(input.history)) {
      return input.history;
    }
    if (Array.isArray(input.list)) {
      return input.list;
    }
  }

  return [];
}
