/** Visual Matching Engine V2 — shared LLM JSON-response parsing.
 *  invokeLLM's `content` is already a parsed object for providers that support strict JSON
 *  schema responses, but a raw string for providers that only return text — this normalizes
 *  either shape into T, or throws a labeled error the caller can log. Shared by every stage
 *  that asks the LLM for structured JSON (VideoContext, VisualIntent, ranked query
 *  expansion) so the parsing behavior stays identical across all of them. */
export function parseJson<T>(content: unknown, label: string): T {
  if (content && typeof content === "object") return content as T;
  const raw = typeof content === "string" ? content : JSON.stringify(content);
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`${label}: ${(err as Error).message}`);
  }
}
