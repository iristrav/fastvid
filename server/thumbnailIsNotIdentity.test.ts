/**
 * RONDE 96 §9 — A PREVIEW IMAGE IS NOT THE ASSET.
 *
 * ── Why the two were confusable in the first place ──────────────────────────────────────────
 *
 * This is not a case of a careless adapter. The providers make the two look alike on purpose:
 *
 *   · archive.org serves an item's preview from `/services/img/<identifier>` — the SAME identifier
 *     that names the asset. A URL built from the asset's real id, that is not the asset.
 *   · Wikimedia derives its thumbnail from the file's own URL by inserting `/thumb/` and appending
 *     `<width>px-<name>`, so the preview differs from the source by one path segment.
 *   · `scenePool` has a provider whose candidate is constructed as `thumbnailUrl: item.url` —
 *     there, the thumbnail IS the asset URL as far as the adapter can tell.
 *
 * So "which of these two strings is the asset" was a question fifteen adapters each had to answer
 * correctly, and the lineage invariant reported the two that got it wrong without being able to say
 * why. Enforced in the ledger instead: one place, every route, and an adapter that cannot tell the
 * difference no longer has to.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { VisualSourceLedger, isThumbnailUrl } from "./visualSourceLineage";

const LEDGER = fs.readFileSync(path.join(__dirname, "visualSourceLineage.ts"), "utf8");

const ledger = () => new VisualSourceLedger({ renderId: "r96", videoId: 1 });

const base = {
  sceneIndex: 0,
  beatIndex: 0,
  candidateId: "ia:steam-locomotive-1945",
  contentKey: "archive:steam-locomotive-1945",
  localPath: "/tmp/clip.mp4",
  provider: "internet_archive",
};

/* ═══════════════ the recogniser ═══════════════ */

describe("the conventions these providers actually publish", () => {
  it.each([
    "https://archive.org/services/img/steam-locomotive-1945",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Berlin.jpg/640px-Berlin.jpg",
    "https://api.europeana.eu/thumbnail/edmPreview?uri=abc",
    "https://example.org/image.jpg?width=320",
    "https://example.org/image.jpg&size=small",
  ])("recognises %j as a preview", (url) => {
    expect(isThumbnailUrl(url)).toBe(true);
  });

  /**
   * DELIBERATELY CONSERVATIVE. A false positive strips a real asset of its identity, which is
   * worse than the problem being solved — so anything unrecognised is the asset.
   */
  it.each([
    "https://archive.org/download/steam-locomotive-1945/movie.mp4",
    "https://upload.wikimedia.org/wikipedia/commons/a/ab/Berlin.jpg",
    "https://commons.wikimedia.org/wiki/File:Berlin.jpg",
    "https://videos.pexels.com/video-files/12345/12345-hd.mp4",
    "",
  ])("treats %j as the asset", (url) => {
    expect(isThumbnailUrl(url)).toBe(false);
  });

  it("is not confused by case or whitespace", () => {
    expect(isThumbnailUrl("  HTTPS://ARCHIVE.ORG/SERVICES/IMG/x  ")).toBe(true);
  });

  it("says nothing is a thumbnail when there is nothing", () => {
    expect(isThumbnailUrl(null)).toBe(false);
    expect(isThumbnailUrl(undefined)).toBe(false);
  });
});

/* ═══════════════ the ledger refuses to be told otherwise ═══════════════ */

describe("a thumbnail cannot become an asset's canonical identity", () => {
  it("keeps the preview, and does not promote it", () => {
    const l = ledger();
    const rec = l.createLineage({
      ...base,
      originalUrl: "https://archive.org/services/img/steam-locomotive-1945",
    });
    expect(rec.originalUrl, "the preview became the asset's canonical URL").toBeUndefined();
    expect(rec.thumbnailUrl).toBe("https://archive.org/services/img/steam-locomotive-1945");
  });

  /** The normal case must be untouched: a real URL stays exactly where it was. */
  it("leaves a real canonical URL alone", () => {
    const l = ledger();
    const rec = l.createLineage({
      ...base,
      originalUrl: "https://archive.org/details/steam-locomotive-1945",
    });
    expect(rec.originalUrl).toBe("https://archive.org/details/steam-locomotive-1945");
    expect(rec.thumbnailUrl).toBeUndefined();
  });

  /** Given both, it takes the asset and files the preview — which is the whole point. */
  it("separates the two when a provider supplies both", () => {
    const l = ledger();
    const rec = l.createLineage({
      ...base,
      originalUrl: "https://archive.org/details/steam-locomotive-1945",
      sourceUrl: "https://archive.org/services/img/steam-locomotive-1945",
    });
    expect(rec.originalUrl).toBe("https://archive.org/details/steam-locomotive-1945");
    expect(rec.thumbnailUrl).toBe("https://archive.org/services/img/steam-locomotive-1945");
  });

  /**
   * The Wikimedia case, where the preview differs from the source by one path segment — the pair
   * most likely to be written into one field by an adapter that could not tell them apart.
   */
  it("separates a Wikimedia thumbnail from the file it was derived from", () => {
    const l = ledger();
    const rec = l.createLineage({
      ...base,
      candidateId: "wikimedia:Berlin.jpg",
      contentKey: "wikimedia:Berlin.jpg",
      provider: "wikimedia",
      originalUrl:
        "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Berlin.jpg/640px-Berlin.jpg",
    });
    expect(rec.originalUrl).toBeUndefined();
    expect(rec.thumbnailUrl).toContain("640px-");
  });

  /**
   * An asset whose ONLY URL is a preview has no canonical URL, and the ledger says so rather than
   * promoting the preview. Saying "unknown" is more useful than saying something false.
   */
  it("reports no canonical URL rather than an untrue one", () => {
    const l = ledger();
    const rec = l.createLineage({
      ...base,
      originalUrl: "https://archive.org/services/img/x",
      sourceUrl: "https://archive.org/services/img/x",
    });
    expect(rec.originalUrl).toBeUndefined();
    expect(rec.thumbnailUrl).toBe("https://archive.org/services/img/x");
  });

  /** Identity is the content key and the candidate id — neither is touched by any of this. */
  it("does not disturb the identity the rest of the pipeline uses", () => {
    const l = ledger();
    const rec = l.createLineage({
      ...base,
      originalUrl: "https://archive.org/services/img/steam-locomotive-1945",
    });
    expect(rec.contentKey).toBe("archive:steam-locomotive-1945");
    expect(rec.candidateId).toBe("ia:steam-locomotive-1945");
    expect(rec.provider).toBe("internet_archive");
    expect(l.resolve("/tmp/clip.mp4")).toBe(rec);
  });
});

/* ═══════════════ enforced once, where every route passes ═══════════════ */

describe("the rule lives in the ledger, not in the adapters", () => {
  it("createLineage is the only place that decides", () => {
    const at = LEDGER.indexOf("originalUrl: canonicalUrl(");
    expect(at, "createLineage no longer filters the canonical URL").toBeGreaterThan(-1);
    expect([...LEDGER.matchAll(/canonicalUrl\(/g)].length, "a second place decides this").toBe(2);
  });

  /** A derived file inherits the parent's preview along with the rest of its provenance. */
  it("a derived record inherits both fields from its parent", () => {
    const l = ledger();
    l.createLineage({
      ...base,
      originalUrl: "https://archive.org/details/steam-locomotive-1945",
      sourceUrl: "https://archive.org/services/img/steam-locomotive-1945",
    });
    const derived = l.linkDerivedPath("/tmp/clip_text.mp4", "/tmp/clip.mp4", "OVERLAYED", {
      reason: "test",
    });
    expect(derived).toBeTruthy();
    expect(derived!.originalUrl).toBe("https://archive.org/details/steam-locomotive-1945");
    expect(derived!.thumbnailUrl).toBe("https://archive.org/services/img/steam-locomotive-1945");
  });
});
