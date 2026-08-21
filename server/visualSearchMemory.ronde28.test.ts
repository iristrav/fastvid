import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { canonicalEntityKey, providerFromContentKey } from "./visualSearchMemory";

// RONDE 28 — the search memory ("which source found usable footage for this subject") existed
// but barely recorded anything, and part of what it did record was wrong.
//
// Render 528 put 18 clips in the finished video. The only writer was archiveIngestion, which ran
// 10 times and admitted 2. The other 16 winners taught the system nothing. On top of that:
//
//   * the stored "query" on the main funnel path was the ASSET'S TITLE, not the query that found
//     it — so asking "what should I search for?" returned things like
//     "White Lives Matter Montana - Stickering Action";
//   * writes lowercased the entity for the dedupe hash but reads matched the raw column, so
//     "Adolf Hitler" could not find a row written as "adolf hitler";
//   * nothing was logged, which is why none of this was visible in any render log.

describe("RONDE 28 — one spelling for writing and reading", () => {
  it("folds case and whitespace so a subject matches itself", () => {
    expect(canonicalEntityKey("Adolf Hitler")).toBe("adolf hitler");
    expect(canonicalEntityKey("  ADOLF   HITLER  ")).toBe("adolf hitler");
    expect(canonicalEntityKey("adolf hitler")).toBe(canonicalEntityKey("Adolf Hitler"));
  });

  it("keeps distinct subjects distinct", () => {
    expect(canonicalEntityKey("Eva Braun")).not.toBe(canonicalEntityKey("Adolf Hitler"));
  });

  it("survives empty and oversized input", () => {
    expect(canonicalEntityKey("   ")).toBe("");
    expect(canonicalEntityKey("x".repeat(400)).length).toBe(256);
  });
});

describe("RONDE 28 — only real providers are remembered", () => {
  it("takes the provider from a content key", () => {
    expect(providerFromContentKey("internet_archive:white-lives-matter")).toBe("internet_archive");
    expect(providerFromContentKey("wikimedia:File_Foo.jpg")).toBe("wikimedia");
    expect(providerFromContentKey("PEXELS:12345")).toBe("pexels");
  });

  it("ignores content families, which are not places you can search", () => {
    // "stock" or "curated" tells you nothing about where to look next time — recording them
    // would fill the memory with rows that can never be acted on.
    for (const key of ["stock:abc", "still:abc", "curated:55967", "file:xyz", "unknown:1"]) {
      expect(providerFromContentKey(key)).toBe("");
    }
  });

  it("returns nothing for a key with no provider at all", () => {
    expect(providerFromContentKey("")).toBe("");
    expect(providerFromContentKey("bareword")).toBe("bareword");
  });
});

describe("RONDE 28 — recording a winning clip", () => {
  /**
   * Mocks the DB layer rather than the module's own export.
   *
   * A vi.spyOn on recordVisualSearchMemory does NOT intercept recordAdoptedClipSource's call to
   * it — an ES module's internal reference is bound at load time, not looked up through the
   * namespace object. The first version of these tests did exactly that, and the two "skips"
   * cases passed while proving nothing, because an empty list is also what you get when the spy
   * never fires. Intercepting at the DB boundary exercises the real code path instead.
   */
  async function loadWithFakeDb() {
    vi.resetModules();
    const rows: Record<string, unknown>[] = [];
    vi.doMock("./db", () => ({
      getDb: async () => ({
        insert: () => ({
          values: (v: Record<string, unknown>) => {
            rows.push(v);
            return { onDuplicateKeyUpdate: async () => undefined };
          },
        }),
      }),
    }));
    const mod = await import("./visualSearchMemory");
    return { mod, rows };
  }

  /** recordAdoptedClipSource is fire-and-forget, so let its promise settle before asserting. */
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it("records a clip that came from a real provider", async () => {
    // Positive control. Without this, the "skips" cases below could pass even if nothing were
    // wired up at all — an empty list proves nothing on its own.
    const { mod, rows } = await loadWithFakeDb();
    mod.recordAdoptedClipSource({
      subject: "Adolf Hitler",
      subjectType: "person",
      query: "hitler bunker archival footage",
      contentKey: "internet_archive:hitlers-reign-of-terror",
      score10: 7.4,
    });
    await settle();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entity: "adolf hitler", // canonical form — what a later lookup will search for
      entityType: "person",
      source: "internet_archive",
      query: "hitler bunker archival footage",
      success: 1,
      qualityScore: 74,
    });
  });

  it("skips clips that came from no searchable provider", async () => {
    const { mod, rows } = await loadWithFakeDb();
    mod.recordAdoptedClipSource({
      subject: "Adolf Hitler",
      subjectType: "person",
      query: "hitler bunker archival footage",
      contentKey: "still:scene_0_b1",
    });
    await settle();
    expect(rows).toHaveLength(0);
  });

  it("skips when there is no subject or no query to attach", async () => {
    const { mod, rows } = await loadWithFakeDb();
    mod.recordAdoptedClipSource({
      subject: "", subjectType: "topic", query: "x", contentKey: "pexels:1",
    });
    mod.recordAdoptedClipSource({
      subject: "Berlin", subjectType: "place", query: "  ", contentKey: "pexels:1",
    });
    await settle();
    expect(rows).toHaveLength(0);
  });

  it("omits the score rather than storing a wrong one when the gate gave none", async () => {
    const { mod, rows } = await loadWithFakeDb();
    mod.recordAdoptedClipSource({
      subject: "Berlin", subjectType: "place", query: "berlin 1945", contentKey: "wikimedia:F.jpg",
      score10: null,
    });
    await settle();
    expect(rows[0]!.qualityScore).toBeUndefined();
  });
});

describe("RONDE 28b — remembering the dead ends", () => {
  async function loadWithFakeDb() {
    vi.resetModules();
    const rows: Record<string, unknown>[] = [];
    vi.doMock("./db", () => ({
      getDb: async () => ({
        insert: () => ({
          values: (v: Record<string, unknown>) => {
            rows.push(v);
            return { onDuplicateKeyUpdate: async () => undefined };
          },
        }),
      }),
    }));
    return { mod: await import("./visualSearchMemory"), rows };
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it("writes a dead end for a provider that contributed nothing", async () => {
    const { mod, rows } = await loadWithFakeDb();
    mod.recordSearchMisses({
      subject: "Adolf Hitler",
      subjectType: "person",
      searchedKeys: ["pexels|hitler", "pixabay|interview"],
      adoptedByProvider: new Map([["wikimedia", 4]]),
    });
    await settle();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.success === 0)).toBe(true);
    expect(rows.map((r) => r.source).sort()).toEqual(["pexels", "pixabay"]);
  });

  it("says nothing about a provider that DID contribute", async () => {
    // Some of its queries missed too, but the metrics cannot say which. Marking a working query
    // as dead would be far more damaging than recording nothing at all.
    const { mod, rows } = await loadWithFakeDb();
    mod.recordSearchMisses({
      subject: "Adolf Hitler",
      subjectType: "person",
      searchedKeys: ["wikimedia|hitler portrait", "wikimedia|hitler bunker"],
      adoptedByProvider: new Map([["wikimedia", 1]]),
    });
    await settle();
    expect(rows).toHaveLength(0);
  });

  it("stores the query, splitting only on the first separator", async () => {
    const { mod, rows } = await loadWithFakeDb();
    mod.recordSearchMisses({
      subject: "Berlin",
      subjectType: "place",
      searchedKeys: ["internet_archive|title:(Adolf Hitler) AND mediatype:movies"],
      adoptedByProvider: new Map(),
    });
    await settle();
    expect(rows[0]).toMatchObject({
      source: "internet_archive",
      query: "title:(Adolf Hitler) AND mediatype:movies",
    });
  });

  it("ignores malformed keys and an empty subject", async () => {
    const { mod, rows } = await loadWithFakeDb();
    mod.recordSearchMisses({
      subject: "Berlin", subjectType: "place",
      searchedKeys: ["noseparator", "|emptysource", "pexels|"],
      adoptedByProvider: new Map(),
    });
    mod.recordSearchMisses({
      subject: "  ", subjectType: "topic",
      searchedKeys: ["pexels|x"], adoptedByProvider: new Map(),
    });
    await settle();
    expect(rows).toHaveLength(0);
  });

  it("cannot erase a proven source — a miss never downgrades a hit", async () => {
    const { mod } = await loadWithFakeDb();
    const src = readFileSync(path.join(__dirname, "visualSearchMemory.ts"), "utf8");
    const upsert = src.slice(src.indexOf(".onDuplicateKeyUpdate("), src.indexOf(".onDuplicateKeyUpdate(") + 600);
    // success:1 is only ever set when the new record IS a success; a failure sets nothing.
    expect(upsert).toContain("...(input.success ? { success: 1 } : {})");
    expect(typeof mod.recordSearchMisses).toBe("function");
  });
});

const memorySrc = readFileSync(path.join(__dirname, "visualSearchMemory.ts"), "utf8");
const pipelineSrc = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

describe("RONDE 28c — dead ends blame the query only when several sources agree", () => {
  async function loadWithRows(rows: Array<{ source: string; query: string }>) {
    vi.resetModules();
    vi.doMock("./db", () => ({
      getDb: async () => ({
        select: () => ({
          from: () => ({
            where: () => ({ orderBy: () => ({ limit: async () => rows.map((r) => ({ ...r, usageCount: 1 })) }) }),
          }),
        }),
      }),
    }));
    return import("./visualSearchMemory");
  }

  it("blames the query when two different sources both came up empty", () => {
    return loadWithRows([
      { source: "pexels", query: "hitler" },
      { source: "pixabay", query: "hitler" },
    ]).then(async (mod) => {
      expect(await mod.getDeadEndQueries("Adolf Hitler")).toEqual(new Set(["hitler"]));
    });
  });

  it("blames the SOURCE, not the query, when only one source failed", async () => {
    // Pexels having no Führerbunker footage says nothing about Wikimedia. Demoting the query
    // everywhere on that evidence would throw away a search that still works elsewhere.
    const mod = await loadWithRows([{ source: "pexels", query: "hitler bunker" }]);
    expect(await mod.getDeadEndQueries("Adolf Hitler")).toEqual(new Set());
  });

  it("keeps distinct queries apart", async () => {
    const mod = await loadWithRows([
      { source: "pexels", query: "hitler" },
      { source: "pixabay", query: "hitler" },
      { source: "pexels", query: "bunker" },
    ]);
    const dead = await mod.getDeadEndQueries("Adolf Hitler");
    expect(dead.has("hitler")).toBe(true);
    expect(dead.has("bunker")).toBe(false);
  });

  it("returns nothing when the memory is empty", async () => {
    const mod = await loadWithRows([]);
    expect((await mod.getDeadEndQueries("Adolf Hitler")).size).toBe(0);
  });
});

describe("RONDE 28c — the pipeline demotes, it does not drop", () => {
  const src = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
  const fn = src.slice(
    src.indexOf("export async function primeQueriesWithSearchMemory("),
    src.indexOf("/** F3-27: derive the F3-26 coverage-warning input"),
  );

  it("reads the dead-end half of the memory it has been writing", () => {
    expect(fn).toContain("getDeadEndQueries(trimmedEntity)");
  });

  it("keeps every original query — a dead end moves to the back, it is not removed", () => {
    // Dropping outright would let two unlucky renders blind a subject permanently.
    expect(fn).toContain("...proven, ...kept, ...demoted");
    expect(fn).not.toMatch(/return\s+kept\s*;/);
  });

  it("still returns the untouched list when there is nothing to say", () => {
    expect(fn).toContain("if (proven.length === 0 && demoted.length === 0) return baseExtraQueries;");
  });

  it("degrades to the original queries if the lookup throws", () => {
    expect(fn).toContain("} catch {\n    return baseExtraQueries;");
  });
});

describe("RONDE 28b — dead ends are readable, and kept apart from the proven list", () => {
  it("has its own lookup that returns only failures", () => {
    const fn = memorySrc.slice(
      memorySrc.indexOf("export async function getSearchMemoryDeadEnds("),
      memorySrc.indexOf("Prior successful queries/sources"),
    );
    expect(fn).toContain("eq(visualSearchMemory.success, 0)");
    expect(fn).toContain("canonicalEntityKey(entity)");
  });

  it("keys dead ends by source AND query, not by source alone", () => {
    // Killing a whole provider on one bad query would starve later renders.
    const fn = memorySrc.slice(memorySrc.indexOf("export async function getSearchMemoryDeadEnds("));
    expect(fn).toContain("${r.source}|${r.query}");
  });

  it("is recorded at the end of the render, when the answer is actually known", () => {
    const at = pipelineSrc.indexOf("recordSearchMisses({");
    expect(at).toBeGreaterThan(-1);
    const call = pipelineSrc.slice(at, at + 400);
    expect(call).toContain("visualDedup.sourcingCache.queries.keys()");
    expect(call).toContain("adoptedByProvider");
  });
});

describe("RONDE 28 — the score is stored on the scale the column expects", () => {
  it("converts the gate's 0-10 into the column's 0-100", () => {
    const fn = memorySrc.slice(
      memorySrc.indexOf("export function recordAdoptedClipSource("),
      memorySrc.indexOf("Prior successful queries/sources"),
    );
    expect(fn).toContain("input.score10 * 10");
    expect(fn).toContain("Math.max(0, Math.min(100,");
  });
});

describe("RONDE 28 — recording happens at every adoption, not just at archiving", () => {
  it("is hooked at the single acceptance point", () => {
    const at = pipelineSrc.indexOf("this stays the single acceptance point that marks the asset as used");
    expect(at).toBeGreaterThan(-1);
    const after = pipelineSrc.slice(at, at + 1600);
    expect(after).toContain("recordAdoptedClipSource(");
    expect(after).toContain("contentKey,");
  });

  it("uses the real query, not the clip's filename or title", () => {
    const at = pipelineSrc.indexOf("recordAdoptedClipSource({");
    const call = pipelineSrc.slice(at, at + 400);
    expect(call).toContain("query: sourceQuery");
  });

  it("keys on the video's subject, preferring the person over the title", () => {
    const at = pipelineSrc.indexOf("recordAdoptedClipSource({");
    const call = pipelineSrc.slice(at, at + 400);
    expect(call).toContain("memoryTopic.primaryPerson || memoryTopic.videoTitle");
    expect(call).toContain('memoryTopic.primaryPerson ? "person" : "topic"');
  });

  it("never blocks or fails the render — it is fire-and-forget", () => {
    const fn = memorySrc.slice(
      memorySrc.indexOf("export function recordAdoptedClipSource("),
      memorySrc.indexOf("Prior successful queries/sources"),
    );
    expect(fn).toContain("void recordVisualSearchMemory(");
    expect(fn).toContain("): void {");
  });
});

describe("RONDE 28 — ingestion stores the query, not the asset title", () => {
  it("no longer passes the pool candidate's title as the matched query", () => {
    // The title of a clip is not something you can search for next time.
    expect(pipelineSrc).not.toContain("matchedQuery: wec.poolCandidate?.title");
  });
});

describe("RONDE 28 — a lookup that finds something says so", () => {
  it("logs the proven sources it found", () => {
    const fn = memorySrc.slice(memorySrc.indexOf("export async function getVisualSearchMemoryForEntity("));
    expect(fn).toContain("[SearchMemory]");
    expect(fn).toContain("proven source(s)");
  });

  it("returns only combinations that actually worked", () => {
    const fn = memorySrc.slice(memorySrc.indexOf("export async function getVisualSearchMemoryForEntity("));
    expect(fn).toContain("eq(visualSearchMemory.success, 1)");
  });

  it("looks up under the same canonical key it writes", () => {
    const fn = memorySrc.slice(memorySrc.indexOf("export async function getVisualSearchMemoryForEntity("));
    expect(fn).toContain("canonicalEntityKey(entity)");
  });
});
