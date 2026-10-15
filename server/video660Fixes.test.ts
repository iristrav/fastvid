/**
 * VIDEO 660 ("How Inflation Shook Europe in 2026", render 69) — the five fixes of the 15 October audit.
 *
 *   1  two moments of one YouTube video are two pictures, not one repeated picture
 *   2  a YouTube piece plays the source seconds not yet shown before it holds its last frame
 *   3  no flash of a neighbour's remainder after a fallback scene
 *   4  a percentage as a sentence's picture is a figure with its label, never a bare ring
 *   5  a fallback scene shows the sentence's name AND a short phrase of the sentence
 */
import { describe, expect, it } from "vitest";

import { footageKey, removeRepeatedFootage, sourceWindow } from "./noRepeatedFootage";
import type { TimelineVideoClip } from "./projectTimeline";
import { limitYoutubeShots, planYoutubePieces, type YoutubeSourceFacts } from "./youtubeShotLimit";
import { DEFAULT_FORMAT, emptyTimeline, type ProjectTimeline } from "./projectTimeline";
import { applyFallbackScenes, CARVE_FLASH_SEC, FALLBACK_SCENE_MAX_SHARE, fallbackSceneWords } from "./fallbackScene";
import { sentenceCoverage } from "./sentenceCoverage";
import { percentLabelFrom } from "./cinematicEditingEngine/motionGraphicsPlanner";

const yt = (id: string, start: number, end: number, beatIndex: number, archiveAssetId: number): TimelineVideoClip =>
  ({
    id,
    kind: "video",
    source: { provider: "youtube_cc", providerAssetId: "qhLHbY9kVR4", archiveAssetId, contentApproval: "judge_fit", textCheck: "clean" },
    sourceIn: 0,
    sourceOut: 4,
    timelineStart: start,
    timelineEnd: end,
    motion: "none",
    transitionIn: "hard_cut",
    transitionOut: "hard_cut",
    previewSource: "asset",
    sceneIndex: 2,
    beatIndex,
  }) as TimelineVideoClip;

describe("1 — two moments of one YouTube video are two pictures", () => {
  it("s2b1's own moments (454 s and 533 s, now two archive assets) stay on the timeline after s2b0's moment", () => {
    /** as on 660: s2b0's Lagarde moment, then s2b1's two approved moments of the same video */
    const film = [yt("vc_2467e7b881", 58.38, 62.38, 0, 61462), yt("vc_74ffbc8919", 64, 68, 1, 61490), yt("vc_b5cc7e88a0", 68, 72.26, 1, 61491)];
    const { clips, notes } = removeRepeatedFootage(film);
    expect(clips.map((c) => c.id)).toEqual(["vc_2467e7b881", "vc_74ffbc8919", "vc_b5cc7e88a0"]);
    expect(notes.join("\n")).not.toMatch(/REMOVED/);
    expect(new Set(film.map(footageKey)).size).toBe(3);
  });

  it("the SAME moment twice (one archive asset, the same seconds) is still a repeat and is taken out", () => {
    const film = [yt("a", 0, 4, 0, 61462), yt("b", 4, 8, 1, 61462)];
    const { clips, notes } = removeRepeatedFootage(film);
    expect(clips.map((c) => c.id)).toEqual(["a"]);
    expect(notes.join("\n")).toMatch(/REMOVED/);
  });
});

describe("2 — a YouTube piece plays the source seconds not yet shown before it holds", () => {
  const fourSeconds: YoutubeSourceFacts = { sourceDurationSec: 4.0, cutsSec: [], measured: true };

  it("7.06 s from a 4.00 s source: 0–3.53 plays, then 3.53–4.00 plays, then the last frame holds", () => {
    const plan = planYoutubePieces({ inSec: 0, durationSec: 7.06, facts: fourSeconds, slowRatherThanRepeat: true });
    expect(plan.pieces).toHaveLength(2);
    const [a, b] = plan.pieces;
    expect(a).toEqual({ inSec: 0, durationSec: 3.53 });
    expect(b!.hold).toBe(true);
    expect(b!.inSec).toBeCloseTo(3.53, 2);
    expect(b!.inSec + b!.readsSec!).toBeCloseTo(4.0, 2);
    /** every piece keeps its length: the total on screen is unchanged */
    expect(plan.pieces.reduce((s, p) => s + p.durationSec, 0)).toBeCloseTo(7.06, 2);
    expect(plan.notes.join(" ")).toMatch(/piece 2 plays 3\.53–4\.00s of the source, not yet shown/);
  });

  it("on the timeline: the second piece reads 3.53–4.00 and then holds; no second is read twice; the span is unchanged", () => {
    const yt = { ...ytClip("vc_1e256259c0", 8.02, 15.08), sourceOut: 4 };
    const before = { ...ytClip("vc_card_graphic1", 4.56, 8.02), source: { provider: "card" } } as TimelineVideoClip;
    const { clips } = limitYoutubeShots({ clips: [before, yt], youtube: new Map([["vc_1e256259c0", fourSeconds]]) });
    const pieces = clips.filter((c) => c.id.startsWith("vc_1e256259c0_p"));
    expect(pieces).toHaveLength(2);
    expect(pieces[0]!.sourceIn).toBe(0);
    expect(pieces[0]!.sourceOut).toBeCloseTo(3.53, 2);
    expect(pieces[1]!.sourceIn).toBeCloseTo(3.53, 2);
    expect(pieces[1]!.sourceOut).toBeCloseTo(4.0, 2);
    expect(pieces[1]!.holdAtSourceOut).toBe(true);
    const [w0, w1] = pieces.map(sourceWindow);
    expect(Math.min(w0![1], w1![1]) - Math.max(w0![0], w1![0])).toBeLessThanOrEqual(0.001);
    expect(pieces[0]!.timelineStart).toBe(8.02);
    expect(pieces[1]!.timelineEnd).toBe(15.08);
    /** and the repeat check sees nothing to take out */
    expect(removeRepeatedFootage(pieces).notes.join("\n")).not.toMatch(/REMOVED/);
  });

  it("a source with no unshown seconds left still holds its last frame (nothing invented)", () => {
    /** 8 s from 4.00 s: two windows of 4 s do not fit, one window of 4 s uses the whole file */
    const plan = planYoutubePieces({ inSec: 0, durationSec: 8, facts: fourSeconds, slowRatherThanRepeat: true });
    const held = plan.pieces.filter((p) => p.hold);
    expect(held.length).toBeGreaterThan(0);
    for (const h of held) expect(h.readsSec ?? 0.05).toBeLessThanOrEqual(0.05 + 1e-6);
  });

  it("the unshown seconds are never taken from a window already on screen", () => {
    /** a source cut at 5 s: windows sit in two shots; the remainder ends at its own shot's end */
    const facts: YoutubeSourceFacts = { sourceDurationSec: 9, cutsSec: [5], measured: true };
    const plan = planYoutubePieces({ inSec: 0, durationSec: 13, facts, slowRatherThanRepeat: true });
    const moving = plan.pieces.filter((p) => !p.hold).map((p) => [p.inSec, p.inSec + p.durationSec] as const);
    for (const h of plan.pieces.filter((p) => p.hold && p.readsSec)) {
      const [from, to] = [h.inSec, h.inSec + h.readsSec!];
      for (const [a, b] of moving) expect(Math.min(to, b) - Math.max(from, a)).toBeLessThanOrEqual(0.001);
      /** inside one shot, clear of the cut at 5 s */
      expect(from >= 5 || to <= 5 - 0.25 + 1e-6).toBe(true);
    }
  });
});

function ytClip(id: string, start: number, end: number): TimelineVideoClip {
  return {
    ...yt(id, start, end, 0, 70001),
    source: { provider: "youtube_cc", providerAssetId: "abc", contentApproval: "judge_fit", textCheck: "clean" },
  } as TimelineVideoClip;
}

describe("2b — a later held piece first plays a shot of the source that no piece showed", () => {
  it("13 s from a 9 s source cut at 5 s: the shot after the cut is played before any frame holds", () => {
    const facts: YoutubeSourceFacts = { sourceDurationSec: 9, cutsSec: [5], measured: true };
    const plan = planYoutubePieces({ inSec: 0, durationSec: 13, facts, slowRatherThanRepeat: true });
    /** 0–4.33 plays; 4.33–4.75 (up to the cut margin) continues it; 5.25–9.00 plays; only then a hold */
    const read = plan.pieces.map((p) => [p.inSec, p.inSec + (p.hold ? p.readsSec ?? 0.05 : p.durationSec)]);
    expect(read.some(([a, b]) => a! >= 5.25 - 1e-6 && b! <= 9 + 1e-6 && b! - a! >= 1.5)).toBe(true);
    /** no two pieces read the same seconds */
    for (let i = 0; i < read.length; i++)
      for (let j = i + 1; j < read.length; j++)
        expect(Math.min(read[i]![1]!, read[j]![1]!) - Math.max(read[i]![0]!, read[j]![0]!)).toBeLessThanOrEqual(0.06);
    expect(plan.pieces.reduce((s, p) => s + p.durationSec, 0)).toBeCloseTo(13, 2);
  });

  it("an unshown shot shorter than 1.5 s is not played as a flash; the piece holds instead", () => {
    /** 4 s file cut at 2.9 s: the second shot is 0.85 s once clear of the cut */
    const facts: YoutubeSourceFacts = { sourceDurationSec: 4, cutsSec: [2.9], measured: true };
    const plan = planYoutubePieces({ inSec: 0, durationSec: 5, facts, slowRatherThanRepeat: true });
    for (const p of plan.pieces) expect(p.inSec < 2.9 + 0.25 - 1e-6 || !p.hold || (p.readsSec ?? 0) <= 0.05).toBe(true);
  });
});

/* ═══════════ 3 — no flash of a neighbour's remainder after a fallback scene ═══════════ */

const checked = { contentApproval: "judge_fit" as const, textCheck: "clean" as const };
const shot = (id: string, a: number, b: number, beat: number, over: Partial<TimelineVideoClip> = {}): TimelineVideoClip =>
  ({
    id,
    kind: "video",
    source: { provider: "youtube_cc", providerAssetId: `yt-${id}`, ...checked },
    sourceIn: 0,
    sourceOut: b - a,
    timelineStart: a,
    timelineEnd: b,
    sceneIndex: 2,
    beatIndex: beat,
    motion: "none",
    transitionIn: "hard_cut",
    transitionOut: "hard_cut",
    previewSource: "asset",
    ...over,
  }) as TimelineVideoClip;

function film660(clips: TimelineVideoClip[], windows: Array<[number, number]>): ProjectTimeline {
  const t = emptyTimeline(1, { ...DEFAULT_FORMAT });
  const v = t.tracks.find((x) => x.kind === "VIDEO");
  if (v?.kind === "VIDEO") v.clips = clips;
  t.durationSec = Math.max(...clips.map((c) => c.timelineEnd));
  const texts = [
    "Christine Lagarde said the ECB would keep rates on hold.",
    "Lagarde told reporters at the ECB that inflation in the euro area remained too high for comfort.",
    "Markets in Frankfurt fell the same afternoon.",
  ];
  t.sentences = windows.map(([a, b], i) => ({ sceneIndex: 2, beatIndex: i, startSec: a, endSec: b, timingBasis: "measured", text: texts[i] ?? "" }));
  return t;
}
const on = (t: ProjectTimeline) =>
  t.tracks.flatMap((x) => (x.kind === "VIDEO" ? x.clips : [])).filter((c) => !c.disabled).sort((a, b) => a.timelineStart - b.timelineStart);
const gapFree = (clips: TimelineVideoClip[]) => clips.every((c, i) => i === 0 || Math.abs(c.timelineStart - clips[i - 1]!.timelineEnd) < 0.001);

describe("3 — the carve leaves no flash of under 0.75 s", () => {
  it("render 69: s2b0's held picture ran 0.33 s past s2b1 (72.26–72.59) — the fallback scene takes that 0.33 s, the next shot starts at 72.59 as before", () => {
    const t = film660(
      [shot("vc_2467e7b881_p4", 58.38, 72.59, 0, { sourceIn: 0, sourceOut: 14.21 }), shot("vc_s2b2", 72.59, 76, 2)],
      [[58.38, 64], [64, 72.26], [72.59, 76]]
    );
    const lines: string[] = [];
    const r = applyFallbackScenes(t, (l) => lines.push(l));
    expect(r.carved.map((c) => [c.sentence, c.slot])).toEqual([["s2b1", [64, 72.59]]]);
    const clips = on(t);
    expect(clips.map((c) => [c.id, c.timelineStart, c.timelineEnd])).toEqual([
      ["vc_2467e7b881_p4", 58.38, 64],
      ["vc_fallback_s2b1", 64, 72.59],
      ["vc_s2b2", 72.59, 76],
    ]);
    /** nothing shorter than the flash limit, no gap, no clip twice, the film keeps its length */
    expect(clips.every((c) => c.timelineEnd - c.timelineStart >= CARVE_FLASH_SEC)).toBe(true);
    expect(gapFree(clips)).toBe(true);
    expect(new Set(clips.map((c) => c.id)).size).toBe(clips.length);
    expect(Math.max(...clips.map((c) => c.timelineEnd))).toBe(76);
    expect(lines.join("\n")).toMatch(/its 0\.33s after the sentence goes to the fallback scene/);
    /** still honestly a fallback scene, and the sentence is covered by it */
    expect(clips[1]!.source.title).toMatch(/fallback scene \(not footage\)/);
    expect(sentenceCoverage(t).sentences.find((x) => x.key === "s2b1")!.fallbackSceneSec).toBeGreaterThan(8);
  });

  it("a remainder of 0.75 s or more is a real shot and stays", () => {
    const t = film660([shot("a", 0, 9.5, 0, { sourceOut: 9.5 }), shot("c", 9.5, 12, 2)], [[0, 4], [4, 8.5], [9.5, 12]]);
    applyFallbackScenes(t);
    expect(on(t).map((c) => [c.id, c.timelineStart, c.timelineEnd])).toEqual([
      ["a", 0, 4],
      ["vc_fallback_s2b1", 4, 8.5],
      ["a_after_s2b1", 8.5, 9.5],
      ["c", 9.5, 12],
    ]);
  });

  it("a short remainder that is the next sentence's OWN picture stays (deliberate), and so does a short shot the carve never touched", () => {
    /** s2b2's own picture starts 0.3 s before its sentence; a 0.5 s shot of s2b2 follows it */
    const t = film660(
      [shot("a", 0, 7.9, 0, { sourceOut: 7.9 }), shot("own", 7.9, 8.5, 2), shot("short", 8.5, 9.0, 2), shot("c", 9.0, 12, 2)],
      [[0, 4], [4, 8.2], [8.2, 12]]
    );
    applyFallbackScenes(t);
    const clips = on(t);
    expect(clips.map((c) => [c.id, c.timelineStart, c.timelineEnd])).toEqual([
      ["a", 0, 4],
      ["vc_fallback_s2b1", 4, 8.2],
      ["own", 8.2, 8.5],
      ["short", 8.5, 9.0],
      ["c", 9.0, 12],
    ]);
    expect(gapFree(clips)).toBe(true);
  });

  it("a remainder before the sentence that is no sentence's own picture goes to the fallback scene too", () => {
    /** s2b2's picture (beat 2) sits before s2b1 by mistake for 0.4 s — nobody's own picture there */
    const t = film660([shot("a", 0, 3.6, 0, { sourceOut: 3.6 }), shot("x", 3.6, 8, 2), shot("c", 8, 12, 2)], [[0, 3.6], [4, 8], [8, 12]]);
    applyFallbackScenes(t);
    const clips = on(t);
    expect(clips.map((c) => [c.id, c.timelineStart, c.timelineEnd])).toEqual([
      ["a", 0, 3.6],
      ["vc_fallback_s2b1", 3.6, 8],
      ["c", 8, 12],
    ]);
    expect(gapFree(clips)).toBe(true);
  });
});

/* ═══════════ 4 — a percentage says what it is a percentage of ═══════════ */

describe("4 — the label of a percentage graphic comes from its own sentence", () => {
  it("660 s0b0: 'By mid-2026, Europe's inflation soared past 10%, …' → 'Europe's inflation soared', not '10%'", () => {
    expect(percentLabelFrom("By mid-2026, Europe's inflation soared past 10%, leaving store shelves empty.", "10")).toBe(
      "Europe's inflation soared"
    );
  });

  it("no words besides the figure: no label is invented", () => {
    expect(percentLabelFrom("10%.", "10")).toBeNull();
  });
});

/* ═══════════ 5 — a fallback scene shows the name AND a short phrase of its sentence ═══════════ */

describe("5 — the words of a fallback scene", () => {
  const S2B1 = "By loosening monetary controls while boosting economic support, the ECB aimed to steady prices.";

  it("660 s2b1: no longer 'ECB' alone — 'ECB' with 'loosening monetary controls' under it", () => {
    expect(fallbackSceneWords(S2B1)).toEqual({ graphicType: "lower_third", label: "ECB", phrase: "loosening monetary controls" });
  });

  it("nothing is invented: every word shown is a word of the sentence", () => {
    for (const text of [
      S2B1,
      "In 2026, energy bills doubled across European households, sparking protests.",
      "Christine Lagarde announced the European Central Bank's unprecedented move.",
      "But could this gamble restore Europe's trust?",
      "Crowds gathered at the border crossing.",
    ]) {
      const w = fallbackSceneWords(text)!;
      const said = new Set(text.replace(/[.,;:!?]/g, " ").split(/\s+/).filter(Boolean));
      for (const word of `${w.label} ${w.phrase ?? ""}`.split(/\s+/).filter(Boolean)) expect(said.has(word), `${word} in "${text}"`).toBe(true);
    }
  });

  it("on the timeline: the fallback scene carries both lines, stays a named fallback (not footage), and an approved picture is never replaced", () => {
    const t = film660(
      [shot("vc_2467e7b881_p4", 58.38, 72.59, 0, { sourceIn: 0, sourceOut: 14.21 }), shot("vc_s2b2", 72.59, 76, 2)],
      [[58.38, 64], [64, 72.26], [72.59, 76]]
    );
    t.sentences![1] = { ...t.sentences![1]!, text: S2B1 };
    const lines: string[] = [];
    const r = applyFallbackScenes(t, (l) => lines.push(l));
    expect(r.replaced).toEqual([]);
    expect(r.captioned).toEqual([
      { clipId: "vc_fallback_s2b1", graphicId: "gfx_fallback_vc_fallback_s2b1", text: "ECB — loosening monetary controls", graphicType: "lower_third" },
    ]);
    const g = t.tracks.flatMap((x) => (x.kind === "GRAPHICS" ? x.graphics : [])).find((x) => x.id === "gfx_fallback_vc_fallback_s2b1")!;
    expect(g).toMatchObject({ graphicType: "lower_third", label: "ECB", data: { subtitle: "loosening monetary controls", fallbackScene: true } });
    expect(lines.join("\n")).toMatch(/words="ECB — loosening monetary controls" \(lower_third\) — fallback scene, not footage/);
    /** the approved pictures keep their approval and their source */
    const kept = on(t).filter((c) => c.id !== "vc_fallback_s2b1");
    expect(kept.every((c) => c.source.provider === "youtube_cc" && c.source.contentApproval === "judge_fit")).toBe(true);
    /** the fallback is never counted as footage, and the share limit is unchanged */
    const row = sentenceCoverage(t).sentences.find((x) => x.key === "s2b1")!;
    expect(row.approvedFootageSec ?? 0).toBe(0);
    expect(row.fallbackSceneSec).toBeGreaterThan(8);
    expect(FALLBACK_SCENE_MAX_SHARE).toBe(0.5);
  });
});
