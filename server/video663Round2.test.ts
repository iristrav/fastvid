/**
 * VIDEO 663, ROUND 2 — the owner: "Los punt 1 en 2 op. En let ook op de tekst in beeld. Dat het maar
 * 1 of 2 woorden zijn. En een goede grootte. En relevant aan de video."
 *
 *   1  a YouTube moment with no archive copy is read at the right second: its clip's in-point is in
 *      the whole video's seconds, its file starts at the moment (render 71/72's vc_d2fe49d8fe froze
 *      a whole sentence on its last frame), and a re-render fetches exactly that window (not 0–60 s);
 *   2  a place is never the film's person (render 72: "[persons: Los Angeles]" searched
 *      "Los Angeles Brussels" and "Los Angeles Bruges");
 *   3  text in the picture is one or two words, of the video's own subject, at 64 px.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureAnimationEveryMinute } from "./animationFloor";
import { cacheIdentityKey, rehydrateAsset, rehydratedFileName } from "./assetRehydrator";
import { withYoutubeWindow } from "./cinematicPipelineInputs";
import { fallbackSceneWords } from "./fallbackScene";
import { directOnScreenText } from "./onScreenTextDirector";
import {
  filmTopicWords,
  limitOnScreenWords,
  relevantWordsIn,
  shortOnScreenLabel,
  TOO_MANY_WORDS,
} from "./onScreenWords";
import { nameIsAPlace } from "./placeMismatch";
import { emptyTimeline, ON_SCREEN_TEXT_STYLE, type ProjectTimeline, type TimelineGraphic, type TimelineText } from "./projectTimeline";
import { clipInFileSeconds } from "./timelineRenderer";
import { extractPrimaryPersonFromText } from "./videoPipeline";

const SRC = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");
let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-663b-"));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/* ═══════════ 1 — a YouTube moment without an archive copy, read at the right second ═══════════ */

describe("1 — a YouTube moment with no archive copy is read at its own seconds", () => {
  const yt = { provider: "youtube_cc", providerAssetId: "OIfjoyu1k6E" };
  const cut = { provider: "youtube_cc", providerAssetId: "OIfjoyu1k6E", sourceInSec: 106, sourceOutSec: 110 };

  it("the identity names the window its file holds — only for YouTube, only without an archive copy", () => {
    expect(withYoutubeWindow(yt, cut)).toEqual({ ...yt, providerWindow: { inSec: 106, outSec: 110 } });
    expect(withYoutubeWindow({ ...yt, archiveAssetId: 61497 }, cut)).toEqual({ ...yt, archiveAssetId: 61497 });
    expect(withYoutubeWindow({ provider: "pexels", providerAssetId: "123" }, cut)).toEqual({ provider: "pexels", providerAssetId: "123" });
    /** no recorded cut: nothing to say */
    expect(withYoutubeWindow(yt, { provider: "youtube_cc", providerAssetId: "OIfjoyu1k6E" })).toEqual(yt);
  });

  it("render 71/72's vc_d2fe49d8fe: in-point 106.5 s of the video is 0.5 s into the 4 s moment file", () => {
    const clip = { source: { ...yt, providerWindow: { inSec: 106, outSec: 110 } }, sourceIn: 106.5, sourceOut: 110 };
    expect(clipInFileSeconds(clip)).toMatchObject({ sourceIn: 0.5, sourceOut: 4 });
    /** a clip without a window is read as it always was */
    const plain = { source: yt, sourceIn: 1.2, sourceOut: 3 };
    expect(clipInFileSeconds(plain)).toBe(plain);
  });

  it("the renderer reads every segment in its file's seconds", () => {
    const r = SRC("timelineRenderer.ts");
    const body = r.slice(r.indexOf("async function renderSegment("), r.indexOf("async function renderSegment(") + 600);
    expect(body).toContain("const clip = clipInFileSeconds(planned);");
  });

  it("a re-render fetches exactly the window, located — and keeps it apart from the video's other windows", async () => {
    const asked: Array<{ id: string; window?: { inSec: number; outSec: number } }> = [];
    const identity = { ...yt, providerWindow: { inSec: 106, outSec: 110 } };
    const result = await rehydrateAsset({
      identity,
      workDir: dir,
      deps: {
        download: async () => false,
        youtubeResolver: async (id, dest, window) => {
          asked.push({ id, window });
          execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:s=64x36:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", dest]);
          return true;
        },
      },
    });
    expect(result.status).toBe("ok");
    expect(asked).toEqual([{ id: "OIfjoyu1k6E", window: { inSec: 106, outSec: 110 } }]);
    /** another window of the same video is another file and another cache entry */
    const other = { ...yt, providerWindow: { inSec: 300, outSec: 304 } };
    expect(cacheIdentityKey(identity)).not.toBe(cacheIdentityKey(other));
    expect(cacheIdentityKey(identity)).not.toBe(cacheIdentityKey(yt));
    expect(rehydratedFileName(identity)).not.toBe(rehydratedFileName(other));
  });

  it("the production resolver downloads that window as a located start (not seconds 0–60)", () => {
    const deps = SRC("rehydrationDeps.ts");
    expect(deps).toContain(
      "return await downloadYouTubeCCClip(videoId, Number((window.outSec - window.inSec).toFixed(3)), window.inSec, destPath, 0, undefined, undefined, true);"
    );
  });

  it("the planner puts the window on the identity of every YouTube part it plans", () => {
    expect(SRC("cinematicPipelineInputs.ts")).toContain("identity: withYoutubeWindow(part.identity, partAdopted.adoption),");
  });
});

/* ═══════════ 2 — a place is never the film's person ═══════════ */

describe("2 — a place is never the film's person", () => {
  it("render 72's titles: 'Los Angeles' is no person; real names still are", () => {
    for (const t of ["Los Angeles vs Brussels: Two Cities", "A video about Los Angeles and Brussels", "Why Los Angeles Never Sleeps"]) {
      expect(extractPrimaryPersonFromText(t), t).toBe("");
    }
    expect(extractPrimaryPersonFromText("The Life of Paris Hilton")).toBe("Paris Hilton");
    expect(extractPrimaryPersonFromText("A video about Elon Musk")).toBe("Elon Musk");
  });

  it("what counts as a place: a listed place alone, or with a place word after it", () => {
    for (const p of ["Los Angeles", "los angeles", "Brussels", "Hong Kong", "Los Angeles County", "Belgium"]) expect(nameIsAPlace(p), p).toBe(true);
    for (const p of ["Paris Hilton", "Elon Musk", "Berlin Wall", "Jordan Peterson", ""]) expect(nameIsAPlace(p), p).toBe(false);
  });

  it("the scene's persons and the film's person lock both leave places out", () => {
    const pipe = SRC("videoPipeline.ts");
    const scene = pipe.slice(pipe.indexOf("function resolveScenePersons("), pipe.indexOf("function resolveScenePersons(") + 1500);
    expect(scene).toContain("if (nameIsAPlace(name)) continue;");
    expect(pipe).toContain('if (reading) return nameIsAPlace(reading.mainPerson) ? "" : reading.mainPerson;');
  });
});

/* ═══════════ 3 — one or two words, the video's own, at a good size ═══════════ */

const film = (durationSec: number, sentences: Array<[number, number, string]>): ProjectTimeline => {
  const t = emptyTimeline(663);
  t.durationSec = durationSec;
  t.sentences = sentences.map(([s, e, text], i) => ({ sceneIndex: 0, beatIndex: i, startSec: s, endSec: e, timingBasis: "measured", text }));
  return t;
};
const graphics = (t: ProjectTimeline): TimelineGraphic[] => t.tracks.flatMap((x) => (x.kind === "GRAPHICS" ? x.graphics : []));
const texts = (t: ProjectTimeline): TimelineText[] => t.tracks.flatMap((x) => (x.kind === "TEXT" ? x.texts : []));
/** The track's own list, to add to (the two readers above return copies). */
const gfxList = (t: ProjectTimeline): TimelineGraphic[] => {
  const tr = t.tracks.find((x) => x.kind === "GRAPHICS");
  if (tr?.kind !== "GRAPHICS") throw new Error("no graphics track");
  return tr.graphics;
};
const textList = (t: ProjectTimeline): TimelineText[] => {
  const tr = t.tracks.find((x) => x.kind === "TEXT");
  if (tr?.kind !== "TEXT") throw new Error("no text track");
  return tr.texts;
};
const gfx = (id: string, graphicType: string, label: string, start: number, data: Record<string, unknown> = {}): TimelineGraphic => ({
  id, graphicType, label, start, end: start + 3, data,
});

describe("3 — text in the picture is one or two words", () => {
  it("a label keeps what it names, in two words", () => {
    expect(shortOnScreenLabel("Berlin, Germany")).toBe("Berlin");
    expect(shortOnScreenLabel("Otto von Bismarck")).toBe("von Bismarck");
    expect(shortOnScreenLabel("Martin Luther King Jr.")).toBe("Luther King");
    expect(shortOnScreenLabel("14 October 1944")).toBe("October 1944");
    expect(shortOnScreenLabel("Kim Kardashian")).toBe("Kim Kardashian");
    expect(shortOnScreenLabel("ECB")).toBe("ECB");
  });

  it("render 72: the fallback scenes show the name alone — no 'Meanwhile Brussels — Brussels often sits'", () => {
    expect(fallbackSceneWords("Meanwhile, Brussels often sits beneath grey skies.")).toEqual({ graphicType: "label", label: "Brussels" });
    expect(fallbackSceneWords("In 1958 the World's Fair came to the city.")).toEqual({ graphicType: "date_card", label: "1958" });
  });

  it("render 72's animation floor: never 'breathtakingly distinct reveal' — the film's own word, or nothing", () => {
    const sentences: Array<[number, number, string]> = [
      [2, 8, "the seasons here are breathtakingly distinct, revealing a hidden rhythm"],
      [70, 76, "winter seasons bring rain to every street"],
    ];
    const t = film(80, sentences);
    const topic = filmTopicWords(t.sentences!);
    expect(topic.has("seasons")).toBe(true);
    expect(relevantWordsIn(sentences[0]![2], topic)).toBe("seasons");
    const r = ensureAnimationEveryMinute(t);
    /** "winter" is said once in the film: not its subject */
    expect(r.added.map((a) => a.label)).toEqual(["seasons", "seasons"]);
    /** a sentence that says nothing of the film's subject draws nothing */
    const lone = film(60, [[2, 8, "the light is breathtakingly distinct tonight"]]);
    expect(ensureAnimationEveryMinute(lone).added).toEqual([]);
  });

  it("over the picture: a name is shortened, its second line dropped; a quote is switched off, never cut", () => {
    const t = film(60, []);
    gfxList(t).push(
      gfx("lt", "lower_third", "Otto von Bismarck", 2, { role: "first chancellor of the German Empire" }),
      gfx("q", "quote", "I never wanted fame at all", 10),
      gfx("map", "map_point", "Berlin, Germany", 20, { lon: 13.4, lat: 52.5 }),
      gfx("card", "chapter_card", "The Rise and Fall of an Empire", 30, { primaryVisual: true, subtitle: "how a nation was unified by force" }),
      { ...gfx("mine", "lower_third", "Prince Otto Eduard Leopold", 40), editedByUser: true } as TimelineGraphic
    );
    limitOnScreenWords(t);
    const g = Object.fromEntries(graphics(t).map((x) => [x.id, x]));
    expect(g.lt).toMatchObject({ label: "von Bismarck" });
    expect(g.lt!.data?.role).toBeUndefined();
    expect(g.q).toMatchObject({ disabled: true, disabledReason: TOO_MANY_WORDS });
    /** a map draws a place, not a sentence: untouched */
    expect(g.map).toMatchObject({ label: "Berlin, Germany" });
    expect(g.map!.disabled).toBeUndefined();
    /** the card that IS the picture keeps a second line, two words each */
    expect(g.card!.label!.split(/\s+/).length).toBeLessThanOrEqual(2);
    expect(String(g.card!.data?.subtitle).split(/\s+/).length).toBeLessThanOrEqual(2);
    /** what the person wrote is theirs */
    expect(g.mine).toMatchObject({ label: "Prince Otto Eduard Leopold" });
  });

  it("the director applies it first; a three-word reveal stays off", () => {
    const t = film(60, []);
    textList(t).push(
      { id: "name", text: "Chancellor Otto von Bismarck", start: 2, end: 5, style: { ...ON_SCREEN_TEXT_STYLE }, animation: "fade" } as TimelineText,
      { id: "pop", text: "NO WAY OUT", start: 20, end: 23, role: "animated_text", style: { ...ON_SCREEN_TEXT_STYLE }, animation: "fade" } as TimelineText
    );
    const d = directOnScreenText(t, { intensityAt: () => 95 });
    expect(texts(t).find((x) => x.id === "name")!.text).toBe("von Bismarck");
    expect(texts(t).find((x) => x.id === "pop")!.disabled).toBe(true);
    expect(d.typewriter.filter((x) => x.why === "reveal")).toEqual([]);
    expect(d.words?.length).toBeGreaterThan(0);
  });

  it("a good size: 64 px on the 1080-line frame (was 52), the editor's new text too", () => {
    expect(ON_SCREEN_TEXT_STYLE.fontSizePx).toBe(64);
    expect(SRC("../client/src/components/VideoEditor.tsx")).toMatch(/const NEW_TEXT_STYLE = \{\s+fontSizePx: 64,/);
  });
});
