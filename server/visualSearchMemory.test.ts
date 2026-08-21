import { describe, expect, it, vi, beforeEach } from "vitest";

// F3-26: query/entity/source learning loop. classifyBeatEntities is pure (no DB) and is tested
// directly. recordVisualSearchMemory/getVisualSearchMemoryForEntity touch the DB via a chained
// drizzle query builder — mocked here at the exact chain shape the real functions call, so the
// upsert-vs-duplicate and ordering behavior is exercised without a real database.
const insertValuesMock = vi.fn();
const onDuplicateKeyUpdateMock = vi.fn().mockResolvedValue(undefined);
const selectMock = vi.fn();
const limitMock = vi.fn();

vi.mock("./db", () => ({
  getDb: vi.fn(async () => ({
    insert: () => ({
      values: (v: unknown) => {
        insertValuesMock(v);
        return { onDuplicateKeyUpdate: onDuplicateKeyUpdateMock };
      },
    }),
    select: () => {
      selectMock();
      return {
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: limitMock,
            }),
          }),
        }),
      };
    },
  })),
}));

import {
  classifyBeatEntities,
  recordVisualSearchMemory,
  getVisualSearchMemoryForEntity,
} from "./visualSearchMemory";
import type { SemanticEntityList } from "./semanticVisualMatching";

describe("classifyBeatEntities (F3-26 entity detection, no new LLM call)", () => {
  const emptyEntities: SemanticEntityList = {
    persons: [],
    locations: [],
    companies: [],
    events: [],
    objects: [],
    emotions: [],
    timePeriods: [],
    years: [],
  };

  it("Test 6 — maps persons/companies/locations/events onto person/organization/place/event", () => {
    const entities: SemanticEntityList = {
      ...emptyEntities,
      persons: ["Justin Bieber"],
      companies: ["Apple"],
      locations: ["New York"],
      events: ["World War II"],
    };
    const result = classifyBeatEntities(entities);
    expect(result).toContainEqual({ type: "person", value: "Justin Bieber" });
    expect(result).toContainEqual({ type: "organization", value: "Apple" });
    expect(result).toContainEqual({ type: "place", value: "New York" });
    expect(result).toContainEqual({ type: "event", value: "World War II" });
  });

  it("falls back to topicDomain as a general topic when no specific entities were recognized", () => {
    const result = classifyBeatEntities(emptyEntities, "artificial intelligence");
    expect(result).toEqual([{ type: "topic", value: "artificial intelligence" }]);
  });

  it("returns nothing when there is neither a recognized entity nor a topic domain", () => {
    expect(classifyBeatEntities(emptyEntities)).toEqual([]);
  });

  it("de-duplicates the same value appearing under the same type", () => {
    const entities: SemanticEntityList = { ...emptyEntities, persons: ["Elon Musk", "Elon Musk"] };
    expect(classifyBeatEntities(entities)).toEqual([{ type: "person", value: "Elon Musk" }]);
  });
});

describe("visual search memory — DB learning loop", () => {
  beforeEach(() => {
    insertValuesMock.mockClear();
    onDuplicateKeyUpdateMock.mockClear();
    selectMock.mockClear();
    limitMock.mockReset();
  });

  it("records a new (entity, source, query) combination with usageCount=1", async () => {
    await recordVisualSearchMemory({
      entity: "Justin Bieber",
      entityType: "person",
      query: "Justin Bieber 2015 interview",
      source: "youtube_cc",
      sourceUrl: "https://youtube.com/watch?v=abc123",
      assetId: 42,
      success: true,
    });

    expect(insertValuesMock).toHaveBeenCalledTimes(1);
    const inserted = insertValuesMock.mock.calls[0]?.[0];
    expect(inserted).toMatchObject({
      // RONDE 28: stored canonically (lowercased, whitespace-collapsed). The dedupe hash always
      // lowercased, so rows already collapsed across spellings — but the LOOKUP matched the raw
      // column, so "Justin Bieber" could never find a row written as "justin bieber". Write and
      // read now use the same key. Everything else this test asserts is unchanged.
      entity: "justin bieber",
      entityType: "person",
      query: "Justin Bieber 2015 interview",
      source: "youtube_cc",
      usageCount: 1,
    });
    // Same dedupe key hash regardless of case/whitespace, so a repeat hit collides correctly.
    expect(typeof inserted.dedupeKeyHash).toBe("string");
    expect(inserted.dedupeKeyHash).toHaveLength(64); // sha256 hex
    expect(onDuplicateKeyUpdateMock).toHaveBeenCalledTimes(1);
  });

  it("Test 16 — a repeat hit for the same (entity, source, query) increments usageCount instead of inserting a duplicate row", async () => {
    await recordVisualSearchMemory({
      entity: "Justin Bieber",
      entityType: "person",
      query: "Justin Bieber early career",
      source: "wikimedia",
      success: true,
    });
    await recordVisualSearchMemory({
      entity: "Justin Bieber",
      entityType: "person",
      query: "Justin Bieber early career",
      source: "wikimedia",
      success: true,
    });

    // Both calls hash to the same dedupeKeyHash — the ON DUPLICATE KEY UPDATE clause (which
    // increments usageCount via sql`${...} + 1`) is what makes the second call a reinforcement
    // instead of a second row, exactly like archiveContentGaps.recordArchiveContentGap already
    // does for its own hitCount.
    const [first, second] = insertValuesMock.mock.calls.map((c) => c[0].dedupeKeyHash);
    expect(first).toBe(second);
    expect(onDuplicateKeyUpdateMock).toHaveBeenCalledTimes(2);
  });

  it("getVisualSearchMemoryForEntity returns the DB rows for the requested entity", async () => {
    const rows = [
      { id: 1, entity: "Justin Bieber", query: "Justin Bieber interview", usageCount: 3 },
      { id: 2, entity: "Justin Bieber", query: "Justin Bieber concert", usageCount: 1 },
    ];
    limitMock.mockResolvedValue(rows);

    const result = await getVisualSearchMemoryForEntity("Justin Bieber");
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual(rows);
  });

  it("never throws when the query fails — best-effort", async () => {
    limitMock.mockRejectedValue(new Error("db down"));
    await expect(getVisualSearchMemoryForEntity("Someone")).resolves.toEqual([]);
  });
});
