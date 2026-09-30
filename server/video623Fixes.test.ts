/**
 * VIDEO 623 — what the render showed after the 622 fixes went live.
 *
 *   - "Let" read as a person, and searched for on YouTube.
 *   - Sentences that name nothing of their own searched "people, walking, city".
 *   - A 3.9 s archive shot held 19 s while other own-archive shots lay unused.
 *   - Three scenes fetched the same broken YouTube video at once.
 *   - Ten TV-news items on archive.org tried and refused (401/403), some twice.
 *   - The only fresh YouTube download arrived six seconds late and was never offered again.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  archiveAccessRefusal,
  beatFillSecondsNeeded,
  beatHasOwnSubject,
  BEAT_FILL_MIN_GAP_SEC,
  extractPersonNamesFromText,
  firstTransferWroteVideoOff,
  iaItemIsAccessRestricted,
  offerLateYoutubeCandidates,
  takeLateYoutubeCandidates,
} from "./videoPipeline";
import { atSentenceStart, isSentenceOpener, withoutSentenceOpener } from "./sentenceOpeners";
import { noteYoutubeDownloadRefusal, resetPermanentDownloadRefusals } from "./providerFailureClass";

const SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

describe("Video 623 — what a sentence opens with is not a name", () => {
  it("\"Let's look at how Elon Musk…\" names Elon Musk, not Let", () => {
    expect(extractPersonNamesFromText("Let's look at how Elon Musk built his image.")).toEqual(["Elon Musk"]);
  });

  it("an opener in front of a name is not part of it", () => {
    expect(extractPersonNamesFromText("Now Musk says Tesla will win, Elon Musk added.")).not.toContain("Now Musk");
    expect(extractPersonNamesFromText("Let Musk explain it himself.")).not.toContain("Let Musk");
    expect(extractPersonNamesFromText("Meet Kris Jenner. She built an empire.")).toEqual(["Kris Jenner"]);
  });

  it("names elsewhere in a sentence are untouched", () => {
    expect(extractPersonNamesFromText("In April, Adolf Hitler spoke to the crowd.")).toEqual(["Adolf Hitler"]);
  });

  it("the shared list reads contractions and knows where a sentence starts", () => {
    expect(isSentenceOpener("Let's")).toBe(true);
    expect(isSentenceOpener("Here’s")).toBe(true);
    expect(isSentenceOpener("Musk")).toBe(false);
    expect(atSentenceStart("He left. Now it ends.", 9)).toBe(true);
    expect(atSentenceStart("He left now.", 8)).toBe(false);
    expect(withoutSentenceOpener("Now Elon Musk", "Now Elon Musk said.", 0)).toBe("Elon Musk");
    expect(withoutSentenceOpener("Elon Musk", "Elon Musk said.", 0)).toBe("Elon Musk");
  });

  it("the planner and the subject extractor read the same list", () => {
    expect(fs.readFileSync(path.join(__dirname, "youtubeVideoSearchPlanner.ts"), "utf8")).toContain("isSentenceOpener(w)");
    expect(SRC).toContain('SENTENCE_OPENERS.has(lower.replace(/[\'’]s$/, ""))');
  });
});

describe("Video 623 — a sentence that names nothing of its own searches on the main subject", () => {
  const persons = ["Elon Musk"];
  const ctx = "Elon Musk bought Twitter. Investors watched Tesla closely.";

  it("sentences about 'him', the tabloids or social media have no subject of their own", () => {
    for (const t of [
      "Let's look at how the tabloids clash with his image.",
      "Social media turned him into a meme overnight.",
      "Here's where the story takes a turn.",
      "In April the rumors grew louder.",
    ]) {
      expect(beatHasOwnSubject(t, persons, ctx), t).toBe(false);
    }
  });

  it("a person, a place or a company the narration names is a subject", () => {
    for (const t of [
      "Musk stakes his reputation on every launch.",
      "In 1995 he founded Zip2 in Palo Alto.",
      "Tesla shares fell sharply that week.",
      "Twitter changed its name.",
    ]) {
      expect(beatHasOwnSubject(t, persons, ctx), t).toBe(true);
    }
  });

  it("the scene's beats are rewired only when the render has a main subject and the scene is not already rescued", () => {
    expect(SRC).toContain("if (!rescue && mainSubject) {");
    expect(SRC).toContain('if (beatHasOwnSubject(b.text, scenePersons, scene.text ?? "")) return b;');
    expect(SRC).toContain("visualDedup.mainSubject = mainSubject;");
  });
});

describe("Video 623 — a sentence longer than its clip gets another clip", () => {
  it("the part a sentence's clips do not cover, when it is worth filling", () => {
    expect(beatFillSecondsNeeded(19.08, 3.88)).toBe(15.2);
    expect(beatFillSecondsNeeded(6, 5)).toBe(0);
    expect(beatFillSecondsNeeded(6, 6 - BEAT_FILL_MIN_GAP_SEC)).toBe(BEAT_FILL_MIN_GAP_SEC);
    expect(beatFillSecondsNeeded(Number.NaN, 2)).toBe(0);
  });

  it("the fill runs for every sentence, is judged like any push, and stops when the scene has no time", () => {
    expect(SRC).toContain("await fillBeatWithMoreClips();\n    fillFor = { beat, clipsBefore: beatDurations.length };");
    expect(SRC).toContain('withAdoptionIntent("beat_fetch", () => pushSceneClip(clipPath, rest, f.beat.index))');
    expect(SRC).toContain("!(remainingScopeMs() > BEAT_FILL_MIN_SCOPE_MS)");
    const loopEnd = SRC.indexOf("    await fillBeatWithMoreClips();\n  } finally {");
    expect(loopEnd, "the last sentence is filled too").toBeGreaterThan(-1);
  });
});

describe("Video 623 — a second transfer of a video waits for the first one's answer", () => {
  afterEach(() => resetPermanentDownloadRefusals());

  it("the first wrote the video off: the second does not start", async () => {
    const first = (async () => {
      noteYoutubeDownloadRefusal("vid623", "DOWNLOAD_INVALID_CONTENT", "cloud=NO_VIDEO_STREAM");
      return false;
    })();
    expect(await firstTransferWroteVideoOff("vid623", first, 1_000)).toBe(true);
  });

  it("the first delivered: the second goes ahead", async () => {
    expect(await firstTransferWroteVideoOff("vid623ok", Promise.resolve(true), 1_000)).toBe(false);
  });

  it("the first failed for a reason about the moment: the second goes ahead", async () => {
    expect(await firstTransferWroteVideoOff("vid623t", Promise.resolve(false), 1_000)).toBe(false);
  });

  it("the first is still running when the wait ends: the second goes ahead", async () => {
    const never = new Promise<boolean>(() => undefined);
    expect(await firstTransferWroteVideoOff("vid623s", never, 20)).toBe(false);
  });

  it("the download remembers its own refusal before its answer is read", () => {
    expect(SRC).toContain('if (status !== "DOWNLOAD_SUCCESS") noteYoutubeDownloadRefusal(videoId, status, reason);');
    expect(SRC).toContain("if (!firstForVideo) youtubeFirstTransfers.set(videoId, done);");
  });
});

describe("Video 623 — archive.org items that only lend are not downloaded", () => {
  it("the item's own metadata says so", () => {
    expect(iaItemIsAccessRestricted({ metadata: { "access-restricted-item": "true" } })).toBe(true);
    expect(iaItemIsAccessRestricted({ metadata: { "access-restricted-item": true } })).toBe(true);
    expect(iaItemIsAccessRestricted({ metadata: { "access-restricted-item": ["true"] } })).toBe(true);
    expect(iaItemIsAccessRestricted({ metadata: {} })).toBe(false);
    expect(iaItemIsAccessRestricted(null)).toBe(false);
  });

  it("a 401 or 403 from a file is remembered for the render; other failures are not", () => {
    expect(archiveAccessRefusal("Server returned 403 Forbidden (access denied)")).toBe("http_403");
    expect(archiveAccessRefusal("Server returned 401 Unauthorized (authorization failed)")).toBe("http_401");
    expect(archiveAccessRefusal("Server returned 404 Not Found")).toBeNull();
    expect(archiveAccessRefusal("Connection timed out")).toBeNull();
    expect(SRC).toContain("if (permanentDownloadRefusal(videoUrl)) return false;");
  });
});

describe("Video 623 — a YouTube file that arrives late is offered to the next sentence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yt623-"));

  it("offered once, taken once, only while it is on disk", () => {
    const file = path.join(dir, "late.mp4");
    fs.writeFileSync(file, "x");
    const dedup: { lateYoutubeCandidates?: string[] } = {};
    offerLateYoutubeCandidates(dedup, [file, path.join(dir, "gone.mp4")], "s1b1");
    expect(takeLateYoutubeCandidates(dedup, "s1b2")).toEqual([file]);
    expect(takeLateYoutubeCandidates(dedup, "s1b3")).toEqual([]);
  });

  it("a lookahead gathers for its own sentence and takes nothing", () => {
    expect(SRC).toContain("const lateHere = req.lookahead ? [] : takeLateYoutubeCandidates(");
    expect(SRC).toContain("offerLateYoutubeCandidates(dedup, late.paths, `s${sceneIndex}b${beat.index}`)");
  });
});
