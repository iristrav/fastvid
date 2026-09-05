import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { adoptedClipMemoryRow, canonicalEntityKey, providerFromContentKey } from "./visualSearchMemory";

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
          // RONDE 86: dead ends are written as one multi-row INSERT … ON DUPLICATE KEY UPDATE
          // instead of one statement per row — 248 un-awaited single-row inserts against a pool
          // with queueLimit=100 is what produced render 536's 113 "Queue limit reached" errors.
          // The ROWS are what these tests are about, so they are flattened here; every assertion
          // below about which rows are written, and with what values, is unchanged.
          values: (v: Record<string, unknown> | Record<string, unknown>[]) => {
            if (Array.isArray(v)) rows.push(...v);
            else rows.push(v);
            return { onDuplicateKeyUpdate: async () => undefined };
          },
        }),
      }),
    }));
    const mod = await import("./visualSearchMemory");
    // The queue de-duplicates across calls for the life of the process, so each test starts clean.
    mod.resetVisualSearchMemoryQueue();
    return { mod, rows };
  }
  const settle = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };

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
  /**
   * Was a source-text window between two markers. RONDE 131 split the write out of
   * `recordAdoptedClipSource` into `adoptedClipMemoryRow`, which moved the arithmetic out of the
   * slice — and, better, made the row itself something a test can simply look at. Asserting on the
   * value beats asserting on the expression that computes it.
   */
  const row = (score10: number | null | undefined) =>
    adoptedClipMemoryRow({
      subject: "Hermann Göring",
      subjectType: "person",
      query: "Göring 1936",
      contentKey: "wikimedia:File_Goering.jpg",
      score10,
    });

  it("converts the gate's 0-10 into the column's 0-100", () => {
    expect(row(8.2)?.qualityScore).toBe(82);
    expect(row(10)?.qualityScore).toBe(100);
    expect(row(0)?.qualityScore).toBe(0);
    expect(row(7.55)?.qualityScore).toBe(76); // rounded, not truncated
  });

  it("clamps rather than storing a value the column cannot hold", () => {
    expect(row(12)?.qualityScore).toBe(100);
    expect(row(-3)?.qualityScore).toBe(0);
  });

  it("no score at all stores no score, rather than a zero that reads as 'bad'", () => {
    expect(row(undefined)?.qualityScore).toBeUndefined();
    expect(row(null)?.qualityScore).toBeUndefined();
    expect(row(Number.NaN)?.qualityScore).toBeUndefined();
    expect(row(Number.POSITIVE_INFINITY)?.qualityScore).toBeUndefined();
  });
});

describe("RONDE 28 — recording happens at every adoption, not just at archiving", () => {
  it("is hooked at the single acceptance point", () => {
    const at = pipelineSrc.indexOf("this stays the single acceptance point that marks the asset as used");
    expect(at).toBeGreaterThan(-1);
    // Window sized to the whole acceptance block rather than a tight byte count — RONDE 29
    // added the moving/still counters between the marker and this call, and a snug slice made
    // an unrelated insertion look like the hook had moved.
    // RONDE 86 and RONDE 87 each widened this again for the same reason: the lineage recording
    // added to the acceptance block (and to markAdopted) sits between the marker and
    // `const mustFairUse`, and a snug slice would make an unrelated insertion look like the hook
    // had moved. The relationship being asserted — the hook is inside the acceptance block, before
    // the fair-use transform — is unchanged.
    // RONDE 88A: widened a fourth time, and this time the byte count is gone. The window now ends
    // at the landmark the last assertion already needs — `const mustFairUse` — so an insertion in
    // the acceptance block can never again push the hook out of view and report it as moved.
    const fairUse = pipelineSrc.indexOf("const mustFairUse", at);
    expect(fairUse, "the fair-use transform no longer follows the acceptance block").toBeGreaterThan(at);
    const after = pipelineSrc.slice(at, fairUse + "const mustFairUse".length);
    expect(after).toContain("recordAdoptedClipSource(");
    expect(after).toContain("contentKey,");
    // The hook must still sit inside the acceptance block, not somewhere later in the file.
    expect(after.indexOf("const mustFairUse")).toBeGreaterThan(-1);
    expect(after.indexOf("recordAdoptedClipSource(")).toBeLessThan(after.indexOf("const mustFairUse"));
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
    // RONDE 86: the row is QUEUED rather than fired. That is a stronger version of the same
    // guarantee — enqueueVisualSearchMemory is synchronous and touches no connection at all,
    // where `void recordVisualSearchMemory(...)` started a database round trip and merely
    // discarded the promise. Still nothing to await, still nothing that can fail the render.
    expect(fn).toContain("enqueueVisualSearchMemory({");
    expect(fn).toContain("): void {");
    const start = memorySrc.indexOf("export function recordAdoptedClipSource(");
    const body = memorySrc.slice(start, memorySrc.indexOf("\n}", start));
    expect(body, "the hot path must not await the database").not.toContain("await ");
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
