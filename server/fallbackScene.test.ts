/**
 * G/H — THE FALLBACK SCENE: an unchecked picture is replaced, slot for slot, by a drawn scene with the
 * sentence's own words; it is never shown, never marked approved, and the film keeps its length.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_FORMAT, emptyTimeline, type ProjectTimeline, type TimelineVideoClip } from "./projectTimeline";
import { applyFallbackScenes, FALLBACK_SCENE_ID_PREFIX, fallbackSceneWords } from "./fallbackScene";
import { SYNTHETIC_PALETTES } from "./genericFootageFallback";

const clip = (id: string, a: number, b: number, beat: number, source: Partial<TimelineVideoClip["source"]>, over: Partial<TimelineVideoClip> = {}): TimelineVideoClip =>
  ({
    id,
    kind: "video",
    source: { provider: "youtube_cc", providerAssetId: `yt-${id}`, ...source },
    sourceIn: 10,
    sourceOut: 10 + (b - a),
    timelineStart: a,
    timelineEnd: b,
    sceneIndex: 0,
    beatIndex: beat,
    motion: "ken_burns_in",
    transitionIn: "hard_cut",
    transitionOut: "hard_cut",
    previewSource: "asset",
    ...over,
  }) as TimelineVideoClip;

function film(clips: TimelineVideoClip[], sentences = ["The Berlin Wall fell in 1989.", "Otto von Bismarck unified Germany.", "Crowds gathered at the border crossing."]): ProjectTimeline {
  const t = emptyTimeline(1, { ...DEFAULT_FORMAT });
  const v = t.tracks.find((x) => x.kind === "VIDEO");
  if (v?.kind === "VIDEO") v.clips = clips;
  t.durationSec = Math.max(...clips.map((c) => c.timelineEnd));
  t.sentences = sentences.map((text, i) => ({ sceneIndex: 0, beatIndex: i, startSec: i * 4, endSec: i * 4 + 4, timingBasis: "measured", text }));
  return t;
}
const checked = { contentApproval: "judge_fit" as const, textCheck: "clean" as const };
const gfx = (t: ProjectTimeline) => t.tracks.flatMap((x) => (x.kind === "GRAPHICS" ? x.graphics : []));
const videoClips = (t: ProjectTimeline) => t.tracks.flatMap((x) => (x.kind === "VIDEO" ? x.clips : []));

describe("G/H — the words of a fallback scene come from its own sentence", () => {
  it("year, else a name, else key words, else its first words; nothing for no text", () => {
    expect(fallbackSceneWords("The Berlin Wall fell in 1989.")).toEqual({ graphicType: "date_card", label: "1989" });
    expect(fallbackSceneWords("Then Otto von Bismarck unified Germany.")?.label).toBe("Otto von Bismarck");
    expect(fallbackSceneWords("crowds gathered at the border crossing")).toEqual({ graphicType: "emphasis", label: "crowds gathered" });
    expect(fallbackSceneWords("")).toBeNull();
    expect(fallbackSceneWords(null)).toBeNull();
  });
});

describe("G/H — replace, then strict", () => {
  it("a checked picture stays; an unchecked one becomes a fallback scene of EXACTLY its slot", () => {
    const t = film([
      clip("a", 0, 4, 0, checked),
      clip("b", 4, 8, 1, { contentApproval: "unverified", textCheck: "clean" }),
      clip("c", 8, 12, 2, { contentApproval: "judge_fit" }),
    ]);
    const lines: string[] = [];
    const r = applyFallbackScenes(t, (l) => lines.push(l));
    const [a, b, c] = videoClips(t);
    expect(a!.source.provider).toBe("youtube_cc");
    expect(r.replaced.map((x) => x.clipId)).toEqual(["b", "c"]);
    for (const x of [b!, c!]) {
      expect(x.source.provider).toBe("synthetic_placeholder");
      expect(x.source.contentApproval).toBe("generic_footage");
      expect(x.source.title).toMatch(/fallback scene \(not footage\)/);
    }
    expect([b!.timelineStart, b!.timelineEnd, c!.timelineStart, c!.timelineEnd]).toEqual([4, 8, 8, 12]);
    expect(t.durationSec).toBe(12);
    expect(lines.join("\n")).toMatch(/clip=c s0b2 slot=8\.00-12\.00s REPLACED youtube_cc:yt-c — no passed text check \(textCheck=absent\)/);
  });

  it("a refused picture is never marked approved — its marks leave with it", () => {
    const t = film([clip("b", 0, 4, 0, { contentApproval: "unverified", textCheck: "fills_picture" })]);
    applyFallbackScenes(t);
    const [b] = videoClips(t);
    expect(b!.source.contentApproval).not.toMatch(/judge_fit|judge_acceptable/);
    expect(b!.source.textCheck).toBeUndefined();
  });

  it("each fallback scene gets its sentence's words on screen, bottom left at the normal size, marked as fallback", () => {
    const t = film([clip("a", 0, 4, 0, { contentApproval: "unverified" }), clip("b", 4, 8, 1, { contentApproval: "unverified" }), clip("c", 8, 12, 2, checked)]);
    const r = applyFallbackScenes(t);
    expect(r.captioned.map((c) => c.text)).toEqual(["1989", "Otto von Bismarck"]);
    const g = gfx(t);
    expect(g.map((x) => x.id)).toEqual([`${FALLBACK_SCENE_ID_PREFIX}a`, `${FALLBACK_SCENE_ID_PREFIX}b`]);
    expect(g[0]).toMatchObject({ start: 0, end: 4, data: { fallbackScene: true, sceneIndex: 0, beatIndex: 0 }, style: { position: "bottom_left", fontSizePx: 52 } });
  });

  it("a scene with text already on screen gets no second text", () => {
    const t = film([clip("a", 0, 4, 0, { contentApproval: "unverified" })]);
    const g = t.tracks.find((x) => x.kind === "GRAPHICS");
    if (g?.kind === "GRAPHICS") g.graphics.push({ id: "map1", graphicType: "map_point", label: "Berlin", data: {}, start: 1, end: 3 } as never);
    const r = applyFallbackScenes(t);
    expect(r.captioned).toEqual([]);
    expect(r.withoutWords).toEqual([]);
  });

  it("no words to show: the scene is named, so the strict delivery check refuses it (needs a person)", () => {
    const t = film([clip("a", 0, 4, 0, { contentApproval: "unverified" })], [""]);
    const lines: string[] = [];
    const r = applyFallbackScenes(t, (l) => lines.push(l));
    expect(r.withoutWords).toEqual(["a"]);
    expect(lines.at(-1)).toMatch(/has NO words to show — the strict delivery check will refuse it/);
  });

  it("hidden grounds under a graphic, disabled clips and AI pictures kept by the owner's rule are left alone", () => {
    const t = film([
      clip("g_graphic1", 0, 4, 0, {}, { transform: { opacity: 0 } as never }),
      clip("d", 4, 8, 1, {}, { disabled: true } as never),
      clip("ai", 8, 12, 2, { contentApproval: "ai_generated" }),
    ]);
    const r = applyFallbackScenes(t);
    expect(r.replaced).toEqual([]);
  });

  it("an existing emergency colour field (from the pipeline) gets its words too", () => {
    const t = film([clip("p", 0, 4, 0, { provider: "synthetic_placeholder", providerAssetId: "synthetic-p1-4s", contentApproval: "generic_footage" })]);
    const r = applyFallbackScenes(t);
    expect(r.replaced).toEqual([]);
    expect(r.captioned[0]?.text).toBe("1989");
  });
});

describe("G/H — the fallback's colours: brand violet and warm, never blue or grey", () => {
  const hue = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r!, g!, b!);
    const min = Math.min(r!, g!, b!);
    if (max === min) return { h: null as number | null, s: 0 };
    const d = max - min;
    const h = max === r ? ((g! - b!) / d) % 6 : max === g ? (b! - r!) / d + 2 : (r! - g!) / d + 4;
    return { h: (h * 60 + 360) % 360, s: d / max };
  };
  it("every colour of every palette is saturated and outside the blue band (180°–255°)", () => {
    expect(SYNTHETIC_PALETTES.length).toBeGreaterThanOrEqual(4);
    for (const p of SYNTHETIC_PALETTES) {
      for (const c of p) {
        const { h, s } = hue(c);
        expect(h, c).not.toBeNull();
        expect(s, `${c} is grey`).toBeGreaterThan(0.25);
        expect(h! >= 180 && h! <= 255, `${c} is blue (hue ${h})`).toBe(false);
      }
    }
  });
});
