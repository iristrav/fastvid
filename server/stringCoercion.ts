/**
 * Coerce DB / LLM / metadata values to plain strings before .trim(), .split(), .toLowerCase().
 * Optional chaining only guards null/undefined — not wrong runtime types.
 */

const OBJECT_STRING_KEYS = ["title", "name", "text", "label", "value", "query"] as const;

/** Coerce unknown value to string or undefined when empty / unusable. */
export function coerceVisionString(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw;
  if (raw == null) return undefined;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  if (Array.isArray(raw)) {
    const parts = raw.map((item) => coerceVisionString(item)).filter(Boolean) as string[];
    return parts.length > 0 ? parts.join(" ") : undefined;
  }
  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    for (const key of OBJECT_STRING_KEYS) {
      const v = o[key];
      if (typeof v === "string" && v.trim()) return v;
    }
  }
  const fallback = String(raw);
  if (fallback === "[object Object]") return undefined;
  return fallback;
}

/** Always a plain string — safe for .toLowerCase() / .split(). */
export function asVideoTitleString(raw: unknown): string {
  return coerceVisionString(raw) ?? "";
}

/** Trimmed query string from any runtime value. */
export function toQueryString(raw: unknown): string {
  return asVideoTitleString(raw).trim();
}

/** Person / celebrity name from scene JSON or metadata. */
export function coercePersonName(raw: unknown): string {
  return toQueryString(raw);
}

export function queryStringsMinLen(parts: unknown[], minLen = 3): string[] {
  return parts.map(toQueryString).filter((s) => s.length >= minLen);
}

/** Dedupe after coercion. */
export function uniqueQueryStrings(parts: unknown[], minLen = 1): string[] {
  return [...new Set(parts.map(toQueryString).filter((s) => s.length >= minLen))];
}

/** Map + filter query list with optional predicate (e.g. isBlockedStockQuery). */
export function filterQueryStrings(
  parts: unknown[],
  minLen: number,
  predicate?: (s: string) => boolean
): string[] {
  return parts
    .map(toQueryString)
    .filter((s) => s.length >= minLen && (!predicate || predicate(s)));
}

/** Dedupe preserving first occurrence order. */
export function uniqueCoercedQueries(
  parts: unknown[],
  minLen: number,
  predicate?: (s: string) => boolean
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of parts) {
    const s = toQueryString(raw);
    if (s.length < minLen || (predicate && !predicate(s))) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}
