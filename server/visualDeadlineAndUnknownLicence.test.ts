/**
 * Two rules, and nothing else.
 *
 *   1. An unknown licence is not a refusal. The operator checks rights afterwards; the item stays
 *      UNVERIFIED and says so. An explicitly restrictive licence is still refused.
 *   2. The visual phase has ONE hard wall-clock deadline — the render's retrieval budget. After it
 *      no search or download starts, what is in flight is aborted, an empty beat is a gap and the
 *      timeline holds the previous shot over it.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import http from "http";
import type { AddressInfo } from "net";
import path from "path";

import { youtubeLicenseDecision } from "./youtubeLicenseStatus";
import { withSceneFetchTimeout, isScopeAbortError, fetchWithTimeout } from "./videoPipeline";
import { holdPictureUnderVoice } from "./edlToTimeline";
import type { TimelineVideoClip } from "./projectTimeline";
import { filmWithoutPictureRefusal } from "./deliveryGate";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

describe("licence: unknown is not refused, restrictive still is", () => {
  it("a known permissive licence is allowed", () => {
    const d = youtubeLicenseDecision({
      identifier: "SomeNewsreel1943",
      licenseUrl: "http://creativecommons.org/publicdomain/mark/1.0/",
      allowUnverified: true,
    });
    expect(d.allowed).toBe(true);
    expect(d.status).toBe("VERIFIED");
    expect(d.action).toBe("ALLOW");
  });

  it("an unknown licence is allowed and stays UNVERIFIED — for any archive item", () => {
    for (const identifier of ["SomeNewsreel1943", "BitChute-j0TIfaIRZAsd", "youtube-p_rrH7MQIOY"]) {
      const d = youtubeLicenseDecision({ identifier, allowUnverified: true });
      expect(d.allowed, identifier).toBe(true);
      expect(d.status, identifier).toBe("UNVERIFIED");
      expect(d.metadataStatus, identifier).toBe("UNVERIFIED");
    }
  });

  it("an explicitly restrictive licence keeps the existing refusal", () => {
    for (const licenseUrl of [
      "https://creativecommons.org/licenses/by-nc/4.0/",
      "https://creativecommons.org/licenses/by-nd/4.0/",
    ]) {
      const d = youtubeLicenseDecision({ identifier: "SomeNewsreel1943", licenseUrl, allowUnverified: true });
      expect(d.allowed, licenseUrl).toBe(false);
      expect(d.status, licenseUrl).toBe("REJECTED");
    }
  });

  it("the pipeline still says the rights are not proven when it uses such an item", () => {
    expect(PIPE).toContain('licenseDecision.action === "ALLOW_UNVERIFIED"');
    expect(PIPE).toContain("rights NOT proven, verify manually");
  });
});

describe("one hard deadline for the visual phase", () => {
  it("work that finishes before the deadline is returned as normal", async () => {
    await expect(withSceneFetchTimeout(async () => "clip", 500, "fast scene")).resolves.toBe("clip");
  });

  it("work that runs into the deadline is stopped", async () => {
    const slow = () => new Promise<string>((resolve) => setTimeout(() => resolve("late"), 400));
    await expect(withSceneFetchTimeout(slow, 50, "slow scene")).rejects.toThrow(/exceeded/);
  });

  it("nothing starts after the deadline: a scope opened under an ended one does not run", async () => {
    let started = false;
    let inner: unknown = null;
    await withSceneFetchTimeout(async () => {
      await new Promise((r) => setTimeout(r, 80));
      try {
        await withSceneFetchTimeout(async () => {
          started = true;
        }, 5_000, "a search after the deadline");
      } catch (err) {
        inner = err;
      }
    }, 30, "visual phase").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 120));
    expect(started, "a search began after the deadline").toBe(false);
    expect(isScopeAbortError(inner)).toBe(true);
  });

  it("an in-flight download is aborted when the deadline passes", async () => {
    /** A local server that accepts the request and never answers: the fetch can only end by abort. */
    const server = http.createServer(() => undefined);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    let caught: unknown = null;
    try {
      await withSceneFetchTimeout(async () => {
        try {
          await fetchWithTimeout(`http://127.0.0.1:${port}/clip.mp4`, 5_000, "download");
        } catch (err) {
          caught = err;
        }
      }, 50, "visual phase").catch(() => undefined);
      await new Promise((r) => setTimeout(r, 150));
      expect(caught, "the download was not aborted").not.toBeNull();
      expect(isScopeAbortError(caught), "aborted by its own timer, not by the deadline").toBe(true);
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });

  it("the pipeline clamps every chunk to the one deadline and skips chunks after it", () => {
    /** VIDEO 621 — and at least as much picture time as the video is long, at the one-minute rate. */
    expect(PIPE).toContain("const byLengthDeadlineMs = visualDeadlineForVideoMs(\n      (get_activeRenderBudget()?.perSceneRetrieveMs ?? 35_000) * scenes.length,");
    /** P5 / VIDEO 630 — and never less than one judged turn per sentence (video630JudgeTime.test.ts). */
    expect(PIPE).toContain("const visualDeadlineMs = judgeableVisualDeadlineMs(\n      byLengthDeadlineMs,");
    expect(PIPE).toContain("const visualTimeLeftMs = visualDeadlineAtMs - Date.now();");
    /** VIDEO 621 — and each chunk to its share of what is left, not to all of it. */
    expect(PIPE).toMatch(
      /Math\.min\(\s*chunkStageTimeoutMs\([\s\S]{0,300}?\),\s*chunkShareOfVisualTimeMs\(visualTimeLeftMs, chunkScenes\.length, scenes\.length - chunk\.start\)\s*\)/
    );
    expect(PIPE).toContain("Visual deadline reached — chunk");
  });

  it("a scene that returns after its chunk closed writes nothing; an unfinished scene is a gap", () => {
    expect(PIPE).toContain("if (chunkClosed) return result;");
    expect(PIPE).toContain("sceneVisualResults[si] ??= { clips: [], beatDurations: [] };");
  });

  it("an empty scene is a gap the timeline holds over; only a film with no picture at all is refused", () => {
    expect(PIPE).toContain("no picture found — the timeline holds the previous shot");
    /** ONE ROUTE: the rule lives in the DeliveryGate; the pipeline asks it and throws its sentence. */
    const refusal = PIPE.indexOf("if (firstEmptySi !== null) {");
    expect(refusal).toBeGreaterThan(0);
    expect(PIPE).toContain("const firstEmptySi = filmWithoutPictureRefusal(");
    expect(filmWithoutPictureRefusal([[], ["fallback.mp4"]], (c) => c === "fallback.mp4")).toBe(0);
    expect(filmWithoutPictureRefusal([[], ["real.mp4"]], (c) => c === "fallback.mp4")).toBeNull();
    expect(filmWithoutPictureRefusal([], () => false)).toBeNull();
    expect(PIPE.indexOf("no picture was found for any of its beats — export geblokkeerd")).toBeGreaterThan(refusal);
  });

  it("the timeline stays valid across a gap — the previous shot is held to the next one", () => {
    const clip = (id: string, start: number, end: number) =>
      ({ id, timelineStart: start, timelineEnd: end }) as unknown as TimelineVideoClip;
    const clips = [clip("a", 0, 4), clip("b", 9, 12)];
    const lines = holdPictureUnderVoice({ clips, voiceDurationSec: 12 });
    expect(clips[0]!.timelineEnd).toBe(9);
    expect(lines.join(" ")).toContain("held");
  });
});
