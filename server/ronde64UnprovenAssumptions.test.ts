import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { inferClipSourceFromPath } from "./videoPipeline";
import { buildVoiceVisualMatchSummary, isDegradedRescueSource } from "./voiceVisualMatch";
import type { ClipAdoptEntry } from "./clipAdoptAudit";

/**
 * RONDE 64 — the assumptions, and the two things never chased.
 *
 * Everything built after render 532 rests on guesses about a provider we cannot call from here.
 * The YouTube duration fix in particular assumed the RapidAPI response carries lengthSeconds —
 * an assumption with no evidence behind it, in a round whose predecessor (the watch page) was
 * fully tested and did nothing in production.
 *
 * It turns out none of it was necessary. That route downloads the ENTIRE source video and only
 * then trims it, so the real duration is sitting on disk before the cut is made. Probing the
 * file removes the guess entirely.
 *
 * And two items from render 532's quality report that had never been looked at:
 *
 *   [Quality] 5 clip(s) met onbekende bron.
 *   [Quality] 21 beat(s) via rescue-tier (degraded CLIP match of placeholder)
 */

const PIPELINE = () => fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

describe("RONDE 64 — the duration comes off the file, not off a guess", () => {
  it("the start is resolved against the downloaded source before the trim", () => {
    const src = PIPELINE();
    const idx = src.indexOf("export async function resolveTrimStartSec(");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 1600);
    expect(block).toContain("probeVideoDurationSec(sourcePath)");
    expect(block).toContain("pickLongVideoStartSec(sourceDur, takeSec, seedId)");
  });

  it("a start the transcript LOCATED is honoured, not improved on", () => {
    const src = PIPELINE();
    const idx = src.indexOf("export async function resolveTrimStartSec(");
    const block = src.slice(idx, idx + 1600);
    expect(block).toContain("const start = startIsExact\n    ? requestedStart");
    // And only a transcript hit sets that flag.
    expect(src).toContain('startIsExact = plan.method === "transcript";');
  });

  it("an unprobeable source keeps the caller's start rather than resetting it", () => {
    const src = PIPELINE();
    const idx = src.indexOf("export async function resolveTrimStartSec(");
    const block = src.slice(idx, idx + 1600);
    expect(block).toContain("if (!Number.isFinite(sourceDur) || sourceDur <= 0) return Math.max(0, requestedStart);");
  });

  it("the start can never point past the end of the file", () => {
    const src = PIPELINE();
    const idx = src.indexOf("export async function resolveTrimStartSec(");
    const block = src.slice(idx, idx + 1600);
    // Nothing clamped this before: a blind 12s offset on an 8s video asked ffmpeg for a second
    // that was not there, and the size check downstream can wave a frozen frame through.
    expect(block).toContain("const latest = Math.max(0, sourceDur - takeSec);");
    expect(block).toContain("return Math.max(0, Math.min(start, latest));");
  });

  it("the RapidAPI trim uses the resolved start, and says when it moved", () => {
    const src = PIPELINE();
    const idx = src.indexOf("resolveTrimStartSec(\n                tmpPath, clipStart, duration, videoId, startIsExact\n              )");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 900);
    expect(block).toContain("trim start ${clipStart.toFixed(1)}s");
    expect(block).toContain("resolvedStart,");
  });
});

describe("RONDE 64 — a clip whose adoption was never recorded is still identifiable", () => {
  it("reads the provider-asset tag, which names the provider outright", () => {
    expect(inferClipSourceFromPath("scene_1_b0_ia_archive_0__pid_internet_archive-39d7be54.mp4"))
      .toBe("internet_archive");
    expect(inferClipSourceFromPath("scene_0_b1_pool_pexels_35637677__pid_pexels-66d41b84.mp4"))
      .toBe("pexels");
    expect(inferClipSourceFromPath("scene_2_b0_pool_wikimedia_File_X__pid_wikimedia-70a04d52.mp4"))
      .toBe("wikimedia");
  });

  it("names the five clips render 532 could only call unknown", () => {
    // The actual basenames from that manifest.
    expect(inferClipSourceFromPath("scene_0_b0_curated_a55995.mp4")).toBe("archive");
    expect(inferClipSourceFromPath("extend_s2b0_1787639883101.mp4")).toBe("rescue_extend");
  });

  it("falls back through the pool tag when there is no pid", () => {
    expect(inferClipSourceFromPath("scene_1_b4_pool_pexels_36337624.mp4")).toBe("pexels");
  });

  it("still answers unknown when the name genuinely says nothing", () => {
    expect(inferClipSourceFromPath("clip.mp4")).toBe("unknown");
    expect(inferClipSourceFromPath("scene_0_b0.mp4")).toBe("unknown");
  });

  it("everything it recognised before, it still recognises", () => {
    expect(inferClipSourceFromPath("scene_0_ytcc_0.mp4")).toBe("youtube");
    expect(inferClipSourceFromPath("scene_0_wiki0v_wikivid_1.mp4")).toBe("wikimedia");
    expect(inferClipSourceFromPath("scene_1_b0_uniq_ov_openverse_afb.mp4")).toBe("openverse");
    expect(inferClipSourceFromPath("scene_0_b0_ai_fallback.mp4")).toBe("ai");
    expect(inferClipSourceFromPath("scene_0_b0_fallback.mp4")).toBe("fallback");
  });

  it("the manifest says whether the source was recorded or inferred", () => {
    const src = PIPELINE();
    const idx = src.indexOf("[FINAL_VISUAL_MANIFEST]");
    const block = src.slice(Math.max(0, idx - 900), idx + 400);
    expect(block).toContain('const origin = entry ? "recorded" : source === "unknown" ? "none" : "inferred";');
    expect(block).toContain("origin=${origin}");
    // Inferring is the last resort — a recorded entry always wins.
    expect(block).toContain("const inferred = entry ? null : inferClipSourceFromPath(basename);");
  });
});

describe("RONDE 64 — 'rescue-tier' was three different things in one number", () => {
  const entry = (source: string): ClipAdoptEntry =>
    ({
      sceneIndex: 0,
      beatIndex: 0,
      beatText: "In April 1945, Hitler married Eva Braun.",
      basename: `scene_0_${source}.mp4`,
      source,
      visionScore10: 8,
    }) as ClipAdoptEntry;

  it("real footage found on a second pass is not a degradation", () => {
    for (const s of ["rescue_archive", "rescue_wikimedia", "rescue_similar", "rescue_stock"]) {
      expect(isDegradedRescueSource(s)).toBe(false);
    }
  });

  it("a placeholder, a held clip, a graphic and generated footage are", () => {
    for (const s of ["rescue_placeholder", "rescue_extend", "rescue_graphic", "rescue_ai"]) {
      expect(isDegradedRescueSource(s)).toBe(true);
    }
  });

  it("an archive render of real footage is now ok, where it never could be before", () => {
    const summary = buildVoiceVisualMatchSummary(
      [entry("rescue_archive"), entry("rescue_wikimedia"), entry("rescue_similar")],
      ["/tmp/a.mp4"],
      []
    );
    expect(summary.rescueBeats).toBe(3);
    expect(summary.degradedBeats).toBe(0);
    expect(summary.rescueSourcedBeats).toBe(3);
    // ok required rescueBeats === 0, which for this pipeline was unreachable — so it was false
    // on every render and told you nothing.
    expect(summary.ok).toBe(true);
  });

  it("a montage that actually settled for less is still not ok", () => {
    const summary = buildVoiceVisualMatchSummary(
      [entry("rescue_archive"), entry("rescue_extend"), entry("rescue_placeholder")],
      ["/tmp/a.mp4"],
      []
    );
    expect(summary.degradedBeats).toBe(2);
    expect(summary.rescueSourcedBeats).toBe(1);
    expect(summary.ok).toBe(false);
  });

  it("the warning names what is actually missing, not 'degraded CLIP match'", () => {
    const summary = buildVoiceVisualMatchSummary([entry("rescue_extend")], ["/tmp/a.mp4"], []);
    const warning = summary.warnings.find((w) => w.includes("zonder eigen beeld"));
    expect(warning).toBeDefined();
    expect(warning).toContain("1 beat(s)");
    // The old wording claimed a placeholder for every rescue route.
    expect(summary.warnings.some((w) => w.includes("degraded CLIP match of placeholder"))).toBe(false);
  });

  it("the informational count is reported separately, and does not fail the render", () => {
    const summary = buildVoiceVisualMatchSummary([entry("rescue_archive")], ["/tmp/a.mp4"], []);
    expect(summary.warnings.some((w) => w.includes("echt beeld"))).toBe(true);
    expect(summary.ok).toBe(true);
  });

  it("the other failure conditions are untouched", () => {
    expect(buildVoiceVisualMatchSummary([entry("fallback")], ["/tmp/a.mp4"], []).ok).toBe(false);
    expect(buildVoiceVisualMatchSummary([], ["/tmp/a_guaranteed.mp4"], []).ok).toBe(false);
    expect(buildVoiceVisualMatchSummary([], ["/tmp/a.mp4"], [2]).ok).toBe(false);
  });

  it("render 532's own numbers now read as what they were", () => {
    // 4 rescue_archive + 3 rescue_extend, from that manifest.
    const audit = [
      ...Array.from({ length: 4 }, () => entry("rescue_archive")),
      ...Array.from({ length: 3 }, () => entry("rescue_extend")),
    ];
    const summary = buildVoiceVisualMatchSummary(audit, ["/tmp/a.mp4"], []);
    expect(summary.rescueBeats).toBe(7);
    // Three beats genuinely had no picture of their own; four were real archive footage.
    expect(summary.degradedBeats).toBe(3);
    expect(summary.rescueSourcedBeats).toBe(4);
  });
});
