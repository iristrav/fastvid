/**
 * RONDE 651 — render 607, reviewed frame by frame, and the three answers:
 *
 *   1  on-screen text as a documentary sets it (onScreenTextDirector + the cards in Graphics.tsx)
 *   2  no shot on screen longer than six seconds (longShotLimit)
 *   3  a second YouTube search key used when the first is spent (youtubeApiKeys)
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { emptyTimeline, type ProjectTimeline, type TimelineGraphic, type TimelineText, type TimelineVideoClip } from "./projectTimeline";
import { DEFAULT_TEXT_STYLE } from "./projectTimeline";
import { MAX_TEXTS_AT_ONCE, MIN_TEXT_ON_SCREEN_SEC, directOnScreenText, looksLikePersonName } from "./onScreenTextDirector";
import { MAX_SHOT_SEC, limitLongShots } from "./longShotLimit";
import {
  __resetYoutubeKeysForTests,
  markYoutubeKeySpent,
  nextQuotaResetMs,
  usableYoutubeSearchKeys,
  youtubeSearchKeys,
} from "./youtubeApiKeys";

/* ═══════════════════════ fixtures in the shape translateEdl writes ═══════════════════════ */

const text = (id: string, role: string, t: string, start: number, end: number, position = "bottom"): TimelineText => ({
  id, role, text: t, start, end,
  style: { ...DEFAULT_TEXT_STYLE, position: position as TimelineText["style"]["position"] },
  animation: "fade",
});
const card = (id: string, graphicType: string, label: string, start: number, end: number, data: Record<string, unknown> = {}): TimelineGraphic => ({
  id, graphicType, label, start, end, data: { label, ...data },
});
function timeline(texts: TimelineText[], graphics: TimelineGraphic[], durationSec = 70): ProjectTimeline {
  const t = emptyTimeline(607);
  t.durationSec = durationSec;
  for (const track of t.tracks) {
    if (track.kind === "TEXT") track.texts.push(...texts);
    if (track.kind === "GRAPHICS") track.graphics.push(...graphics);
  }
  return t;
}
const on = (t: ProjectTimeline) => ({
  texts: (t.tracks.find((x) => x.kind === "TEXT") as { texts: TimelineText[] }).texts.filter((x) => !x.disabled),
  graphics: (t.tracks.find((x) => x.kind === "GRAPHICS") as { graphics: TimelineGraphic[] }).graphics.filter((x) => !x.disabled),
});

/* ═══════════════════════ 1 — the text director ═══════════════════════ */

describe("1 — render 607's opening frame", () => {
  // 0:00 — "Adolf Hitler" large + boxed, "Berlin" and "1945" in one spot, a map, a date card.
  const t = timeline(
    [
      text("t_name", "name", "Adolf Hitler", 0, 3, "lower_third"),
      text("t_loc", "location", "Berlin", 0, 3),
      text("t_date", "date", "1945", 0, 3),
    ],
    [
      card("g_lt", "lower_third", "Adolf Hitler", 0, 4, { name: "Adolf Hitler" }),
      card("g_map", "map_point", "Berlin, Germany", 0, 3, { locationName: "Berlin, Germany", normX: 0.53, normY: 0.3 }),
      card("g_date", "date_card", "1945", 0, 3, { text: "1945" }),
    ]
  );
  const d = directOnScreenText(t);
  const shown = on(t);

  it("the person is named once, by the card", () => {
    expect(shown.graphics.filter((g) => g.label === "Adolf Hitler").map((g) => g.id)).toEqual(["g_lt"]);
    expect(shown.texts.some((x) => x.text === "Adolf Hitler")).toBe(false);
  });

  it("'Ber45n' is gone: the place and the year are each shown once, by their card", () => {
    expect(shown.texts.map((x) => x.text)).not.toContain("Berlin");
    expect(shown.texts.map((x) => x.text)).not.toContain("1945");
    // One locator: the place card carries the year underneath — "BERLIN, GERMANY / 1945".
    const locator = shown.graphics.find((g) => g.graphicType === "location_card")!;
    expect(locator.data.subtitle).toBe("1945");
    expect(shown.graphics.some((g) => g.graphicType === "date_card")).toBe(false);
  });

  it("the empty map is off and a location card stands in, the map's payload kept", () => {
    const all = (t.tracks.find((x) => x.kind === "GRAPHICS") as { graphics: TimelineGraphic[] }).graphics;
    const map = all.find((g) => g.id === "g_map")!;
    expect(map.disabled).toBe(true);
    expect(map.disabledReason).toBe("map_without_geography");
    expect(map.data.normX).toBe(0.53);
    expect(all.find((g) => g.id === "g_map_loc")?.graphicType).toBe("location_card");
    expect(d.converted.length).toBe(1);
  });

  it("never more than two texts at once", () => {
    for (let s = 0; s < 4; s += 0.25) {
      const live = [...shown.texts, ...shown.graphics].filter((x) => x.start <= s && s < x.end);
      expect(live.length, `at ${s}s`).toBeLessThanOrEqual(MAX_TEXTS_AT_ONCE);
    }
  });
});

describe("1 — the rest of 607", () => {
  it("key-word pop-ups ('suicide', 'escape', 'critical decision') are switched off", () => {
    const t = timeline(
      [
        text("a", "animated_text", "suicide", 10, 11, "center"),
        text("b", "callout", "critical decision", 20, 22),
        text("c", "animated_text", "escape", 30, 31, "center"),
      ],
      []
    );
    const d = directOnScreenText(t);
    expect(on(t).texts).toEqual([]);
    expect(d.disabled.every((x) => x.reason === "keyword_popup")).toBe(true);
  });

  it("'Führerbunker' is not a person; 'Third Reich' under its own card is not drawn twice", () => {
    const t = timeline(
      [text("tr", "location", "Third Reich", 12, 15, "bottom")],
      [
        card("fb", "lower_third", "Führerbunker", 40, 43, { name: "Führerbunker" }),
        card("trc", "location_card", "Third Reich", 12, 15),
      ]
    );
    directOnScreenText(t);
    const shown = on(t);
    expect(shown.graphics.map((g) => g.id)).toEqual(["trc"]);
    expect(shown.texts).toEqual([]);
    expect(looksLikePersonName("Joseph Goebbels")).toBe(true);
    expect(looksLikePersonName("Führerbunker")).toBe(false);
  });

  it("a name already shown is not shown again later in the film", () => {
    const t = timeline([], [
      card("h1", "lower_third", "Adolf Hitler", 0, 3),
      card("h2", "lower_third", "Adolf Hitler", 13, 16),
      card("h3", "lower_third", "Adolf Hitler", 52, 55),
    ]);
    const d = directOnScreenText(t);
    expect(on(t).graphics.map((g) => g.id)).toEqual(["h1"]);
    expect(d.disabled.map((x) => x.reason)).toEqual(["name_already_shown", "name_already_shown"]);
  });

  it("two loose texts never share a place at the same time ('Fühsuicideker')", () => {
    const t = timeline([
      text("fb", "location", "Führerbunker", 50, 53, "bottom"),
      text("x", "title", "The last days", 51, 54, "bottom"),
    ], []);
    directOnScreenText(t);
    expect(on(t).texts.map((x) => x.id)).toEqual(["x"]);
  });

  it("what stays is on screen long enough to read", () => {
    const t = timeline([], [card("d", "date_card", "1945", 5, 5.6)]);
    directOnScreenText(t);
    const g = on(t).graphics[0]!;
    expect(g.end - g.start).toBeGreaterThanOrEqual(MIN_TEXT_ON_SCREEN_SEC);
  });

  it("anything the user edited is theirs: never switched off", () => {
    const t = timeline([{ ...text("u", "animated_text", "suicide", 1, 2), editedByUser: true }], []);
    directOnScreenText(t);
    expect(on(t).texts.map((x) => x.id)).toEqual(["u"]);
  });
});

describe("1 — wiring and design", () => {
  const PIPE = readFileSync(join(__dirname, "cinematicPipeline.ts"), "utf8");
  const EDL = readFileSync(join(__dirname, "edlToTimeline.ts"), "utf8");
  const GFX = readFileSync(join(__dirname, "remotion", "components", "Graphics.tsx"), "utf8");

  it("the director runs on every cinematic timeline, right after translation", () => {
    const tr = PIPE.indexOf("} = translateEdl({");
    /** RONDE 656 — it now also receives the film's intensity, for the typing reveal lines. */
    const dir = PIPE.indexOf("const textDirection = directOnScreenText(timeline, {");
    expect(tr).toBeGreaterThan(-1);
    expect(dir).toBeGreaterThan(tr);
    expect(EDL).toContain("role: caption.captionType,");
  });

  it("the cards use the installed Noto faces and a date is set as a date", () => {
    expect(GFX).toContain('const CARD_FONT = "Noto Sans, DejaVu Sans, Liberation Sans, sans-serif";');
    expect(GFX).toContain('const SERIF_FONT = "Noto Serif, DejaVu Serif, Liberation Serif, serif";');
    /** RONDE 656 — and types itself in when the director says so. */
    expect(GFX).toContain('case "date_card":\n      body = <DateCard primary={words} typewriter={g.data?.typewriter === true} />;');
    const docker = readFileSync(join(__dirname, "..", "Dockerfile"), "utf8");
    expect(docker).toContain("fonts-noto");
  });
});

/* ═══════════════════════ 2 — six seconds ═══════════════════════ */

const clip = (id: string, start: number, end: number, extra: Partial<TimelineVideoClip> = {}): TimelineVideoClip => ({
  id, kind: "video", source: { provider: "ww2", providerAssetId: "57805" },
  sourceIn: 2, sourceOut: 2 + (end - start), timelineStart: start, timelineEnd: end,
  motion: "none", transitionIn: "dissolve", transitionOut: "dissolve", sceneIndex: 1,
  ...extra,
} as TimelineVideoClip);

describe("2 — the globe held for eleven seconds", () => {
  const { clips, adjustedIds } = limitLongShots({ clips: [clip("globe", 30, 41)] });

  it("becomes pieces of at most six seconds covering the same span", () => {
    expect(clips.length).toBe(2);
    for (const c of clips) expect(c.timelineEnd - c.timelineStart).toBeLessThanOrEqual(MAX_SHOT_SEC + 0.001);
    expect(clips[0]!.timelineStart).toBe(30);
    expect(clips.at(-1)!.timelineEnd).toBe(41);
    expect(clips[0]!.timelineEnd).toBe(clips[1]!.timelineStart);
    expect(adjustedIds).toEqual(["globe"]);
    expect(clips.map((c) => c.id)).toEqual(["globe_p1", "globe_p2"]);
  });

  it("each piece is the next stretch of the source, and moves", () => {
    expect(clips[1]!.sourceIn).toBeGreaterThan(clips[0]!.sourceIn!);
    for (const c of clips) {
      expect(c.camera).toBeTruthy();
      expect(c.camera!.startScale).not.toBe(c.camera!.endScale);
    }
    expect(clips[0]!.camera!.type).not.toBe(clips[1]!.camera!.type);
  });

  it("only the ends carry the planned transitions", () => {
    expect(clips[0]!.transitionIn).toBe("dissolve");
    expect(clips[0]!.transitionOut).toBe("hard_cut");
    expect(clips[1]!.transitionIn).toBe("hard_cut");
    expect(clips[1]!.transitionOut).toBe("dissolve");
  });

  it("short shots, disabled shots and the user's own shots are untouched", () => {
    const input = [clip("a", 0, 5), clip("b", 5, 20, { disabled: true }), clip("c", 20, 35, { editedByUser: true })];
    expect(limitLongShots({ clips: input }).clips).toEqual(input);
  });

  it("runs in the cinematic pipeline after translation (so the YouTube rule came first), and its pieces count as one planned shot", () => {
    const PIPE = readFileSync(join(__dirname, "cinematicPipeline.ts"), "utf8");
    const EDL = readFileSync(join(__dirname, "edlToTimeline.ts"), "utf8");
    expect(EDL).toContain("const limited = limitYoutubeShots({ clips, youtube });");
    expect(EDL, "translateEdl translates and decides nothing").not.toContain("limitLongShots");
    const tr = PIPE.indexOf("} = translateEdl({");
    const long = PIPE.indexOf("? limitLongShots({ clips: videoTrack.clips })");
    expect(tr).toBeGreaterThan(-1);
    expect(long).toBeGreaterThan(tr);
    expect(PIPE).toContain("youtubeAdjustedClipIds: [...youtubeAdjustedClipIds, ...longShots.adjustedIds],");
  });
});

/* ═══════════════════════ 3 — a second search key ═══════════════════════ */

describe("3 — the search keys", () => {
  const NAMES = ["YOUTUBE_API_KEY", "YOUTUBE_API_KEY_2", "YOUTUBE_API_KEY_3", "YOUTUBE_API_KEY_4", "YOUTUBE_API_KEY_5"];
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
    for (const n of NAMES) delete process.env[n];
    __resetYoutubeKeysForTests();
  });
  afterEach(() => {
    for (const n of NAMES) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
    __resetYoutubeKeysForTests();
  });

  it("reads the keys in order and skips duplicates and blanks", () => {
    process.env.YOUTUBE_API_KEY = "k1";
    process.env.YOUTUBE_API_KEY_2 = "k2";
    process.env.YOUTUBE_API_KEY_3 = "k1";
    process.env.YOUTUBE_API_KEY_4 = "  ";
    expect(youtubeSearchKeys().map((k) => k.position)).toEqual([1, 2]);
  });

  it("a spent key is set aside until the reset and the next one is used", () => {
    process.env.YOUTUBE_API_KEY = "k1";
    process.env.YOUTUBE_API_KEY_2 = "k2";
    const now = Date.UTC(2026, 8, 24, 18, 18);
    expect(markYoutubeKeySpent(1, now)?.position).toBe(2);
    expect(usableYoutubeSearchKeys(now).map((k) => k.position)).toEqual([2]);
    expect(usableYoutubeSearchKeys(nextQuotaResetMs(now) + 1).map((k) => k.position)).toEqual([1, 2]);
    expect(markYoutubeKeySpent(2, now)).toBeNull();
  });

  it("the reset is the next midnight in Pacific time", () => {
    // 18:18 UTC on 24 Sep 2026 is 11:18 PDT; the reset is 07:00 UTC on the 25th.
    expect(new Date(nextQuotaResetMs(Date.UTC(2026, 8, 24, 18, 18))).toISOString()).toBe("2026-09-25T07:00:00.000Z");
  });

  it("the search tries the next key on a 429 before the render's cooldown starts", () => {
    const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
    const at = PIPE.indexOf("let searchKey = usableYoutubeSearchKeys()[0] ?? { key: youtubeApiKey, position: 1 };");
    expect(at).toBeGreaterThan(-1);
    const body = PIPE.slice(at, at + 2500);
    const next = body.indexOf("const nextKey = markYoutubeKeySpent(searchKey.position);");
    const cooldown = body.indexOf("markYoutubeRateLimited(");
    expect(next).toBeGreaterThan(-1);
    expect(cooldown).toBeGreaterThan(next);
    expect(body).toContain('searchUrl.searchParams.set("key", searchKey.key);');
  });

  it("a key is never printed", () => {
    const SRC = readFileSync(join(__dirname, "youtubeApiKeys.ts"), "utf8");
    expect(SRC).not.toMatch(/console\.[a-z]+\([^)]*\.key\b/);
  });
});
