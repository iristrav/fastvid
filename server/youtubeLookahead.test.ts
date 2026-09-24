/**
 * RONDE 648 — the YouTube lookahead: work a scene starts for its later beats.
 *
 * The registry is driven with real asynchronous work (timers), not with provider responses: what
 * is under test is the queue, the cancellation and the query check.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { createLookaheadRegistry, lookaheadQueriesKey } from "./youtubeLookahead";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const Q = ["Adolf Hitler archival footage", "hitler documentary footage"];

describe("the registry", () => {
  it("a running lookahead is handed to its beat, and the beat gets exactly what it fetched", async () => {
    const reg = createLookaheadRegistry(3);
    reg.start("s0b0", Q, async () => {
      await sleep(30);
      return { paths: ["/tmp/a.mp4"], searched: true };
    });
    await sleep(5);
    const take = reg.take("s0b0", Q);
    expect(take.kind).toBe("use");
    if (take.kind !== "use") return;
    expect(take.state).toBe("running");
    expect(await take.result).toEqual({ paths: ["/tmp/a.mp4"], searched: true });
    expect(reg.stats().used).toBe(1);
  });

  it("A BEAT NEVER WAITS IN THE QUEUE: work not yet started is cancelled and never runs", async () => {
    const reg = createLookaheadRegistry(1);
    const ran: string[] = [];
    reg.start("s0b0", Q, async () => {
      ran.push("b0");
      await sleep(40);
      return { paths: [], searched: true };
    });
    reg.start("s0b1", Q, async () => {
      ran.push("b1");
      return { paths: ["/tmp/b1.mp4"], searched: true };
    });
    await sleep(5);
    // b1 is still queued behind b0 (parallel=1): its beat must not wait for it.
    expect(reg.take("s0b1", Q)).toEqual({ kind: "none", reason: "not_started_cancelled" });
    await sleep(60);
    expect(ran).toEqual(["b0"]);
    expect(reg.stats().cancelled).toBe(1);
  });

  it("no more than `parallel` run at once", async () => {
    const reg = createLookaheadRegistry(3);
    let live = 0;
    let peak = 0;
    const work = async () => {
      live++;
      peak = Math.max(peak, live);
      await sleep(20);
      live--;
      return { paths: [], searched: true };
    };
    for (let b = 0; b < 7; b++) reg.start(`s0b${b}`, Q, work);
    await sleep(120);
    expect(peak).toBe(3);
  });

  it("an answer to different queries is not used", async () => {
    const reg = createLookaheadRegistry(3);
    reg.start("s0b0", Q, async () => ({ paths: ["/tmp/x.mp4"], searched: true }));
    await sleep(5);
    expect(reg.take("s0b0", ["something else entirely"])).toEqual({ kind: "none", reason: "queries_differ" });
  });

  it("the key is the first five queries, in order — what a turn actually sends", () => {
    const seven = ["a", "b", "c", "d", "e", "f", "g"];
    expect(lookaheadQueriesKey(seven)).toBe(lookaheadQueriesKey(seven.slice(0, 5)));
    expect(lookaheadQueriesKey(["a", "b"])).not.toBe(lookaheadQueriesKey(["b", "a"]));
  });

  it("a failing lookahead is an unanswered one, not a thrown turn", async () => {
    const reg = createLookaheadRegistry(3);
    reg.start("s0b0", Q, async () => {
      throw new Error("proxy said no");
    });
    await sleep(5);
    const take = reg.take("s0b0", Q);
    expect(take.kind).toBe("use");
    if (take.kind === "use") expect(await take.result).toEqual({ paths: [], searched: false });
  });

  it("a beat takes its lookahead once", async () => {
    const reg = createLookaheadRegistry(3);
    reg.start("s0b0", Q, async () => ({ paths: [], searched: true }));
    await sleep(5);
    expect(reg.take("s0b0", Q).kind).toBe("use");
    expect(reg.take("s0b0", Q)).toEqual({ kind: "none", reason: "no_lookahead" });
  });
});

describe("the wiring", () => {
  const SRC = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

  it("the scene queues every beat's YouTube work before its beat loop", () => {
    const start = SRC.indexOf("startSceneYoutubeLookahead(scene, beats, workDir, clipFetchDur, videoTitle, personName, dedup);");
    const loop = SRC.indexOf("const renderIdForLadder = String(getActiveVideoId() ?? \"-\");");
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(loop);
  });

  it("the lookahead asks the same queries, through the same fetcher, as the beat's own turn", () => {
    const fn = SRC.slice(SRC.indexOf("function startSceneYoutubeLookahead("));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toContain("buildBeatYoutubeQueries(beat, scene, videoTitle, personName)");
    expect(body).toContain("fetchYouTubeCCClips(");
    expect(body).toContain("withBeatProvenance(");
    expect(body).toContain("withSceneFetchTimeout(");
  });

  it("the provider adapter takes the lookahead before it searches", () => {
    const at = SRC.indexOf("const ahead = dedup.youtubeLookahead?.take(youtubeTurnKey(sceneIndex, beat.index), req.queries);");
    const fetch = SRC.indexOf("const paths = await fetchYouTubeCCClips(", at);
    expect(at).toBeGreaterThan(-1);
    expect(fetch).toBeGreaterThan(at);
  });
});
