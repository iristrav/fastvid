/**
 * Video 619 — a beat waits for its lookahead no longer than its own turn.
 *
 * s1b0 was granted 103 s (fix A: room for the five beats after it) and used 120 s, the lookahead's
 * own limit, because it awaited the lookahead with a plain `await`. s1b1 was left 13 s and four
 * beats got no picture. No network: the lookahead is a promise the test controls.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { lookaheadWithinTurn, remainingScopeMs, withSceneFetchTimeout } from "./videoPipeline";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const never = <T>() => new Promise<T>(() => {});

describe("Video 619 — the wait for a lookahead ends with the beat's turn", () => {
  it("a lookahead that is ready in time is used as before", async () => {
    await expect(lookaheadWithinTurn(Promise.resolve({ paths: ["a.mp4"], searched: true }), 1_000)).resolves.toEqual({
      paths: ["a.mp4"],
      searched: true,
    });
  });

  it("one that is not ready when the turn ends is left behind", async () => {
    const t0 = Date.now();
    await expect(lookaheadWithinTurn(never(), 80)).resolves.toBeNull();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("a cancelled turn stops waiting at once; no time left means no wait", async () => {
    const c = new AbortController();
    const waiting = lookaheadWithinTurn(never(), 60_000, c.signal);
    c.abort();
    await expect(waiting).resolves.toBeNull();
    await expect(lookaheadWithinTurn(Promise.resolve(1), 0)).resolves.toBeNull();
    const done = new AbortController();
    done.abort();
    await expect(lookaheadWithinTurn(Promise.resolve(1), 5_000, done.signal)).resolves.toBeNull();
  });

  it("outside any scope nothing changes: it waits for the lookahead", async () => {
    await expect(lookaheadWithinTurn(Promise.resolve("x"), Number.POSITIVE_INFINITY)).resolves.toBe("x");
  });

  it("inside a beat's scope the wait ends at the scope's own deadline, not the lookahead's", async () => {
    const t0 = Date.now();
    const got = await withSceneFetchTimeout(
      () => lookaheadWithinTurn(never(), remainingScopeMs()),
      400,
      "a beat whose turn is shorter than its lookahead"
    ).catch(() => "scope-aborted");
    expect(got === null || got === "scope-aborted").toBe(true);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("wiring: the beat's search uses the bounded wait, and never a bare await on the lookahead", () => {
    const fn = PIPE.slice(PIPE.indexOf("async function tryBeatRealYouTubeFootage("), PIPE.indexOf("const paths = await fetchYouTubeCCClips("));
    expect(fn).toContain("const waitMs = remainingScopeMs();");
    expect(fn).toContain(
      "const got = await lookaheadWithinTurn(ahead.result, waitMs, sceneFetchScopeStorage.getStore()?.controller.signal);"
    );
    expect(fn).toContain("WAIT_ENDED after");
    expect(fn).not.toContain("await ahead.result");
  });
});
