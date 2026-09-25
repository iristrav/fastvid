import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { DEFAULT_TEXT_STYLE, emptyTimeline, type ProjectTimeline, type TimelineGraphic, type TimelineText } from "./projectTimeline";
import { MAX_REVEALS, REVEAL_MIN_GAP_SEC, directOnScreenText, formatTextDirection } from "./onScreenTextDirector";
import { TYPE_CHAR_SEC, TYPE_DELAY_SEC, keystrokeTimesSec, typedCount, typingDurationSec } from "./remotion/components/typewriter";
import { TYPEWRITER_GAIN_DB, intensityAtFrom, typewriterSfxClips, typewriterSoundId } from "./typewriterSound";
import { SUPPORTED_ANIMATIONS, PROGRESSIVE_ANIMATIONS } from "./remotion/components/animation";

/**
 * RONDE 656 — "zorg ervoor dat de tekst wat in beeld komt, typend in beeld komt. Ook met een
 * typend geluid. En dat hoeft alleen bij jaargetallen, of spannende onderwerpen."
 */
const text = (id: string, role: string, t: string, start: number, end: number, position = "bottom"): TimelineText => ({
  id, role, text: t, start, end,
  style: { ...DEFAULT_TEXT_STYLE, position: position as TimelineText["style"]["position"] },
  animation: "fade",
});
const card = (id: string, graphicType: string, label: string, start: number, end: number, data: Record<string, unknown> = {}): TimelineGraphic => ({
  id, graphicType, label, start, end, data: { label, ...data },
});
function timeline(texts: TimelineText[], graphics: TimelineGraphic[], durationSec = 70): ProjectTimeline {
  const t = emptyTimeline(608);
  t.durationSec = durationSec;
  for (const track of t.tracks) {
    if (track.kind === "TEXT") track.texts.push(...texts);
    if (track.kind === "GRAPHICS") track.graphics.push(...graphics);
  }
  return t;
}
const texts = (t: ProjectTimeline) => (t.tracks.find((x) => x.kind === "TEXT") as { texts: TimelineText[] }).texts;
const graphics = (t: ProjectTimeline) => (t.tracks.find((x) => x.kind === "GRAPHICS") as { graphics: TimelineGraphic[] }).graphics;

describe("a typewriter types at one fixed pace", () => {
  it("nothing before the first key, then one character per step, then all of it", () => {
    expect(typedCount("1945", 0)).toBe(0);
    expect(typedCount("1945", TYPE_DELAY_SEC + 0.001)).toBe(1);
    expect(typedCount("1945", TYPE_DELAY_SEC + 2 * TYPE_CHAR_SEC + 0.001)).toBe(3);
    expect(typedCount("1945", 10)).toBe(4);
    expect(typingDurationSec("1945")).toBeCloseTo(TYPE_DELAY_SEC + 4 * TYPE_CHAR_SEC, 6);
  });

  it("a space is typed but silent", () => {
    expect(keystrokeTimesSec("A B")).toEqual([TYPE_DELAY_SEC, Number((TYPE_DELAY_SEC + 2 * TYPE_CHAR_SEC).toFixed(3))]);
  });

  it("is an animation the renderer supports, and a progressive one", () => {
    expect(SUPPORTED_ANIMATIONS.has("typewriter")).toBe(true);
    expect(PROGRESSIVE_ANIMATIONS.has("typewriter")).toBe(true);
  });
});

describe("years type; key-word pop-ups stay off except at the most intense moments", () => {
  it("every year still on screen types itself in — the card and a loose year text alike", () => {
    const t = timeline(
      [text("t_year", "date", "1939", 20, 23)],
      [card("g_date", "date_card", "1945", 2, 5, { text: "1945" })]
    );
    const d = directOnScreenText(t);
    expect(graphics(t).find((g) => g.id === "g_date")!.data.typewriter).toBe(true);
    expect(texts(t).find((x) => x.id === "t_year")!.animation).toBe("typewriter");
    expect(d.typewriter.map((x) => [x.id, x.why])).toEqual([["g_date", "year"], ["t_year", "year"]]);
  });

  it("without a curve nothing else types, and pop-ups stay off", () => {
    const t = timeline([text("t_pop", "animated_text", "BETRAYAL", 30, 33)], []);
    const d = directOnScreenText(t);
    expect(texts(t)[0]!.disabled).toBe(true);
    expect(d.typewriter).toEqual([]);
  });

  it("at most two reveal lines, at intensity 70 or more, a quarter-minute apart", () => {
    const t = timeline(
      [
        text("p1", "animated_text", "THE BUNKER", 10, 13),
        text("p2", "callout", "SEALED", 14, 16),
        text("p3", "animated_text", "NO WAY OUT", 40, 43),
        text("p4", "animated_text", "A QUIET ROOM", 55, 58),
      ],
      []
    );
    const intensity: Record<string, number> = { p1: 90, p2: 85, p3: 80, p4: 40 };
    const at = (sec: number) => {
      const hit = texts(t).find((x) => sec >= x.start && sec < x.end);
      return hit ? intensity[hit.id] ?? null : null;
    };
    const d = directOnScreenText(t, { intensityAt: at });
    const revealed = d.typewriter.filter((x) => x.why === "reveal").map((x) => x.id);
    expect(revealed).toEqual(["p1", "p3"]);
    expect(revealed.length).toBeLessThanOrEqual(MAX_REVEALS);
    expect(Math.abs(40 - 10)).toBeGreaterThanOrEqual(REVEAL_MIN_GAP_SEC);
    for (const id of ["p2", "p4"]) expect(texts(t).find((x) => x.id === id)!.disabled).toBe(true);
    expect(texts(t).find((x) => x.id === "p1")!.animation).toBe("typewriter");
    expect(formatTextDirection(608, d)).toContain('typewriter=2 (reveal:"THE BUNKER"@10.0s, reveal:"NO WAY OUT"@40.0s)');
  });

  it("a reveal still obeys the rules for crowding: it never lands on a card in the same place", () => {
    const t = timeline(
      [text("p1", "animated_text", "TRAPPED", 10, 13, "bottom")],
      [card("g_title", "title_card", "Chapter Two", 10, 13, { text: "Chapter Two" })]
    );
    graphics(t)[0]!.style = { position: "bottom" } as never;
    directOnScreenText(t, { intensityAt: () => 95 });
    const p1 = texts(t)[0]!;
    expect(p1.disabled).toBe(true);
    expect(p1.disabledReason).toBe("same_place_same_time");
  });
});

describe("the keys are heard, from the catalogue's own recording", () => {
  it("one quiet clip per typing element, from the first key to the last, ducked under the voice", () => {
    expect(typewriterSoundId()).toBe("434572");
    const [c] = typewriterSfxClips([{ id: "g_date", start: 2, text: "1945" }]);
    expect(c!.source).toMatchObject({ provider: "freesound", providerAssetId: "434572" });
    expect(c!.start).toBeCloseTo(2 + TYPE_DELAY_SEC, 3);
    expect(c!.end).toBeCloseTo(2 + TYPE_DELAY_SEC + 4 * TYPE_CHAR_SEC + 0.08, 3);
    expect(c!.gain).toBeCloseTo(10 ** (TYPEWRITER_GAIN_DB / 20), 3);
    expect(c!.duckUnderVoice).toBe(true);
  });

  it("the film's intensity comes from the shot on screen and its beat", () => {
    const at = intensityAtFrom(
      [
        { timelineStart: 0, timelineEnd: 5, sceneIndex: 0, beatIndex: 0 },
        { timelineStart: 5, timelineEnd: 10, sceneIndex: 0, beatIndex: 1 },
        { timelineStart: 10, timelineEnd: 15, sceneIndex: 1, beatIndex: 0 },
      ],
      [
        { sceneIndex: 0, beatIndex: 0, intensity: 30 },
        { sceneIndex: 0, beatIndex: 1, intensity: 85 },
        { sceneIndex: 1, beatIndex: 3, intensity: 60 },
      ]
    );
    expect(at(2)).toBe(30);
    expect(at(7)).toBe(85);
    expect(at(12)).toBe(60);
    expect(at(99)).toBeNull();
  });
});

describe("the wiring", () => {
  const PIPE = readFileSync(join(__dirname, "cinematicPipeline.ts"), "utf8");
  const GFX = readFileSync(join(__dirname, "remotion/components/Graphics.tsx"), "utf8");
  const TXT = readFileSync(join(__dirname, "remotion/components/Text.tsx"), "utf8");
  it("the pipeline passes the curve to the director and lays the key sound on the SFX track", () => {
    expect(PIPE).toContain("intensityAtFrom(videoForIntensity.clips, params.emotionalCurve)");
    expect(PIPE).toContain("sfxForTyping.clips.push(...typewriterSfxClips(textDirection.typewriter))");
  });
  it("the date card and plain text type at the shared pace", () => {
    expect(GFX).toContain("typedCount(primary, frame / fps)");
    expect(TXT).toContain('animation === "typewriter"');
    expect(TXT).toContain("typedCount(text, frame / fps)");
  });
});
