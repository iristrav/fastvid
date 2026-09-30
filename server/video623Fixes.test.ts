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
import {
  archiveAccessRefusal,
  noteArchiveAccessRefusal,
  noteYoutubeDownloadRefusal,
  permanentDownloadRefusal,
  resetPermanentDownloadRefusals,
} from "./providerFailureClass";

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

  it("the first answered with a refusal about the video: the second does not start", async () => {
    const first = Promise.resolve({ ok: false, status: "DOWNLOAD_INVALID_CONTENT", reason: "cloud=NO_VIDEO_STREAM" });
    expect(await firstTransferWroteVideoOff("vid623", first, 1_000)).toBe(true);
    const botCheck = Promise.resolve({ ok: false, status: "DOWNLOAD_FAILED", reason: "http_502:bot_check" });
    expect(await firstTransferWroteVideoOff("vid623b", botCheck, 1_000)).toBe(true);
  });

  it("the render wrote the video off meanwhile: the second does not start", async () => {
    noteYoutubeDownloadRefusal("vid623m", "DOWNLOAD_EMPTY", "cloud=empty");
    expect(await firstTransferWroteVideoOff("vid623m", Promise.resolve({ ok: false }), 1_000)).toBe(true);
  });

  it("the first delivered: the second goes ahead", async () => {
    expect(await firstTransferWroteVideoOff("vid623ok", Promise.resolve({ ok: true }), 1_000)).toBe(false);
  });

  it("the first failed for a reason about the moment: the second goes ahead", async () => {
    const timeout = Promise.resolve({ ok: false, status: "DOWNLOAD_TIMEOUT", reason: "scene_budget" });
    expect(await firstTransferWroteVideoOff("vid623t", timeout, 1_000)).toBe(false);
    const once = Promise.resolve({ ok: false, status: "DOWNLOAD_FAILED", reason: "http_502:stream_refused" });
    expect(await firstTransferWroteVideoOff("vid623r", once, 1_000)).toBe(false);
  });

  it("the first is still running when the wait ends: the second goes ahead", async () => {
    const never = new Promise<{ ok: boolean }>(() => undefined);
    expect(await firstTransferWroteVideoOff("vid623s", never, 20)).toBe(false);
  });

  it("the wait only reads; the render's memo keeps its one writer; the entry lives only while it runs", () => {
    expect(SRC).not.toContain('if (status !== "DOWNLOAD_SUCCESS") noteYoutubeDownloadRefusal(');
    expect(SRC).toContain("youtubeFirstTransfers.set(videoId, answer);");
    expect(SRC).toContain("if (youtubeFirstTransfers.get(videoId) === answer) youtubeFirstTransfers.delete(videoId);");
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
    resetPermanentDownloadRefusals();
    expect(noteArchiveAccessRefusal("https://archive.org/download/x/x.mp4", "Server returned 403 Forbidden")).toBe(true);
    expect(permanentDownloadRefusal("https://archive.org/download/x/x.mp4")).toBe("http_403");
    expect(noteArchiveAccessRefusal("https://archive.org/download/y/y.mp4", "Connection reset")).toBe(false);
    resetPermanentDownloadRefusals();
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

describe("Video 623 — the same for every topic, every name, every narration language", () => {
  it("openers in English, Dutch and German are not names; the names beside them are", () => {
    const cases: Array<[string, string[]]> = [
      ["Let's look at how Marie Curie changed science.", ["Marie Curie"]],
      ["Now Napoleon Bonaparte marched on Moscow.", ["Napoleon Bonaparte"]],
      ["Here's why Frida Kahlo painted herself.", ["Frida Kahlo"]],
      ["Laten we kijken hoe Vincent van Gogh werkte.", ["Vincent van Gogh"]],
      ["Nu zegt Mark Rutte dat het kabinet valt.", ["Mark Rutte"]],
      ["Toen Anne Frank schreef, was ze dertien.", ["Anne Frank"]],
      ["Heute spricht Angela Merkel in Berlin.", ["Angela Merkel"]],
      ["Wernher von Braun built the rocket.", ["Wernher von Braun"]],
    ];
    for (const [text, names] of cases) expect(extractPersonNamesFromText(text), text).toEqual(names);
  });

  it("name particles and first names are not on the opener list", () => {
    for (const w of ["van", "von", "de", "der", "den", "ter", "ten", "du", "das", "na", "dan", "elke", "zu"]) {
      expect(isSentenceOpener(w), w).toBe(false);
    }
  });

  it("a sentence with no subject of its own is recognised whatever the topic or language", () => {
    const titanic = "The Titanic left Southampton.";
    expect(beatHasOwnSubject("The ship sank in under three hours.", [], titanic)).toBe(false);
    expect(beatHasOwnSubject("Nobody expected the iceberg.", [], titanic)).toBe(false);
    expect(beatHasOwnSubject("Southampton was crowded that morning.", [], titanic)).toBe(true);
    const nl = "De Titanic vertrok uit Southampton.";
    expect(beatHasOwnSubject("Laten we kijken hoe het schip zonk.", [], nl)).toBe(false);
    expect(beatHasOwnSubject("Het schip vertrok uit Southampton.", [], nl)).toBe(true);
  });

  it("nothing added for 623 names a topic or a person", () => {
    const opener = fs.readFileSync(path.join(__dirname, "sentenceOpeners.ts"), "utf8").split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
    expect(opener).not.toMatch(/musk|tesla|kylie|jenner|titanic/i);
    for (const fn of ["beatHasOwnSubject", "beatFillSecondsNeeded", "firstTransferWroteVideoOff", "iaItemIsAccessRestricted", "offerLateYoutubeCandidates"]) {
      const at = SRC.indexOf(`export function ${fn}`) >= 0 ? SRC.indexOf(`export function ${fn}`) : SRC.indexOf(`export async function ${fn}`);
      const body = SRC.slice(at, SRC.indexOf("\n}\n", at));
      expect(body.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n"), fn).not.toMatch(/musk|tesla|kylie|jenner/i);
    }
  });
});
