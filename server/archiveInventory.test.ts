/**
 * RONDE 648 — the archive inventory line, before any asset is moved between archives.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { formatArchiveInventory } from "./archiveInventory";

describe("one line per archive, counted by where each asset came from", () => {
  it("archive 36's shape: a Stockbeelden archive holding automatic YouTube and Wikimedia ingests", () => {
    const lines = formatArchiveInventory([
      { archiveId: 36, name: "Stockbeelden", slug: "stockbeelden", isActive: 1, source: "youtube_cc", mixKind: "real_video", n: 40 },
      { archiveId: 36, name: "Stockbeelden", slug: "stockbeelden", isActive: 1, source: "wikimedia", mixKind: "photo", n: 7 },
      { archiveId: 36, name: "Stockbeelden", slug: "stockbeelden", isActive: 1, source: "upload", mixKind: "stock", n: 3 },
      { archiveId: 41, name: "Stockbeelden", slug: "stock", isActive: 0, source: "none", mixKind: "none", n: 0 },
    ]);
    expect(lines).toEqual([
      '[ArchiveInventory] archive=36 name="Stockbeelden" slug=stockbeelden active=1 assets=50 ' +
        "sources=youtube_cc:40,wikimedia:7,upload:3 mix=real_video:40,photo:7,stock:3",
      '[ArchiveInventory] archive=41 name="Stockbeelden" slug=stock active=0 assets=0 sources=none mix=none',
    ]);
  });

  it("the worker logs it at boot, and the module only reads", () => {
    const WORKER = readFileSync(join(__dirname, "worker.ts"), "utf8");
    expect(WORKER).toContain("await logArchiveInventory()");
    const SRC = readFileSync(join(__dirname, "archiveInventory.ts"), "utf8");
    expect(SRC).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/);
  });
});
