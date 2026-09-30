/**
 * VIDEO 622 — nineteen YouTube downloads, two videos in the film.
 *
 * Most of the nineteen were the same seconds fetched again for another scene
 * (`tnBQmEqBCY0` @5081s for 4 s, three times), and one video YouTube refused again and again
 * (`23GzpbNUyI4`, `stream_refused`) before it was written off.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  copyYoutubeFragmentAlreadyFetched,
  keepYoutubeFragmentWhenFetched,
  resetYoutubeFragmentsFetched,
} from "./videoPipeline";
import {
  noteRepeatedYoutubeRefusal,
  resetPermanentDownloadRefusals,
  youtubeDownloadRefusal,
  YOUTUBE_REFUSALS_BEFORE_WRITE_OFF_THIS_RENDER,
} from "./providerFailureClass";

const SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

describe("Video 622 — the same seconds are fetched once per render", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yt622-"));
  afterEach(() => resetYoutubeFragmentsFetched());

  it("a second scene asking for the same seconds gets a copy of the first one's file", async () => {
    const first = path.join(dir, "scene_0_a.mp4");
    const second = path.join(dir, "scene_1_a.mp4");
    const done = (async () => {
      fs.writeFileSync(first, "the seconds scene 0 fetched");
      return true;
    })();
    await keepYoutubeFragmentWhenFetched("youtube_cc:abc@t50810d40", first, done);
    /** The first beat may re-cut its own file; the copy that is handed on is the one fetched. */
    fs.writeFileSync(first, "re-cut by the beat");
    expect(await copyYoutubeFragmentAlreadyFetched("youtube_cc:abc@t50810d40", second)).toBe(true);
    expect(fs.readFileSync(second, "utf8")).toBe("the seconds scene 0 fetched");
  });

  it("a call that arrives while the first is still fetching waits for it", async () => {
    let finish!: (ok: boolean) => void;
    const first = path.join(dir, "scene_0_b.mp4");
    const done = new Promise<boolean>((r) => (finish = r));
    keepYoutubeFragmentWhenFetched("youtube_cc:abc@t10d40", first, done);
    const waiting = copyYoutubeFragmentAlreadyFetched("youtube_cc:abc@t10d40", path.join(dir, "scene_2_b.mp4"));
    fs.writeFileSync(first, "arrived");
    finish(true);
    expect(await waiting).toBe(true);
  });

  it("other seconds of the same video are fetched on their own", async () => {
    const first = path.join(dir, "scene_0_c.mp4");
    fs.writeFileSync(first, "x");
    await keepYoutubeFragmentWhenFetched("youtube_cc:abc@t10d40", first, Promise.resolve(true));
    expect(await copyYoutubeFragmentAlreadyFetched("youtube_cc:abc@t20d40", path.join(dir, "o.mp4"))).toBe(false);
  });

  it("a failed fetch is not handed on — the next caller fetches the seconds itself", async () => {
    await keepYoutubeFragmentWhenFetched("youtube_cc:def@t10d40", path.join(dir, "never.mp4"), Promise.resolve(false));
    expect(await copyYoutubeFragmentAlreadyFetched("youtube_cc:def@t10d40", path.join(dir, "p.mp4"))).toBe(false);
  });

  it("a new render starts with nothing fetched", async () => {
    const first = path.join(dir, "scene_0_d.mp4");
    fs.writeFileSync(first, "x");
    await keepYoutubeFragmentWhenFetched("youtube_cc:ghi@t10d40", first, Promise.resolve(true));
    resetYoutubeFragmentsFetched();
    expect(await copyYoutubeFragmentAlreadyFetched("youtube_cc:ghi@t10d40", path.join(dir, "q.mp4"))).toBe(false);
    expect(SRC).toContain("resetYoutubeFragmentsFetched();");
  });

  it("the download asks before it fetches, and reports the copy as its own reason", () => {
    const at = SRC.indexOf("const fragment = youtubeFragmentKeyFor(videoId, clipStart, duration);");
    expect(at).toBeGreaterThan(-1);
    /** VIDEO 623 — the block grew by the wait for a video's first transfer; the order is what is asserted. */
    const block = SRC.slice(at, at + 2400);
    expect(block).toContain('reportDownload("DOWNLOAD_SUCCESS", "same_seconds_already_fetched");');
    expect(block.indexOf("copyYoutubeFragmentAlreadyFetched")).toBeLessThan(block.indexOf("downloadYouTubeCCClip("));
    expect(block).toContain("keepYoutubeFragmentWhenFetched(fragment, outPath, done)");
  });
});

describe("Video 622 — a stream YouTube refuses twice is not asked for a third time", () => {
  afterEach(() => resetPermanentDownloadRefusals());

  it("one refusal is a moment; the second is the video", () => {
    expect(YOUTUBE_REFUSALS_BEFORE_WRITE_OFF_THIS_RENDER).toBe(2);
    expect(noteRepeatedYoutubeRefusal("23GzpbNUyI4", "http_502:stream_refused")).toBe(false);
    expect(youtubeDownloadRefusal("23GzpbNUyI4")).toBeNull();
    expect(noteRepeatedYoutubeRefusal("23GzpbNUyI4", "http_502:stream_refused")).toBe(true);
    expect(youtubeDownloadRefusal("23GzpbNUyI4")).toContain("stream_refused");
  });

  it("refusals of other videos do not add up", () => {
    noteRepeatedYoutubeRefusal("aaa", "http_502:stream_refused");
    expect(noteRepeatedYoutubeRefusal("bbb", "http_502:stream_refused")).toBe(false);
    expect(youtubeDownloadRefusal("bbb")).toBeNull();
  });

  it("a rate limit or a network error lifts on its own and is never counted", () => {
    for (const reason of ["http_502:rate_limited", "http_502:network", "http_502:other:x", undefined]) {
      noteRepeatedYoutubeRefusal("ccc", reason);
      noteRepeatedYoutubeRefusal("ccc", reason);
    }
    expect(youtubeDownloadRefusal("ccc")).toBeNull();
  });

  it("the next render asks again", () => {
    noteRepeatedYoutubeRefusal("ddd", "http_502:stream_refused");
    noteRepeatedYoutubeRefusal("ddd", "http_502:stream_refused");
    resetPermanentDownloadRefusals();
    expect(youtubeDownloadRefusal("ddd")).toBeNull();
    expect(noteRepeatedYoutubeRefusal("ddd", "http_502:stream_refused")).toBe(false);
  });

  it("counted once per request to the service, and the download refuses a video refused this render", () => {
    expect(SRC.match(/noteRepeatedYoutubeRefusal\(videoId, cloudReason\)/g)?.length).toBe(1);
    expect(SRC).toContain('reportDownload("DOWNLOAD_FAILED", `refused_this_render:${refusedThisRender}`);');
  });
});

describe("Video 622 — the same YouTube seconds are not played twice in a row", async () => {
  const { limitYoutubeShots, planYoutubePieces } = await import("./youtubeShotLimit");
  type Clip = import("./projectTimeline").TimelineVideoClip;
  const clip = (id: string, start: number, end: number, sceneIndex = 0): Clip =>
    ({
      id, kind: "video", source: { provider: "x" }, sourceIn: 0, sourceOut: end - start,
      timelineStart: start, timelineEnd: end, motion: "none", transitionIn: "hard_cut", transitionOut: "hard_cut",
      previewSource: { kind: "none" }, sceneIndex,
    }) as unknown as Clip;
  /** A 4 s fetch, one shot: one 4 s window. */
  const fourSeconds = { sourceDurationSec: 4, cutsSec: [] as number[], measured: true };

  it("the plan says how many of its pieces are different footage", () => {
    const plan = planYoutubePieces({ inSec: 0, durationSec: 16, facts: fourSeconds });
    expect(plan.pieces.length).toBeGreaterThan(plan.distinct!);
  });

  it("a shot beside it in the same scene takes the time the source cannot fill", () => {
    const { clips, notes } = limitYoutubeShots({
      clips: [clip("archive", 0, 5), clip("yt", 5, 21)],
      youtube: new Map([["yt", fourSeconds]]),
    });
    const yt = clips.filter((c) => c.id.startsWith("yt"));
    const starts = yt.map((c) => c.sourceIn);
    expect(new Set(starts).size, "the same seconds shown twice").toBe(starts.length);
    expect(clips[0]!.timelineEnd).toBe(yt[0]!.timelineStart);
    expect(clips[clips.length - 1]!.timelineEnd, "the timeline keeps its length").toBe(21);
    expect(notes.join("\n")).toContain("no repeat");
  });

  it("the shot after it takes the time when there is none before it", () => {
    const { clips } = limitYoutubeShots({
      clips: [clip("yt", 0, 16), clip("archive", 16, 20)],
      youtube: new Map([["yt", fourSeconds]]),
    });
    const yt = clips.filter((c) => c.id.startsWith("yt"));
    expect(new Set(yt.map((c) => c.sourceIn)).size).toBe(yt.length);
    expect(clips[clips.length - 1]!.timelineStart).toBe(yt[yt.length - 1]!.timelineEnd);
    expect(clips[clips.length - 1]!.timelineEnd).toBe(20);
  });

  it("a shot in another scene does not take it — then the repeat stays, and is reported", () => {
    const { clips, notes } = limitYoutubeShots({
      clips: [clip("archive", 0, 5, 0), clip("yt", 5, 21, 1)],
      youtube: new Map([["yt", fourSeconds]]),
    });
    expect(clips[0]!.timelineEnd).toBe(5);
    expect(notes.join("\n")).toContain("repeat");
  });
});
