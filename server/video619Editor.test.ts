/**
 * Video 619 — the editor becomes a real editor, the made video carries no text, and the voice
 * picker's samples repair themselves.
 *
 * The edits are pure functions over a timeline, so they are exercised directly and every result is
 * put through the SAME validator a save runs: an edit that produced an unsaveable document would be
 * an edit the person could make and never keep.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import {
  addText,
  captionCounts,
  insertVideoClip,
  moveVideoClip,
  removeAudioClip,
  removeTextElement,
  removeVideoClip,
  setAllCaptionsShown,
  setTextElementShown,
  setVideoClipLength,
  setVideoClipSourceIn,
  splitVideoClip,
  videoClipsOf,
  type EditableTimeline,
  type EditableVideoClip,
} from "@shared/timelineEdits";
import { emptyTimeline, type ProjectTimeline, type TimelineVideoClip } from "./projectTimeline";
import { NON_BLOCKING_ISSUES, validateTimeline } from "./timelineValidator";
import { archiveAssetAsShot, ADDED_STILL_SHOT_SEC, ADDED_VIDEO_SHOT_SEC } from "./editorArchiveShot";
import { LEFT_TO_EDITOR, leaveOnScreenTextToTheEditor } from "./onScreenTextDirector";
import { exampleAudioLoads, makeVoiceExample, resolvableExampleUrl } from "./voiceExamples";

const shot = (id: string, start: number, end: number, extra: Partial<TimelineVideoClip> = {}): TimelineVideoClip => ({
  id,
  kind: "video",
  source: { provider: "archive", archiveAssetId: Number(id.replace(/\D/g, "")) || 1, canonicalUrl: `/api/archive/media/${id}` },
  sourceIn: 0,
  sourceOut: end - start,
  timelineStart: start,
  timelineEnd: end,
  motion: "none",
  transitionIn: "hard_cut",
  transitionOut: "hard_cut",
  previewSource: "asset",
  ...extra,
});

function film(voiceEnd = 12): ProjectTimeline {
  const t = emptyTimeline(7);
  const video = t.tracks.find((x) => x.kind === "VIDEO")!;
  if (video.kind === "VIDEO") video.clips.push(shot("c1", 0, 4), shot("c2", 4, 8), shot("c3", 8, 12));
  const voice = t.tracks.find((x) => x.kind === "VOICE")!;
  if (voice.kind === "VOICE") {
    voice.clips.push({ id: "v", source: { provider: "narration", canonicalUrl: "/voice.mp3" }, start: 0, end: voiceEnd, gain: 1 });
  }
  const captions = t.tracks.find((x) => x.kind === "CAPTIONS")!;
  if (captions.kind === "CAPTIONS") {
    captions.captions.push(
      { id: "cap1", text: "one", start: 0, end: 3, style: { fontSizePx: 40, color: "white", backgroundOpacity: 0, position: "bottom" }, disabled: true, disabledReason: LEFT_TO_EDITOR },
      { id: "cap2", text: "two", start: 4, end: 7, style: { fontSizePx: 40, color: "white", backgroundOpacity: 0, position: "bottom" }, disabled: true, disabledReason: LEFT_TO_EDITOR }
    );
  }
  t.durationSec = 12;
  return t;
}

const E = (t: ProjectTimeline) => t as unknown as EditableTimeline;
const P = (t: EditableTimeline) => t as unknown as ProjectTimeline;
const ids = (t: EditableTimeline) => videoClipsOf(t).map((c) => c.id);
const spans = (t: EditableTimeline) => videoClipsOf(t).map((c) => [c.timelineStart, c.timelineEnd]);

/** The save's own question: would this be refused? */
function blocking(t: EditableTimeline): string[] {
  return validateTimeline(P(t)).issues.filter((i) => !NON_BLOCKING_ISSUES.has(i.code)).map((i) => i.code);
}

describe("Video 619 — shots can be added, removed, moved, cut and resized", () => {
  it("the film starts valid", () => {
    expect(blocking(E(film()))).toEqual([]);
  });

  it("an added shot goes after the chosen one and everything after moves up", () => {
    const added = insertVideoClip(E(film()), shot("c9", 0, 5) as unknown as EditableVideoClip, "c1");
    expect(ids(added)).toEqual(["c1", "c9", "c2", "c3"]);
    expect(spans(added)).toEqual([[0, 4], [4, 9], [9, 13], [13, 17]]);
    expect(added.durationSec).toBe(17);
    expect(videoClipsOf(added)[1]!.editedByUser).toBe(true);
    expect(blocking(added)).toEqual([]);
  });

  it("a removed shot closes up, and the last shot is held under the rest of the voice", () => {
    const removed = removeVideoClip(E(film()), "c2");
    expect(ids(removed)).toEqual(["c1", "c3"]);
    /** 4 + 4 = 8s of picture under 12s of voice: the last shot is held to 12. */
    expect(spans(removed)).toEqual([[0, 4], [4, 12]]);
    expect(blocking(removed)).toEqual([]);
  });

  it("the last remaining shot cannot be removed", () => {
    let t = E(film());
    t = removeVideoClip(t, "c1");
    t = removeVideoClip(t, "c2");
    expect(ids(removeVideoClip(t, "c3"))).toEqual(["c3"]);
  });

  it("moving swaps with the neighbour and keeps every length", () => {
    const moved = moveVideoClip(E(film()), "c3", -1);
    expect(ids(moved)).toEqual(["c1", "c3", "c2"]);
    expect(spans(moved)).toEqual([[0, 4], [4, 8], [8, 12]]);
    expect(ids(moveVideoClip(E(film()), "c1", -1))).toEqual(["c1", "c2", "c3"]);
  });

  it("a longer shot pushes the rest along; its source out-point follows", () => {
    const longer = setVideoClipLength(E(film()), "c1", 6);
    expect(spans(longer)).toEqual([[0, 6], [6, 10], [10, 14]]);
    expect(videoClipsOf(longer)[0]!.sourceOut).toBe(6);
    expect(blocking(longer)).toEqual([]);
  });

  it("no shot is made shorter than half a second", () => {
    expect(spans(setVideoClipLength(E(film()), "c1", 0.1))[0]).toEqual([0, 0.5]);
  });

  it("the start point in the source moves without moving the shot", () => {
    const later = setVideoClipSourceIn(E(film()), "c2", 7.5);
    const c2 = videoClipsOf(later)[1]!;
    expect([c2.sourceIn, c2.sourceOut, c2.timelineStart, c2.timelineEnd]).toEqual([7.5, 11.5, 4, 8]);
  });

  it("a cut makes two shots that together show exactly what the one did", () => {
    const cut = splitVideoClip(E(film()), "c2", 5.5, "c2b");
    expect(ids(cut)).toEqual(["c1", "c2", "c2b", "c3"]);
    expect(spans(cut)).toEqual([[0, 4], [4, 5.5], [5.5, 8], [8, 12]]);
    const [, a, b] = videoClipsOf(cut);
    expect([a!.sourceIn, a!.sourceOut, b!.sourceIn, b!.sourceOut]).toEqual([0, 1.5, 1.5, 4]);
    expect(blocking(cut)).toEqual([]);
  });

  it("a cut too close to an edge is not made", () => {
    expect(ids(splitVideoClip(E(film()), "c2", 4.2))).toEqual(["c1", "c2", "c3"]);
  });
});

describe("Video 619 — text is the person's to add", () => {
  it("an added text sits at the playhead for three seconds and saves", () => {
    const t = addText(E(film()), { text: "Kylie Jenner", atSec: 5, style: { fontSizePx: 64, color: "white", backgroundOpacity: 0.35, position: "lower_third" }, id: "t1" });
    const track = t.tracks.find((x) => x.kind === "TEXT") as { texts: Array<{ id: string; start: number; end: number; text: string }> };
    expect(track.texts[0]).toMatchObject({ id: "t1", text: "Kylie Jenner", start: 5, end: 8 });
    expect(blocking(t)).toEqual([]);
  });

  it("an empty text is given a word rather than saved empty", () => {
    const t = addText(E(film()), { text: "  ", atSec: 0, style: { fontSizePx: 64, color: "white", backgroundOpacity: 0, position: "center" }, id: "t2" });
    expect((t.tracks.find((x) => x.kind === "TEXT") as { texts: Array<{ text: string }> }).texts[0]!.text).toBe("Tekst");
  });

  it("subtitles come on and off in one step, and say how many are on", () => {
    expect(captionCounts(E(film()))).toEqual({ total: 2, shown: 0 });
    const on = setAllCaptionsShown(E(film()), true);
    expect(captionCounts(on)).toEqual({ total: 2, shown: 2 });
    const cap = (on.tracks.find((x) => x.kind === "CAPTIONS") as { captions: Array<Record<string, unknown>> }).captions[0]!;
    expect(cap.disabledReason).toBeUndefined();
    expect(captionCounts(setAllCaptionsShown(on, false))).toEqual({ total: 2, shown: 0 });
  });

  it("one suggestion can be shown, and any text removed", () => {
    const one = setTextElementShown(E(film()), "CAPTIONS", "cap2", true);
    expect(captionCounts(one)).toEqual({ total: 2, shown: 1 });
    expect(captionCounts(removeTextElement(one, "CAPTIONS", "cap1"))).toEqual({ total: 1, shown: 1 });
  });

  it("music, effects and ambience can be removed; the tracks stay", () => {
    const t = E(film());
    (t.tracks.find((x) => x.kind === "SFX") as { clips: unknown[] }).clips.push({ id: "s1", source: { provider: "x" }, start: 0, end: 1, gain: 1 });
    const out = removeAudioClip(t, "SFX", "s1");
    expect((out.tracks.find((x) => x.kind === "SFX") as { clips: unknown[] }).clips).toEqual([]);
  });
});

describe("Video 619 — an archive asset as a hand-added shot", () => {
  const url = "/api/editor/archive-media/5";
  it("a video starts at its beginning and runs at most five seconds", () => {
    const s = archiveAssetAsShot({ asset: { id: 5, mediaType: "video", durationSec: 30, title: "Kylie" }, provider: "yt", canonicalUrl: url, idSeed: "a" });
    expect(s).toMatchObject({ kind: "video", sourceIn: 0, sourceOut: ADDED_VIDEO_SHOT_SEC, timelineEnd: ADDED_VIDEO_SHOT_SEC, editedByUser: true });
    expect(s.source).toEqual({ provider: "yt", archiveAssetId: 5, canonicalUrl: url, title: "Kylie" });
  });

  it("a short video is as long as it is; a still is held with a slow push", () => {
    expect(archiveAssetAsShot({ asset: { id: 5, mediaType: "video", durationSec: 2.2 }, provider: "yt", canonicalUrl: url, idSeed: "b" }).timelineEnd).toBe(2.2);
    const still = archiveAssetAsShot({ asset: { id: 6, mediaType: "image" }, provider: "wiki", canonicalUrl: url, idSeed: "c" });
    expect(still).toMatchObject({ kind: "image", timelineEnd: ADDED_STILL_SHOT_SEC, motion: "slow_push" });
    expect(still.sourceIn).toBeUndefined();
  });

  it("the route builds the shot from the archive row, and does not save it", () => {
    const router = fs.readFileSync(path.join(__dirname, "timelineRouter.ts"), "utf8");
    const at = router.indexOf("clipFromArchive: protectedProcedure");
    const body = router.slice(at, router.indexOf("replaceClip: protectedProcedure", at));
    expect(body).toContain("await getMediaArchiveAssetById(input.archiveAssetId)");
    expect(body).toContain("requireVideoAccess(");
    expect(body).not.toContain("persistEdited(");
    expect(router).toContain("archiveBrowse: protectedProcedure");
  });
});

describe("Video 619 — the made video carries no text", () => {
  it("every caption, text and graphic is switched off, kept, and marked as left to the editor", () => {
    const t = emptyTimeline(1);
    for (const track of t.tracks) {
      if (track.kind === "CAPTIONS") track.captions.push({ id: "c", text: "hi", start: 0, end: 1, style: { fontSizePx: 40, color: "white", backgroundOpacity: 0, position: "bottom" } });
      if (track.kind === "TEXT") track.texts.push({ id: "t", text: "1945", start: 0, end: 1, style: { fontSizePx: 40, color: "white", backgroundOpacity: 0, position: "bottom" }, animation: "typewriter" });
      if (track.kind === "GRAPHICS") track.graphics.push({ id: "g", graphicType: "location", data: {}, start: 0, end: 1, label: "Berlin" });
    }
    expect(leaveOnScreenTextToTheEditor(t)).toEqual({ captions: 1, texts: 1, graphics: 1 });
    for (const track of t.tracks) {
      const els = track.kind === "CAPTIONS" ? track.captions : track.kind === "TEXT" ? track.texts : track.kind === "GRAPHICS" ? track.graphics : [];
      for (const el of els) expect(el).toMatchObject({ disabled: true, disabledReason: LEFT_TO_EDITOR });
    }
  });

  it("the pipeline applies it after the text director, and lays no typewriter keys", () => {
    const pipe = fs.readFileSync(path.join(__dirname, "cinematicPipeline.ts"), "utf8");
    expect(pipe.indexOf("leaveOnScreenTextToTheEditor(timeline)")).toBeGreaterThan(pipe.indexOf("directOnScreenText(timeline"));
    expect(pipe).not.toContain("typewriterSfxClips(");
  });

  it("subtitles are always planned, so the editor can offer them", () => {
    const vp = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(vp).toContain("includeSubtitles: true,");
  });

  it("the form has no subtitle switch and no own voice-over any more", () => {
    const dash = fs.readFileSync(path.join(__dirname, "../client/src/pages/Dashboard.tsx"), "utf8");
    expect(dash).not.toContain("CustomVoiceoverUpload");
    expect(dash).not.toContain("setEnableSubtitles");
    const routers = fs.readFileSync(path.join(__dirname, "routers.ts"), "utf8");
    expect(routers).not.toContain("uploadCustom:");
    expect(routers).toContain("customVoiceoverUrl: null,");
  });
});

describe("Video 619 — a voice sample has to play, not just exist", () => {
  const signed = async (key: string) => `https://bucket.test/${key}?sig=1`;
  const fetchStatus = (status: number) => (async () => ({ ok: status < 300, status })) as unknown as typeof fetch;

  it("the app's own storage path is resolved to the real file", async () => {
    expect(await resolvableExampleUrl("/manus-storage/voice-examples/a.mp3", signed)).toBe("https://bucket.test/voice-examples/a.mp3?sig=1");
    expect(await resolvableExampleUrl("https://cdn.test/a.mp3", signed)).toBe("https://cdn.test/a.mp3");
    expect(await resolvableExampleUrl("relative/a.mp3", signed)).toBeNull();
  });

  it("a sample that 404s, an empty URL and a thrown fetch all count as not loading", async () => {
    expect(await exampleAudioLoads("/manus-storage/x.mp3", { signed, fetch: fetchStatus(206) })).toBe(true);
    expect(await exampleAudioLoads("/manus-storage/x.mp3", { signed, fetch: fetchStatus(404) })).toBe(false);
    expect(await exampleAudioLoads(null, { signed, fetch: fetchStatus(200) })).toBe(false);
    const boom = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    expect(await exampleAudioLoads("/manus-storage/x.mp3", { signed, fetch: boom })).toBe(false);
  });

  it("a new sample is stored under the voice's id and its URL returned; a refusal says why", async () => {
    const ok = (async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) })) as unknown as typeof fetch;
    const put = (async (key: string) => ({ key, url: `/manus-storage/${key}` })) as never;
    expect(await makeVoiceExample("VOICE1", "k", { fetch: ok, put })).toBe("/manus-storage/voice-examples/VOICE1.mp3");
    const refused = (async () => ({ ok: false, status: 401, text: async () => "invalid api key" })) as unknown as typeof fetch;
    await expect(makeVoiceExample("VOICE1", "k", { fetch: refused, put })).rejects.toThrow("ElevenLabs HTTP 401: invalid api key");
  });

  it("boot checks that every sample LOADS, and the preview route writes a fresh one back", () => {
    const boot = fs.readFileSync(path.join(__dirname, "_core/index.ts"), "utf8");
    expect(boot).toContain("if (!(await exampleAudioLoads(v.exampleAudioUrl))) broken.push(v);");
    const routers = fs.readFileSync(path.join(__dirname, "routers.ts"), "utf8");
    expect(routers).toContain("if (match) await updateVoice(match.id, { exampleAudioUrl: url });");
  });

  it("the picker falls back to a fresh sample when the stored one does not load", () => {
    const hook = fs.readFileSync(path.join(__dirname, "../client/src/hooks/useVoicePreview.ts"), "utf8");
    expect(hook).toContain("void play(voice.exampleAudioUrl, voice, requestId, generateAndPlay);");
    expect(hook).toContain("if (fellBack) return;");
  });
});
