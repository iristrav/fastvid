/**
 * RONDE 149 — the video's look: colour grade, and the three light/lens effects.
 *
 * ── Why the grade is per-video and the calibration is per-source ─────────────────────────────
 *
 * The whole job of a look is to make a 1940s Library of Congress scan, a Pexels drone shot and a
 * generated establishing shot appear to belong in one film. So the CHOICE is one choice for the
 * whole video, and what varies per clip is only how hard the correction has to work — glossy stock
 * needs its saturation pulled further than a scan that is already washed out.
 *
 * `documentaryStyle` has held those three calibrations for a long time and they were tuned against
 * real material. This round connects them to the timeline; it does not re-tune them, and the tests
 * below assert exactly that — that the graded string IS documentaryStyle's own output, not a
 * lookalike.
 *
 * ── Determinism, again ───────────────────────────────────────────────────────────────────────
 *
 * A timeline with no look must render byte-identically to before. That is asserted first, because
 * if it fails the golden test is about to fail too and this says so in a millisecond.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ffmpegStatic from "ffmpeg-static";

import {
  DEFAULT_FORMAT,
  emptyTimeline,
  type ProjectTimeline,
  type TimelineLook,
  type TimelineVideoClip,
} from "./projectTimeline";
import { buildVideoFilter, containChain, effectChain, gradeChain } from "./timelineFilters";
import {
  buildPerClipDocumentaryGradeVF,
  docGradeSourceKindForProvider,
} from "./documentaryStyle";
import { renderTimeline, checkRenderedFile } from "./timelineRenderer";
import { RENDERABLE_EFFECTS } from "./edlToTimeline";

const execFileAsync = promisify(execFile);
const FFMPEG = (ffmpegStatic as unknown as string) || "ffmpeg";
const FMT = { widthPx: 320, heightPx: 180, fps: 25 };
const DOCUMENTARY: TimelineLook = { grade: "documentary" };

let ROOT = "";
let SOURCE = "";

beforeAll(async () => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "r149-"));
  SOURCE = path.join(ROOT, "src.mp4");
  await execFileAsync(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "smptebars=size=320x180:rate=25:duration=4",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", SOURCE,
  ]);
}, 300_000);

afterAll(() => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* a leftover temp dir is not worth failing a suite over */
  }
});

function clip(over: Partial<TimelineVideoClip> = {}): TimelineVideoClip {
  return {
    id: "vc_0",
    kind: "video",
    source: { provider: "loc", providerAssetId: "item/1", mediaUrl: "https://loc/1.mp4" },
    timelineStart: 0,
    timelineEnd: 4,
    motion: "none",
    transitionIn: "hard_cut",
    transitionOut: "hard_cut",
    previewSource: "asset",
    ...over,
  };
}

/* ═══════════════════════ determinism ═══════════════════════ */

describe("a timeline with no look renders exactly as before", () => {
  it("no look at all leaves the chain untouched", () => {
    expect(buildVideoFilter(clip(), FMT, 4)).toBe(containChain(FMT));
    expect(buildVideoFilter(clip(), FMT, 4, undefined)).toBe(containChain(FMT));
  });

  it('grade "none" is the same as no look — an explicit choice not to grade', () => {
    expect(buildVideoFilter(clip(), FMT, 4, { grade: "none" })).toBe(containChain(FMT));
    expect(gradeChain({ grade: "none" }, "archive")).toBeNull();
  });

  it("strength 0 produces no grade rather than a neutral one", () => {
    // A neutral eq= would still be a filter, and would still re-encode differently. Nothing is nothing.
    expect(gradeChain({ grade: "documentary", strength: 0 }, "stock")).toBeNull();
    expect(buildVideoFilter(clip(), FMT, 4, { grade: "documentary", strength: 0 })).toBe(containChain(FMT));
  });

  it("the same clip and look twice give the same string", () => {
    const c = clip({ sourceKind: "stock" });
    expect(buildVideoFilter(c, FMT, 4, DOCUMENTARY)).toBe(buildVideoFilter(c, FMT, 4, DOCUMENTARY));
  });
});

/* ═══════════════════════ the grade is documentaryStyle's own ═══════════════════════ */

describe("the grade comes from documentaryStyle, not from a second opinion", () => {
  it("AT FULL STRENGTH IT IS LITERALLY documentaryStyle's OUTPUT", () => {
    /**
     * The assertion that stops this round from quietly forking the calibration. If someone edits
     * the numbers here instead of in documentaryStyle, this fails — and the numbers there are the
     * ones that were tuned against real material.
     */
    for (const kind of ["archive", "stock", "ai_generated", "unknown"] as const) {
      expect(gradeChain(DOCUMENTARY, kind), kind).toBe(buildPerClipDocumentaryGradeVF(kind));
    }
  });

  it("the three source kinds really do grade differently", () => {
    const archive = gradeChain(DOCUMENTARY, "archive")!;
    const stock = gradeChain(DOCUMENTARY, "stock")!;
    const ai = gradeChain(DOCUMENTARY, "ai_generated")!;
    expect(new Set([archive, stock, ai]).size).toBe(3);
    // Stock is glossiest, so its saturation is pulled hardest of the three.
    expect(stock).toContain("saturation=0.82");
    expect(ai).toContain("saturation=0.78");
    expect(archive).toContain("saturation=0.88");
  });

  it("strength interpolates toward neutral instead of switching look", () => {
    const half = gradeChain({ grade: "documentary", strength: 0.5 }, "stock")!;
    // Halfway between 1.0 (neutral) and 0.82 (full) is 0.91.
    expect(half).toContain("saturation=0.9100");
    expect(half).toContain("contrast=1.0750");
    expect(half).toContain("vignette=");
  });

  it("strength above 1 is clamped, not extrapolated into a cartoon", () => {
    expect(gradeChain({ grade: "documentary", strength: 5 }, "archive")).toBe(
      buildPerClipDocumentaryGradeVF("archive")
    );
  });
});

/* ═══════════════════════ the source kind is derived, not chosen ═══════════════════════ */

describe("a clip's source kind follows from its provider", () => {
  it("institutional collections are archive", () => {
    for (const p of ["wikimedia", "loc", "nara", "nasa", "internet_archive", "europeana", "curated"]) {
      expect(docGradeSourceKindForProvider(p), p).toBe("archive");
    }
  });

  it("commercial stock is stock", () => {
    for (const p of ["pexels", "pixabay", "openverse", "youtube_cc"]) {
      expect(docGradeSourceKindForProvider(p), p).toBe("stock");
    }
  });

  it("generative sources get the hardest correction", () => {
    for (const p of ["kling", "runway", "veo", "grok"]) {
      expect(docGradeSourceKindForProvider(p), p).toBe("ai_generated");
    }
  });

  it("AN ARCHIVE ASSET ID WINS OVER THE PROVIDER NAME", () => {
    /**
     * An operator names their own archives, so "wwii_archive" is not in any fixed list and never
     * can be. The id says we ingested the file ourselves, which is what makes it archive material.
     */
    expect(docGradeSourceKindForProvider("wwii_archive", { archiveAssetId: 42 })).toBe("archive");
    expect(docGradeSourceKindForProvider("anything_at_all", { archiveAssetId: 1 })).toBe("archive");
  });

  it("a custom archive slug is still recognised without an id", () => {
    expect(docGradeSourceKindForProvider("nara_films_archive")).toBe("archive");
  });

  it("AN UNKNOWN PROVIDER IS 'unknown', NOT A GUESS AT 'archive'", () => {
    // Grading a glossy clip with the archive calibration leaves it glossy next to everything else —
    // the exact mismatch the grade exists to fix. Saying "unknown" gets the neutral default.
    expect(docGradeSourceKindForProvider("some_new_api")).toBe("unknown");
    expect(docGradeSourceKindForProvider("")).toBe("unknown");
    expect(docGradeSourceKindForProvider(null)).toBe("unknown");
  });
});

/* ═══════════════════════ order inside the chain ═══════════════════════ */

describe("where the grade sits in the chain, and why", () => {
  it("AFTER the camera — grading pixels that zoompan then discards would drift", () => {
    const s = buildVideoFilter(
      clip({ sourceKind: "stock", camera: { type: "slow_push", startScale: 1, endScale: 1.1 } }),
      FMT, 4, DOCUMENTARY
    );
    expect(s.indexOf("zoompan")).toBeLessThan(s.indexOf("eq=contrast"));
  });

  it("BEFORE the effects — grading grain turns a texture into coloured speckle", () => {
    const s = buildVideoFilter(
      clip({ sourceKind: "stock", effects: [{ effectType: "film_grain", intensity: 0.5 }] }),
      FMT, 4, DOCUMENTARY
    );
    expect(s.indexOf("eq=contrast")).toBeLessThan(s.indexOf("noise="));
  });

  it("after the fit, so a cover crop is graded and not the discarded edges", () => {
    const s = buildVideoFilter(
      clip({ sourceKind: "archive", transform: { fit: "cover" } }), FMT, 4, DOCUMENTARY
    );
    expect(s.indexOf("crop=320:180")).toBeLessThan(s.indexOf("eq=contrast"));
  });
});

/* ═══════════════════════ the new effects ═══════════════════════ */

describe("glow, bloom and chromatic aberration", () => {
  it("glow and bloom both split, blur and screen — and differ by radius", () => {
    const glow = effectChain({ effectType: "glow", intensity: 0.5 })!;
    const bloom = effectChain({ effectType: "bloom", intensity: 0.5 })!;
    for (const s of [glow, bloom]) {
      expect(s).toContain("split");
      expect(s).toContain("gblur=sigma=");
      // Screen only brightens, so the effect gathers in the highlights instead of fogging the shadows.
      expect(s).toContain("blend=all_mode=screen");
    }
    // A glow is a tight halo; a bloom is a wide wash. That difference IS the difference.
    expect(bloom).toContain("sigma=17.00");
    expect(glow).toContain("sigma=5.00");
  });

  it("their filter labels do not collide, so both can appear on one clip", () => {
    /**
     * Two split filters using the same label names would make the filtergraph ambiguous and ffmpeg
     * would refuse the whole command — a failure that only shows up when a planner happens to ask
     * for both.
     */
    const s = buildVideoFilter(
      clip({ effects: [
        { effectType: "glow", intensity: 0.5 },
        { effectType: "bloom", intensity: 0.5 },
      ] }),
      FMT, 4
    );
    expect(s).toContain("[glowa]");
    expect(s).toContain("[blooma]");
    expect(s).not.toContain("[glowa][blooma]");
  });

  it("chromatic aberration pulls red and blue in OPPOSITE directions", () => {
    // Shifting them the same way is a misregistered print, not a lens.
    const s = effectChain({ effectType: "chromatic_aberration", intensity: 1 })!;
    expect(s).toBe("rgbashift=rh=3:bh=-3");
  });

  it("chromatic aberration is capped at 3px — beyond that it reads as a broken video", () => {
    expect(effectChain({ effectType: "chromatic_aberration", intensity: 1 })).toContain("rh=3");
    // Even at the smallest intensity it is at least 1px, or it would be an invisible no-op filter.
    expect(effectChain({ effectType: "chromatic_aberration", intensity: 0 })).toContain("rh=1");
  });

  it("the adapter's list and the renderer's filters still agree", () => {
    for (const t of RENDERABLE_EFFECTS) {
      expect(effectChain({ effectType: t, intensity: 0.5 }), t).not.toBeNull();
    }
    expect(RENDERABLE_EFFECTS.has("glow")).toBe(true);
    expect(RENDERABLE_EFFECTS.has("bloom")).toBe(true);
    expect(RENDERABLE_EFFECTS.has("chromatic_aberration")).toBe(true);
  });
});

/* ═══════════════════════ REAL FFMPEG ═══════════════════════ */

describe("REAL FFMPEG — the graded chains encode", () => {
  const timelineWith = (clips: TimelineVideoClip[], look?: TimelineLook): ProjectTimeline => {
    const t = emptyTimeline(1, { ...DEFAULT_FORMAT, ...FMT });
    t.tracks = [{ kind: "VIDEO", clips }];
    t.durationSec = Math.max(...clips.map((c) => c.timelineEnd));
    t.look = look;
    return t;
  };

  const render = async (t: ProjectTimeline, name: string) => {
    const out = path.join(ROOT, `${name}.mp4`);
    await renderTimeline({
      timeline: t,
      workDir: path.join(ROOT, `w_${name}`),
      outputPath: out,
      resolveMedia: async () => SOURCE,
    });
    return { out, check: await checkRenderedFile({ filePath: out, timeline: t, expectAudio: false }) };
  };

  it("A GRADED RENDER PRODUCES DIFFERENT PIXELS FROM AN UNGRADED ONE", async () => {
    /**
     * Measured, not assumed. The two files are compared with ffmpeg's own difference blend and
     * signalstats — the same technique the golden test uses — so "the grade did something" is a
     * number and not a claim.
     */
    const plain = await render(timelineWith([clip()]), "plain");
    const graded = await render(timelineWith([clip({ sourceKind: "stock" })], DOCUMENTARY), "graded");
    expect(plain.check.ok).toBe(true);
    expect(graded.check.ok).toBe(true);

    /**
     * `metadata=print` writes to STDERR, not stdout — ffmpeg's filter logging always does. The
     * first version of this test read stdout, found no numbers, and failed while the grade was
     * working perfectly. `-loglevel info` is required for the same reason: the default hides it.
     */
    const { stderr } = await execFileAsync(FFMPEG, [
      "-hide_banner", "-loglevel", "info", "-i", plain.out, "-i", graded.out,
      "-filter_complex",
      "[0:v]format=gray[x];[1:v]format=gray[y];" +
        "[x][y]blend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YMAX",
      "-f", "null", "-",
    ], { maxBuffer: 1024 * 1024 * 32 });
    const readings = [...String(stderr).matchAll(/YMAX=(\d+)/g)].map((m) => Number(m[1]));
    expect(readings.length, "no YMAX readings came back from ffmpeg").toBeGreaterThan(0);
    const peak = Math.max(...readings);
    // A colour grade that moves the picture by less than 8/255 is not a grade anyone would see.
    expect(peak).toBeGreaterThan(8);
  }, 300_000);

  it("glow, bloom and chromatic aberration all encode on a real clip", async () => {
    const t = timelineWith([
      clip({
        id: "vc_0",
        sourceKind: "archive",
        effects: [
          { effectType: "glow", intensity: 0.4 },
          { effectType: "chromatic_aberration", intensity: 0.5 },
        ],
      }),
    ], DOCUMENTARY);
    const { check } = await render(t, "fx");
    expect(check.problems).toEqual([]);
    expect(check.hasVideo).toBe(true);
  }, 300_000);

  it("the grade works on a clip whose sourceKind was never written down", async () => {
    // The derivation path: provider "loc" → archive, with no field on the clip at all.
    const t = timelineWith([clip()], DOCUMENTARY);
    const { check } = await render(t, "derived");
    expect(check.ok).toBe(true);
  }, 300_000);
});
