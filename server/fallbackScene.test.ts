/**
 * G/H — THE FALLBACK SCENE: an unchecked picture is replaced, slot for slot, by a drawn scene with the
 * sentence's own words; it is never shown, never marked approved, and the film keeps its length.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_FORMAT, emptyTimeline, type ProjectTimeline, type TimelineVideoClip } from "./projectTimeline";
import { applyFallbackScenes, FALLBACK_SCENE_ID_PREFIX, fallbackSceneWords } from "./fallbackScene";
import { SYNTHETIC_PALETTES } from "./genericFootageFallback";
import { sentenceCoverage } from "./sentenceCoverage";

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
  it("year, else a name — with a short phrase of the sentence under it (VIDEO 660) — else key words, else its first words; nothing for no text", () => {
    expect(fallbackSceneWords("The Berlin Wall fell in 1989.")).toEqual({ graphicType: "lower_third", label: "1989", phrase: "Berlin Wall fell" });
    expect(fallbackSceneWords("Then Otto von Bismarck unified Germany.")).toMatchObject({ label: "Otto von Bismarck", phrase: "unified Germany" });
    /** a year with nothing else to say stays a date card */
    expect(fallbackSceneWords("In 1989.")).toEqual({ graphicType: "date_card", label: "1989" });
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
    expect(r.captioned.map((c) => c.text)).toEqual(["1989 — Berlin Wall fell", "Otto von Bismarck — unified Germany"]);
    const g = gfx(t);
    expect(g.map((x) => x.id)).toEqual([`${FALLBACK_SCENE_ID_PREFIX}a`, `${FALLBACK_SCENE_ID_PREFIX}b`]);
    expect(g[0]).toMatchObject({
      start: 0,
      end: 4,
      label: "1989",
      data: { fallbackScene: true, sceneIndex: 0, beatIndex: 0, subtitle: "Berlin Wall fell" },
      style: { position: "bottom_left", fontSizePx: 52 },
    });
  });

  it("a scene with text already on screen gets no second text", () => {
    const t = film([clip("a", 0, 4, 0, { contentApproval: "unverified" })], ["The Berlin Wall fell in 1989."]);
    const g = t.tracks.find((x) => x.kind === "GRAPHICS");
    if (g?.kind === "GRAPHICS") g.graphics.push({ id: "map1", graphicType: "map_point", label: "Berlin", data: {}, start: 1, end: 3 } as never);
    const r = applyFallbackScenes(t);
    expect(r.captioned).toEqual([]);
    expect(r.withoutWords).toEqual([]);
  });

  it("no words to show: the bare colour field stands in and is named an emergency placeholder (always a video)", () => {
    const t = film([clip("a", 0, 4, 0, { contentApproval: "unverified" })], [""]);
    const lines: string[] = [];
    const r = applyFallbackScenes(t, (l) => lines.push(l));
    expect(r.withoutWords).toEqual(["a"]);
    expect(lines.at(-1)).toMatch(/has NO words to show — the bare colour field stands in, named an emergency placeholder/);
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
    expect(r.captioned[0]?.text).toBe("1989 — Berlin Wall fell");
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

/* ═══════════ VIDEO 660 — a sentence with no picture of its own ═══════════ */

describe("VIDEO 660: a sentence with no picture of its own gets its own fallback scene", () => {
  it("the last sentence under the previous sentence's held picture: the picture stops at the sentence, a fallback scene with its words takes the sentence", () => {
    /** as on 660: s0b1's picture runs 4–12 s over 3.11 s of source; s0b2 (8–12 s) has nothing of its own */
    const t = film([clip("a", 0, 4, 0, checked), clip("b", 4, 12, 1, checked, { sourceIn: 10, sourceOut: 13.11, holdAtSourceOut: true })]);
    expect(sentenceCoverage(t).sentences.find((r) => r.key === "s0b2")?.status).toBe("uncovered");
    const lines: string[] = [];
    const r = applyFallbackScenes(t, (l) => lines.push(l));
    expect(r.carved).toEqual([{ sentence: "s0b2", clipId: "vc_fallback_s0b2", slot: [8, 12], trimmed: ["b ends at 8.00s"] }]);
    const [a, b, scene] = videoClips(t);
    expect([a!.id, b!.id, scene!.id]).toEqual(["a", "b", "vc_fallback_s0b2"]);
    expect([b!.timelineStart, b!.timelineEnd]).toEqual([4, 8]);
    expect(b!.source.contentApproval).toBe("judge_fit");
    expect([scene!.timelineStart, scene!.timelineEnd, scene!.sceneIndex, scene!.beatIndex]).toEqual([8, 12, 0, 2]);
    expect(scene!.source.provider).toBe("synthetic_placeholder");
    /** its own words on it, and the film keeps its length */
    expect(r.captioned.map((c) => [c.clipId, c.text])).toEqual([["vc_fallback_s0b2", "Crowds gathered"]]);
    expect(Math.max(...videoClips(t).map((c) => c.timelineEnd))).toBe(12);
    const row = sentenceCoverage(t).sentences.find((x) => x.key === "s0b2")!;
    expect(row.fallbackSceneSec).toBeCloseTo(4, 2);
    expect(lines.join("\n")).toMatch(/\[FallbackScene\] s0b2 slot=8\.00-12\.00s had NO picture of its own .* — a fallback scene of exactly this sentence \(not footage\); b ends at 8\.00s/);
  });

  it("a neighbour that runs THROUGH the sentence is split around it: its head before, its tail after, never shown twice", () => {
    /** s0b0's picture runs 0–10 s, under s0b1 (4–8 s) which has nothing of its own; s0b2 has its own picture at 10–12 s */
    const t = film([clip("a", 0, 10, 0, checked, { sourceIn: 0, sourceOut: 10 }), clip("c", 10, 12, 2, checked)]);
    t.sentences![0] = { ...t.sentences![0]!, endSec: 4 };
    t.sentences![2] = { ...t.sentences![2]!, startSec: 8, endSec: 12 };
    const r = applyFallbackScenes(t);
    expect(r.carved.map((c) => c.sentence)).toEqual(["s0b1"]);
    const clips = videoClips(t).filter((c) => !c.disabled);
    expect(clips.map((c) => [c.id, c.timelineStart, c.timelineEnd])).toEqual([
      ["a", 0, 4],
      ["vc_fallback_s0b1", 4, 8],
      ["a_after_s0b1", 8, 10],
      ["c", 10, 12],
    ]);
    /** the tail reads on from where the sentence ended: 8 s into the source, never its start again */
    expect(clips[2]!.sourceIn).toBe(8);
    expect(clips[2]!.transitionIn).toBe("hard_cut");
  });

  it("a film where every sentence has its own picture is left exactly as it is", () => {
    const t = film([clip("a", 0, 4, 0, checked), clip("b", 4, 8, 1, checked), clip("c", 8, 12, 2, checked)]);
    const before = JSON.stringify(videoClips(t));
    expect(applyFallbackScenes(t).carved).toEqual([]);
    expect(JSON.stringify(videoClips(t))).toBe(before);
  });
});
