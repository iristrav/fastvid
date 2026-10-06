/**
 * VIDEO 635 — "How Elon Musk Built Tesla Into a Global Brand": 4 of 11 sentences had a picture.
 *
 *   A   a shot a little longer than its source is slowed, never replayed from its start
 *   B   the Judge hears the line, not the planner's imagined shot; a line about money, a deal,
 *       a decision or criticism may show the company and its people at work, in its period
 *   C   a word of the user's own prompt, or a name the narration writes, is never traded for a year
 *       or replaced by a person; a YouTube query asks for FOOTAGE and keeps asking for it
 *   D   the renderer reads the file once, slowed, instead of looping its start (CuratedTrim)
 */
import { describe, expect, it } from "vitest";

import { limitLongShots, MIN_STRETCH_SPEED } from "./longShotLimit";
import { buildBeatImagePrompt } from "./beatImageRelevanceGate";
import { narrowToCanonicalQuery, searchGateDecision, withSearchProvenance, type VerifiedQueryContext } from "./searchQueryContract";
import { planVideoQuery, type PlannerInput } from "./youtubeVideoSearchPlanner";
import { buildVerifiedQueryContextForBeat } from "./videoPipeline";
import { MIN_FIT_SPEED, speedThatFitsSource } from "./timelineRenderer";
import type { TimelineVideoClip } from "./projectTimeline";

/* ═══════════════════════ A ═══════════════════════ */

const clip = (id: string, start: number, end: number, sourceIn: number, sourceOut: number, extra: Partial<TimelineVideoClip> = {}) =>
  ({
    id, kind: "video", source: { provider: "archive", archiveAssetId: 58483 },
    sourceIn, sourceOut, timelineStart: start, timelineEnd: end,
    motion: "none", transitionIn: "hard_cut", transitionOut: "hard_cut", sceneIndex: 1, ...extra,
  }) as TimelineVideoClip;

/** Every second of source the clips read, as [in, out) intervals. */
const reads = (clips: TimelineVideoClip[]) => clips.map((c) => [c.sourceIn!, c.sourceOut!] as const);

describe("A — a shot is never replayed from its start because it sits a little longer than its source", () => {
  it("s1b1: 8.30 s on screen over 7.98 s of source — two pieces, read once and in order, slowed", () => {
    const { clips } = limitLongShots({ clips: [clip("vc_9d17851670", 23.73, 32.03, 0, 7.98)] });
    expect(clips).toHaveLength(2);
    const [a, b] = clips;
    expect(b!.sourceIn, "the second piece does NOT start at the window's beginning").toBeGreaterThan(3.9);
    expect(b!.sourceIn).toBeCloseTo(a!.sourceOut!, 2);
    expect(b!.sourceOut).toBeCloseTo(7.98, 2);
    for (const c of clips) {
      expect(c.speed).toBeCloseTo(7.98 / 8.3, 3);
      expect(c.speed!).toBeGreaterThanOrEqual(MIN_STRETCH_SPEED);
      expect(c.timelineEnd - c.timelineStart).toBeLessThanOrEqual(6 + 0.001);
    }
    /** What the renderer reads (slot × speed) is exactly the window, once. */
    const total = clips.reduce((s, c) => s + (c.timelineEnd - c.timelineStart) * c.speed!, 0);
    expect(total).toBeCloseTo(7.98, 2);
    expect(clips[0]!.timelineStart).toBe(23.73);
    expect(clips.at(-1)!.timelineEnd).toBe(32.03);
  });

  it("s0b2 / s1b2 / s1b3: under six seconds — one shot, slowed, not cut in two", () => {
    for (const [id, start, end, window] of [
      ["vc_95f9d8f5bf", 13.08, 18.84, 5.36],
      ["vc_f3d55f1b8f", 32.03, 37.13, 4.28],
      ["vc_fc226b2064", 37.13, 40.67, 3.22],
    ] as const) {
      const { clips } = limitLongShots({ clips: [clip(id, start, end, 0, window)] });
      expect(clips, id).toHaveLength(1);
      expect(clips[0]!.id).toBe(id);
      expect(clips[0]!.speed).toBeCloseTo(window / (end - start), 3);
      expect(reads(clips)).toEqual([[0, window]]);
    }
  });

  it("unchanged: 3.4 s held for 24 s (video 624) still comes round to the start, each piece moving", () => {
    const { clips } = limitLongShots({ clips: [clip("vc_38d6214afb", 23.95, 47.99, 0, 3.4)] });
    expect(clips.length).toBeGreaterThanOrEqual(8);
    for (const c of clips) {
      expect(c.speed).toBeUndefined();
      expect(c.sourceOut!).toBeLessThanOrEqual(3.4 + 0.001);
    }
  });

  it("unchanged: a shot with a speed of its own is not re-timed", () => {
    const { clips } = limitLongShots({ clips: [clip("fast", 0, 5.1, 0, 4.28, { speed: 1.5 })] });
    for (const c of clips) expect(c.speed).toBe(1.5);
  });

  it("unchanged: a shot whose source covers it is untouched", () => {
    const input = [clip("fits", 0, 5, 1, 6)];
    expect(limitLongShots({ clips: input }).clips).toEqual(input);
  });
});

/* ═══════════════════════ B ═══════════════════════ */

describe("B — the Judge is asked about the line the viewer hears", () => {
  const prompt = buildBeatImagePrompt(
    "Critics called his plans impossible; traditional automakers scoffed.",
    3,
    "How Elon Musk Built Tesla Into a Global Brand",
    undefined,
    undefined,
    "journalists and analysts discussing Elon Musk's plans in a conference room"
  );

  it("the planner's imagined shot is not in the prompt (635: 16 of 41 refusals asked for it)", () => {
    expect(prompt).not.toContain("conference room");
    expect(prompt).not.toContain("visual plan for this line");
    expect(prompt).toContain('THE QUESTION — narration for this shot: "Critics called his plans impossible');
  });

  it("a line about money, a deal, a decision or criticism may show the company and its people at work, in its period", () => {
    expect(prompt).toContain("money (losses, profits, a near-bankruptcy), a deal or a");
    expect(prompt).toContain("takeover, a decision, a strategy, criticism");
    expect(prompt).toContain("is about — its people, its products, its factories, its events");
    expect(prompt).toContain("For such a line, that IS the situation the line");
  });

  it("FIT is a credible documentary picture for the line; a 'despite / but not' clause is context", () => {
    expect(prompt).toContain("The question is whether this is a credible documentary picture for that line — not whether");
    expect(prompt).toContain("every word of the line can be proven from the frame.");
    expect(prompt).toContain("\"instead of …\", \"without …\" — is context, not something the picture has to show");
  });

  it("the safety rules stay: both halves, the era alone, a person alone, a person talking about something else", () => {
    expect(prompt).toContain("It BELONGS only when BOTH are true.");
    expect(prompt).toContain("The era on its own is never enough.");
    expect(prompt).toContain("A person sitting in a car");
    expect(prompt).toContain("talking to camera about an unrelated topic");
    expect(prompt).toContain("When you cannot tell whether it shows what the line");
  });
});

/* ═══════════════════════ C ═══════════════════════ */

describe("C — the user's own words are kept in the query", () => {
  const TOPIC = "How Elon Musk Built Tesla Into a Global Brand";
  const ctx = (over: Partial<Record<keyof VerifiedQueryContext, unknown>> = {}) =>
    ({
      persons: [{ term: "Elon Musk", type: "person", source: "beat_text", verified: true }],
      events: [], objects: [], places: [], countries: [], time: [], actions: [],
      years: [{ term: "2008", type: "year", source: "beat_text", verified: true }],
      evidence: "In 2008, Tesla was weeks from bankruptcy despite Musk's initial $70 million investment.",
      topic: TOPIC,
      ...over,
    }) as unknown as VerifiedQueryContext;

  it("the whole-video query: 'Elon Musk Tesla 2008' becomes 'Elon Musk Tesla', not 'Elon Musk 2008'", () => {
    expect(narrowToCanonicalQuery("Elon Musk Tesla 2008", ctx())).toEqual({ query: "Elon Musk Tesla", narrowed: true });
  });

  it("unchanged without a prompt, when nothing proves 'Tesla' a name: the year is the concept, as before", () => {
    expect(narrowToCanonicalQuery("Elon Musk Tesla 2008", ctx({ topic: undefined }))).toEqual({ query: "Elon Musk 2008", narrowed: true });
  });

  it("a query that is only the prompt's word is not replaced by the person: 'Tesla' stays 'Tesla'", () => {
    const c = ctx({ persons: [{ term: "Musk", type: "person", source: "beat_text", verified: true }] });
    expect(narrowToCanonicalQuery("Tesla", c)).toEqual({ query: "Tesla", narrowed: false });
    expect(narrowToCanonicalQuery("Tesla", { ...c, topic: undefined } as VerifiedQueryContext).query).toBe("Musk");
  });

  it("unchanged: a typed object still wins over the prompt's word (only a bare year gives way)", () => {
    const c = ctx({ objects: [{ term: "factory", type: "object", source: "beat_text", verified: true }] });
    expect(narrowToCanonicalQuery("Elon Musk Tesla factory", c).query).toBe("Elon Musk factory");
  });
});

describe("C — names the narration writes, and footage", () => {
  const ctx = (evidence: string, topic?: string) =>
    ({
      persons: [{ term: "Elon Musk", type: "person", source: "beat_text", verified: true }],
      events: [], objects: [], places: [], countries: [], time: [], actions: [],
      years: [{ term: "2008", type: "year", source: "beat_text", verified: true }],
      evidence,
      ...(topic ? { topic } : {}),
    }) as unknown as VerifiedQueryContext;
  const NARRATION = "In 2008 the company nearly failed. But what decisions allowed Musk to transform Tesla into a powerhouse?";

  it("without a prompt: a name the narration writes mid-sentence beats a bare year", () => {
    expect(narrowToCanonicalQuery("Elon Musk Tesla 2008", ctx(NARRATION)).query).toBe("Elon Musk Tesla");
  });

  it("a YouTube query keeps its 'footage'; other providers get the plain narrowing", () => {
    const c = ctx(NARRATION);
    expect(narrowToCanonicalQuery("Elon Musk Tesla 2008 footage", c, true).query).toBe("Elon Musk Tesla footage");
    expect(narrowToCanonicalQuery("Elon Musk Tesla 2008 footage", c).query).toBe("Elon Musk Tesla");
    expect(narrowToCanonicalQuery("Elon Musk Tesla footage", c, true)).toEqual({ query: "Elon Musk Tesla footage", narrowed: false });
  });

  it("the whole-video YouTube query for the Tesla film asks for footage of Elon Musk and Tesla", async () => {
    const input: PlannerInput = {
      prompt: "How Elon Musk Built Tesla Into a Global Brand",
      title: "How Elon Musk Built Tesla",
      sceneTexts: [
        "In 2008, Tesla was weeks from bankruptcy despite Musk's initial $70 million investment. But what key decisions allowed Musk to transform Tesla into the powerhouse it is today?",
        "Critics called his plans impossible. Elon Musk's vision for Tesla seemed reckless, yet Tesla pushed forward.",
        "In 2020, for the first time, Tesla reported four consecutive quarters of profitability.",
      ],
    };
    const narration = input.sceneTexts.join(" ");
    const gctx = buildVerifiedQueryContextForBeat(narration, { sceneText: narration, topic: input.prompt });
    const gate = (q: string) =>
      withSearchProvenance(gctx, () => {
        const d = searchGateDecision("youtube", q, "video_pool");
        return d.admitted ? { ok: true, sentAs: d.text } : { ok: false, reason: "refused" };
      });
    const llm = async () => ({
      choices: [{ message: { content: JSON.stringify({ mainSubject: "Elon Musk", recurringSubjects: ["Tesla"], query: "Elon Musk Tesla 2008" }) } }],
    });
    const plan = await planVideoQuery({ llm, gate }, input);
    expect(plan?.query).toBe("Elon Musk Tesla footage");
  });
});

/* ═══════════════════════ D ═══════════════════════ */

describe("D — the renderer plays a short file once, slowed, instead of looping its start", () => {
  const v = (sourceIn: number, speed?: number) => ({ kind: "video" as const, sourceIn, ...(speed ? { speed } : {}) });

  it("635: 5.36 s asked of a 4.00 s file → 0.7462×, ending exactly at the file's end", () => {
    const s = speedThatFitsSource(v(0), 4.0, 5.36)!;
    expect(s).toBeCloseTo(4.0 / 5.36, 3);
    expect(5.36 * s).toBeLessThanOrEqual(4.0);
  });

  it("a piece already slowed by the long-shot rule is slowed a little more when the file is shorter still", () => {
    const s = speedThatFitsSource(v(3.99, 0.9614), 7.0, 4.15)!;
    expect(s).toBeCloseTo((7.0 - 3.99) / 4.15, 3);
    expect(s).toBeLessThan(0.9614);
  });

  it("a transition handle read before the in-point is counted", () => {
    /** In-point 2, a 1 s handle before it, a 4 s slot: reads 1 → 6, which a 6 s file holds. */
    expect(speedThatFitsSource(v(2), 6.0, 4, 1)).toBeNull();
    expect(speedThatFitsSource(v(2), 5.5, 4, 1)).toBeCloseTo((5.5 - 2) / 4, 3);
  });

  it("unchanged: a file that covers the slot, an unknown length, or a shortfall beyond the floor", () => {
    expect(speedThatFitsSource(v(0), 10, 5)).toBeNull();
    expect(speedThatFitsSource(v(0), null, 5)).toBeNull();
    expect(speedThatFitsSource(v(0), 2, 5)).toBeNull();
    expect(MIN_FIT_SPEED).toBe(0.5);
  });

  it("the segment encoder applies it before the speed filter and the read length are built", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "timelineRenderer.ts"), "utf8") as string;
    const seg = src.slice(src.indexOf("async function renderSegment("));
    expect(seg.indexOf("speedThatFitsSource(clip")).toBeGreaterThan(-1);
    expect(seg.indexOf("speedThatFitsSource(clip")).toBeLessThan(seg.indexOf("buildVideoFilter(graded"));
    expect(seg).toContain("const speed = clipPlaybackSpeed(fitted);");
  });
});
