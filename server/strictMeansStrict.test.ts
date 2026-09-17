/**
 * STRICT MEANS STRICT — a narrow search that stays narrow all the way to the provider.
 *
 * ── What this protects ──────────────────────────────────────────────────────────────────────
 *
 * `strictQueries` is the caller's instruction that this beat's query is exact: search for THIS,
 * not for something adjacent to it. Two things in the stock path broaden a query, and strict mode
 * has to skip both:
 *
 *   1. `extraQueries` are appended, so the provider is asked for things the caller never named;
 *   2. `simplifyStockSearchWord` collapses a whole phrase to ONE token, and falls back to the
 *      literal word "documentary" when nothing survives — "hitler bunker berlin 1945" becomes a
 *      single generic word, which is exactly how a render fills up with wind turbines and cyclists.
 *
 * Both are honoured in `fetchPexelsClips` and `fetchPixabayClips`. Neither was covered by a test.
 * An implementation nothing asserts is an implementation the next refactor is free to drop, and
 * the failure would be invisible: the search still runs, still returns clips, and the clips are
 * simply about the wrong thing.
 *
 * ── How it is checked ───────────────────────────────────────────────────────────────────────
 *
 * At the transport. The one place a broadened query is unambiguous is the URL that leaves the
 * process, so the fetch module is mocked and the outbound `query=` parameter is read back. No
 * request reaches a real service, no provider response is invented — the body is empty and the
 * assertions are about what was ASKED, never about what came back.
 */
vi.hoisted(() => {
  /**
   * The provider keys are captured into module-level consts when videoPipeline is imported, so
   * they must exist before that import. Placeholders against a mocked transport; nothing here
   * reaches a real service, and no real credential appears in this file.
   */
  process.env.PEXELS_API_KEY = "strict-test-key-not-a-credential";
  process.env.PIXABAY_API_KEY = "strict-test-key-not-a-credential";
});

vi.mock("node-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node-fetch")>();
  return { ...actual, default: vi.fn(actual.default) };
});

import { readFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fetchModule from "node-fetch";

import { emptyQueryContext, withSearchProvenance } from "./searchQueryContract";
import { fetchPexelsClips, fetchPixabayClips } from "./videoPipeline";

const mockedFetch = vi.mocked(fetchModule);
const PIPELINE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

/**
 * A phrase with four content words, none of which is the phrase's own "simplest" token — so a
 * broadened search is visibly different from a strict one rather than accidentally equal.
 */
const PHRASE = "berlin bunker interior 1945";
const EXTRAS = ["cologne cathedral ruins", "nuremberg trial courtroom"];

/**
 * The beat these words came from, as a verified provenance scope.
 *
 * Not decoration. RONDE 90's SearchGate refuses any provider query built outside one —
 * `status=BLOCKED reason=LEGACY_QUERY_BUILDER` — so without this no request leaves the process at
 * all and the test would be asserting about a search that never happened. Running inside the scope
 * is what makes this the same path production takes.
 */
const BEAT_TEXT = `${PHRASE} ${EXTRAS.join(" ")}`;
const inScope = <T>(fn: () => Promise<T>): Promise<T> =>
  withSearchProvenance(emptyQueryContext(BEAT_TEXT), fn);

beforeEach(() => {
  mockedFetch.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  /** An empty, well-formed provider answer: the assertions are about the request, not the reply. */
  mockedFetch.mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ videos: [], hits: [], total: 0, total_results: 0 }),
    text: async () => "",
  } as never);
});

afterEach(() => vi.restoreAllMocks());

/**
 * The search term of every URL this call sent to `host`, decoded.
 *
 * The two providers name the parameter differently — Pexels `query=`, Pixabay `q=` — so both are
 * read. Reading only one would make a whole provider's assertions silently vacuous: no URLs
 * matched, nothing to compare, green.
 */
function searchedQueries(host: string): string[] {
  return mockedFetch.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.includes(host))
    .map((u) => {
      try {
        const params = new URL(u).searchParams;
        return params.get("query") ?? params.get("q") ?? "";
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

/* ═══════════ 1 — Pexels ═══════════ */

describe("§1 — Pexels honours strictQueries", () => {
  it("strict: the provider is asked for the caller's phrase, whole and alone", async () => {
    await inScope(() => fetchPexelsClips(PHRASE, 4, "/tmp/strict-test", 0, 1, EXTRAS, true));
    const asked = searchedQueries("api.pexels.com");
    expect(asked, "no search left the process").not.toEqual([]);
    expect(asked).toEqual([PHRASE]);
  });

  it("strict: none of the extra queries is searched for", async () => {
    await inScope(() => fetchPexelsClips(PHRASE, 4, "/tmp/strict-test", 0, 1, EXTRAS, true));
    const asked = searchedQueries("api.pexels.com").join(" | ");
    for (const extra of EXTRAS) {
      expect(asked, `strict mode searched for ${extra}`).not.toContain(extra);
    }
    for (const word of ["cologne", "nuremberg", "cathedral", "courtroom"]) {
      expect(asked, `strict mode searched for "${word}"`).not.toContain(word);
    }
  });

  it("strict: the phrase is not collapsed to one token", async () => {
    await inScope(() => fetchPexelsClips(PHRASE, 4, "/tmp/strict-test", 0, 1, EXTRAS, true));
    for (const asked of searchedQueries("api.pexels.com")) {
      expect(
        asked.trim().split(/\s+/).length,
        `strict mode collapsed the phrase to "${asked}"`
      ).toBeGreaterThan(1);
      expect(asked, "strict mode fell back to the generic word").not.toBe("documentary");
    }
  });

  it("the flag does something — without it the search IS broadened", async () => {
    /**
     * The other half of the claim. A test that only checks strict mode would still pass if the
     * flag were ignored and nothing ever broadened; this is what makes the first three tests
     * statements about `strictQueries` rather than about the query builder.
     */
    await inScope(() => fetchPexelsClips(PHRASE, 4, "/tmp/strict-test", 0, 1, EXTRAS, false));
    const loose = searchedQueries("api.pexels.com");
    expect(loose, "no search left the process").not.toEqual([]);
    expect(
      loose.some((q) => q !== PHRASE),
      `nothing was broadened, so the flag proves nothing: ${loose.join(" | ")}`
    ).toBe(true);
  });
});

/* ═══════════ 2 — Pixabay ═══════════ */

describe("§1 — Pixabay honours strictQueries", () => {
  it("strict: the caller's phrase reaches the provider unchanged", async () => {
    await inScope(() => fetchPixabayClips(PHRASE, 4, "/tmp/strict-test", 0, 1, "pixabay", true));
    const asked = searchedQueries("pixabay.com");
    expect(asked, "no search left the process").not.toEqual([]);
    expect(asked).toEqual([PHRASE]);
  });

  it("strict: the phrase is not collapsed to one token", async () => {
    await inScope(() => fetchPixabayClips(PHRASE, 4, "/tmp/strict-test", 0, 1, "pixabay", true));
    for (const asked of searchedQueries("pixabay.com")) {
      expect(
        asked.trim().split(/\s+/).length,
        `strict mode collapsed the phrase to "${asked}"`
      ).toBeGreaterThan(1);
    }
  });

  it("the flag does something — without it the phrase is simplified", async () => {
    await inScope(() => fetchPixabayClips(PHRASE, 4, "/tmp/strict-test", 0, 1, "pixabay", false));
    const loose = searchedQueries("pixabay.com");
    expect(loose, "no search left the process").not.toEqual([]);
    expect(
      loose.some((q) => q !== PHRASE),
      `nothing was simplified, so the flag proves nothing: ${loose.join(" | ")}`
    ).toBe(true);
  });
});

/* ═══════════ 3 — the shape, so a refactor cannot quietly drop it ═══════════ */

describe("§1 — the enforcement is where the broadening is", () => {
  const bodyOf = (fn: string): string => {
    const at = PIPELINE.search(new RegExp(`export async function ${fn}\\s*\\(`));
    expect(at, `${fn} not found`).toBeGreaterThan(-1);
    return PIPELINE.slice(at, PIPELINE.indexOf("\n}\n", at));
  };

  it("Pexels gates both broadening steps on the flag", () => {
    const body = bodyOf("fetchPexelsClips");
    expect(body, "extraQueries are appended unconditionally").toContain(
      "strictQueries ? [query] : [query, ...(extraQueries ?? [])]"
    );
    expect(body, "the phrase is simplified unconditionally").toContain(
      "strictQueries ? q : simplifyStockSearchWord(q, q, true)"
    );
  });

  it("Pixabay gates its one broadening step on the flag", () => {
    const body = bodyOf("fetchPixabayClips");
    expect(body).toContain("strictQueries ? q : simplifyStockSearchWord(q, q, true)");
  });

  it("the parameter is still a parameter, not a constant", () => {
    /** Read in both functions. A default that is never read is how this was broken before. */
    for (const fn of ["fetchPexelsClips", "fetchPixabayClips"]) {
      const body = bodyOf(fn);
      const reads = body.split("strictQueries").length - 1;
      expect(reads, `${fn} declares strictQueries and barely reads it`).toBeGreaterThanOrEqual(3);
    }
  });
});
