/**
 * A CARD IS NOT A PICTURE — one placeholder definition, and it stops at the timeline.
 *
 * ── The census this round started from ──────────────────────────────────────────────────────
 *
 * Six predicates decided whether a clip depicts nothing, and no two agreed on any filename this
 * pipeline writes:
 *
 *   scene_0_slot100_guaranteed.mp4   A false   B true    C true    D false
 *   scene_0_fallback.mp4             A true    B false   C true    D false
 *
 *   A  isPipelineFallbackClip   — what the DELIVERY GATE reads
 *   B  isGuaranteedClipName     — what the status reader reads
 *   C  FALLBACK_RE / FALLBACK_PATH_TOKENS — two byte-identical copies
 *   D  FALLBACK_BASENAMES       — anchored `^`, so it has never matched a real file
 *
 * `_guaranteed.mp4` is the name `generateGuaranteedBeatClipInner` writes, and A is the predicate
 * the delivery gate asks. A says false.
 *
 * ── And the filename was never the right question ───────────────────────────────────────────
 *
 * All FOUR rungs of the guaranteed ladder write that one name. Two fetch real footage. So no
 * regex over the name can be correct in both directions, and the round's answer is not a better
 * regex: it is to ask the TIER, the ADOPT SOURCE or the LEDGER ROUTE, each of which knows which
 * rung answered, and to refuse the clip at the PLANNER rather than at the gate.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import {
  MANUFACTURED_BASENAME_RE,
  PLACEHOLDER_ADOPT_SOURCES,
  adoptSourceIsPlaceholder,
  beatClipIsPlaceholder,
  clipPathIsFallbackFile,
  clipPathLooksManufactured,
  lineageRouteIsPlaceholder,
  tierIsPlaceholder,
} from "./placeholderIdentity";
import { isPipelineFallbackClip, isPlaceholderGuaranteedTier } from "./videoPipeline";
import { isFillerAdoptSource, adoptRouteForSource } from "./clipAdoptAudit";

const read = (f: string) => readFileSync(join(__dirname, f), "utf8");
const PIPELINE = read("videoPipeline.ts");

/** The two names the pipeline actually writes — videoPipeline.ts, the ladder and the card path. */
const GUARANTEED = "scene_0_slot100_guaranteed.mp4";
const FALLBACK_FILE = "scene_0_fallback.mp4";

/* ═══════════ §1 — the ladder's filenames are still what this round measured ═══════════ */

describe("§1 — the names this pipeline writes", () => {
  it("every rung of the guaranteed ladder still writes ONE name", () => {
    /**
     * The whole argument rests on this. If the ladder ever writes a per-tier name, the filename
     * becomes answerable and this module's warnings should be revisited rather than trusted.
     */
    expect(PIPELINE).toContain("`scene_${sceneIndex}_slot${slotIndex}_guaranteed.mp4`");
    expect(PIPELINE).toContain("`scene_${sceneIndex}_fallback.mp4`");
  });

  it("and the ladder still has four rungs, two of which fetch real media", () => {
    expect(PIPELINE).toContain(
      'export type GuaranteedClipTier = "topical" | "wikimedia" | "text_overlay" | "color_fallback";'
    );
    expect(tierIsPlaceholder("topical")).toBe(false);
    expect(tierIsPlaceholder("wikimedia")).toBe(false);
    expect(tierIsPlaceholder("text_overlay")).toBe(true);
    expect(tierIsPlaceholder("color_fallback")).toBe(true);
  });

  it("an unnamed tier counts as a card — the safe direction, unchanged", () => {
    expect(tierIsPlaceholder(undefined)).toBe(true);
    expect(isPlaceholderGuaranteedTier(undefined)).toBe(true);
  });
});

/* ═══════════ §2 — THE DEFECT, NAMED: the gate's predicate misses the card ═══════════ */

describe("§2 — the narrow predicate, and why it stays narrow", () => {
  it("isPipelineFallbackClip does NOT match the guaranteed name — deliberately, still", () => {
    /**
     * This is the hole, and widening it here would be the wrong fix: the export gate and the
     * delivery gate both read this, and `topical`/`wikimedia` rescue footage carries the same
     * name. A widened predicate would refuse genuine archive material on every render.
     *
     * The hole is closed at the planner instead — §5.
     */
    expect(isPipelineFallbackClip(GUARANTEED)).toBe(false);
    expect(isPipelineFallbackClip(FALLBACK_FILE)).toBe(true);
  });

  it("it has exactly one body now, and videoPipeline is not it", () => {
    const at = PIPELINE.indexOf("export function isPipelineFallbackClip(");
    const body = PIPELINE.slice(at, PIPELINE.indexOf("\n}", at));
    expect(body, "a second copy of the regex grew back").not.toContain("_fallback\\.mp4");
    expect(body).toContain("clipPathIsFallbackFile(");
  });

  it("the shared narrow predicate answers identically", () => {
    for (const n of [GUARANTEED, FALLBACK_FILE, "scene_0_b1_ai_fallback.mp4", "yt_abc_trim.mp4"]) {
      expect(clipPathIsFallbackFile(n), n).toBe(isPipelineFallbackClip(n));
    }
  });
});

/* ═══════════ §3 — one token list, and the dead one is alive ═══════════ */

describe("§3 — the four duplicate token regexes", () => {
  it("no module declares its own fallback token list any more", () => {
    /**
     * Guarded by shape: the literal that was maintained in four places must not reappear in any
     * of them. `placeholderIdentity` is the one file allowed to spell it.
     */
    for (const f of [
      "assetDirector.ts",
      "globalDocumentaryDirector.ts",
      "shotSequenceOptimizer.ts",
      "editorialReorder.ts",
    ]) {
      const src = read(f);
      expect(src, `${f} still spells its own token list`).not.toMatch(
        /\/\^?\(?color_fallback\|fallback\|guaranteed/
      );
      expect(src, `${f} does not read the shared one`).toMatch(
        /from "\.\/placeholderIdentity"/
      );
    }
  });

  it("THE DEAD PREDICATE IS ALIVE: the anchor is gone", () => {
    /**
     * `/^(color_fallback|fallback|guaranteed|…)/i` over a basename that always begins `scene_`
     * returned false for every file this pipeline has ever produced. The reorderer it fed has
     * therefore never known a card from a picture.
     */
    expect(/^(color_fallback|fallback|guaranteed|placeholder|color_clip)/i.test(GUARANTEED)).toBe(
      false
    );
    expect(clipPathLooksManufactured(GUARANTEED)).toBe(true);
    expect(clipPathLooksManufactured(FALLBACK_FILE)).toBe(true);
  });

  it("editorialReorder's extra token survived the merge", () => {
    /** It was the only copy carrying `black_fill`; consolidating must not drop it. */
    expect(clipPathLooksManufactured("scene_2_black_fill.mp4")).toBe(true);
    expect(MANUFACTURED_BASENAME_RE.source).toContain("black_fill");
  });

  it("and it still says nothing about a real clip", () => {
    expect(clipPathLooksManufactured("yt_dQw4w9WgXcQ_trim.mp4")).toBe(false);
    expect(clipPathLooksManufactured("pexels_12345.mp4")).toBe(false);
  });
});

/* ═══════════ §4 — the authority order ═══════════ */

describe("§4 — beatClipIsPlaceholder asks the strongest evidence it holds", () => {
  it("A REAL RUNG IS NOT REFUSED FOR ITS NAME — the mistake this module exists to stop", () => {
    /**
     * `topical` fetched curated archive footage and wrote it to the guaranteed name. Falling
     * through to a filename check would throw away real media on every render that rescued a beat.
     */
    const v = beatClipIsPlaceholder({ clipPath: GUARANTEED, tier: "topical" });
    expect(v.placeholder).toBe(false);
    expect(v.authority).toBe("TIER");
  });

  it("a card rung is refused, and names the tier as its evidence", () => {
    const v = beatClipIsPlaceholder({ clipPath: GUARANTEED, tier: "color_fallback" });
    expect(v.placeholder).toBe(true);
    expect(v.authority).toBe("TIER");
    expect(v.evidence).toBe("color_fallback");
  });

  it("without a tier it falls to the adopt source — which is what the ladder records", () => {
    const v = beatClipIsPlaceholder({ clipPath: GUARANTEED, adoptSource: "rescue_placeholder" });
    expect(v.placeholder).toBe(true);
    expect(v.authority).toBe("ADOPT_SOURCE");
  });

  it("without either it falls to the ledger route — which survives into another process", () => {
    const v = beatClipIsPlaceholder({ clipPath: GUARANTEED, lineageRoute: "fallback" });
    expect(v.placeholder).toBe(true);
    expect(v.authority).toBe("LINEAGE_ROUTE");
  });

  it("THE CASE THAT USED TO ESCAPE: guaranteed name, placeholder route", () => {
    /** Exactly what a drawn card looks like by the time the planner sees it. */
    expect(isPipelineFallbackClip(GUARANTEED)).toBe(false);
    expect(beatClipIsPlaceholder({ clipPath: GUARANTEED, lineageRoute: "fallback" }).placeholder)
      .toBe(true);
  });

  it("the filename is the last resort, and only the narrow form", () => {
    const v = beatClipIsPlaceholder({ clipPath: FALLBACK_FILE });
    expect(v.placeholder).toBe(true);
    expect(v.authority).toBe("FILENAME");
    /** The wide form is NOT used here — it would refuse the ladder's real rungs. */
    expect(beatClipIsPlaceholder({ clipPath: GUARANTEED }).placeholder).toBe(false);
  });

  it("nothing known is NOT a proof of real media, and says so", () => {
    const v = beatClipIsPlaceholder({ clipPath: "yt_abc_trim.mp4" });
    expect(v.placeholder).toBe(false);
    expect(v.authority, "NONE means unobjected, never verified").toBe("NONE");
  });
});

/* ═══════════ §5 — THE INVARIANT: a card does not enter the timeline ═══════════ */

describe("§5 — placeholder cannot reach the timeline", () => {
  const at = PIPELINE.indexOf("const placeholderVerdict = beatClipIsPlaceholder({");
  it("the planner's input is filtered, and the filter is this module", () => {
    expect(at, "the planner takes whatever it is handed again").toBeGreaterThan(-1);
  });

  it("a refused beat becomes null — the planner's existing word for an unfilled beat", () => {
    const block = PIPELINE.slice(at, at + 2200);
    expect(block).toContain("if (placeholderVerdict.placeholder) {");
    expect(block, "the beat must not be given some other picture instead").toContain("return null;");
    expect(block, "the file must not stay in the render-input map").toContain(
      "localFileByBeat.delete("
    );
  });

  it("the refusal is loud and carries its authority", () => {
    const block = PIPELINE.slice(at, at + 2200);
    expect(block).toContain("[PlaceholderRefused]");
    expect(block).toContain("authority=${placeholderVerdict.authority}");
    expect(block, "a refusal with no ledger event is a silent drop").toContain(
      "PLACEHOLDER_NOT_IN_TIMELINE"
    );
  });

  it("THE COUNT IS MEASURED OFF THE DOCUMENT, NOT ASSERTED", () => {
    /**
     * The first draft of this line printed `placeholdersOnTimeline=0` as a constant — a report
     * that cannot fail is not evidence. It now counts the stored timeline's own clips, and a
     * disagreement with the refusal counter is an error, because it would mean a clip reached the
     * timeline by a path the gate does not stand in.
     */
    const gate = PIPELINE.indexOf("`[PlaceholderGate] video=${videoId} `");
    expect(gate).toBeGreaterThan(-1);
    const block = PIPELINE.slice(gate - 1600, gate + 900);
    expect(block).toContain("videoTrack(outcome.timeline)");
    expect(block).toContain("placeholdersOnTimeline=${stillPlaceholder}");
    expect(block).toContain("INVARIANT_BREACHED");
    expect(block, "the zero was asserted again").not.toContain("placeholdersOnTimeline=0`");
  });

  it("the planner itself still holds no placeholder vocabulary — the gate is upstream of it", () => {
    /**
     * Deliberate: `cinematicProduction` and `cinematicPipelineInputs` decide what makes a good
     * plan, not what counts as media. Teaching them this word would be a second definition, which
     * is the thing this round removed.
     */
    for (const f of ["cinematicProduction.ts", "cinematicPipelineInputs.ts"]) {
      expect(read(f), `${f} grew its own placeholder rule`).not.toMatch(
        /isPlaceholder|isPipelineFallbackClip|beatClipIsPlaceholder/
      );
    }
  });
});

/* ═══════════ §6 — the source vocabulary was not widened by accident ═══════════ */

describe("§6 — adopt sources", () => {
  it("the two labels the pipeline writes are placeholders", () => {
    expect(adoptSourceIsPlaceholder("rescue_placeholder")).toBe(true);
    expect(adoptSourceIsPlaceholder("fallback")).toBe(true);
  });

  it("the two legacy labels are carried, and no writer emits them", () => {
    /**
     * `guaranteed` and `color_fallback` are listed by three consumers. Including them costs
     * nothing because the ladder records `rescue_placeholder` or `fallback` — so this set is the
     * same set in production, and a future writer using an old label is caught rather than missed.
     */
    expect([...PLACEHOLDER_ADOPT_SOURCES].sort()).toEqual([
      "color_fallback",
      "fallback",
      "guaranteed",
      "rescue_placeholder",
    ]);
    expect(PIPELINE).toContain('? "rescue_placeholder"');
  });

  it("real rescue footage is NOT a placeholder source", () => {
    for (const s of ["rescue_archive", "rescue_wikimedia", "youtube_cc", "pexels", "own_archive"]) {
      expect(adoptSourceIsPlaceholder(s), s).toBe(false);
    }
  });

  it("isFillerAdoptSource now reads it, and answers as before on every written label", () => {
    for (const s of ["rescue_placeholder", "fallback", "rescue_archive", "youtube_cc", "stock"]) {
      expect(isFillerAdoptSource(s), s).toBe(adoptSourceIsPlaceholder(s));
    }
  });

  it("adoptRouteForSource's own distinction is NOT overruled", () => {
    /**
     * It maps `guaranteed` to `backfill`, not `fallback`, because it answers a different question:
     * which route filled the beat, not whether the picture depicts anything. Collapsing the two
     * would have been the easy mistake here.
     */
    expect(adoptRouteForSource("guaranteed")).toBe("backfill");
    expect(adoptRouteForSource("rescue_placeholder")).toBe("fallback");
    expect(lineageRouteIsPlaceholder(adoptRouteForSource("rescue_placeholder"))).toBe(true);
    expect(lineageRouteIsPlaceholder(adoptRouteForSource("youtube_cc"))).toBe(false);
  });
});
