export function toJson(val) {
  if (val == null) return null;
  if (typeof val === "object") return val; // Upstash/Vercel KV may return objects directly
  if (typeof val === "string") { try { return JSON.parse(val); } catch { return null; } }
  return null;
}
export function arrFromAny(x) {
  if (Array.isArray(x)) return x;
  if (x && typeof x === "object") {
    if (Array.isArray(x.items)) return x.items;
    if (Array.isArray(x.history)) return x.history;
    if (Array.isArray(x.list)) return x.list;
  }
  return [];
}
