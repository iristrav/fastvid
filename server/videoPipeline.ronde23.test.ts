import { readFileSync } from "fs";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { beatClipTextFilterEnabled } from "./sourcingPolicy";

// RONDE 23 — "er worden ook beelden gedownload waar tekst in beeld komt."
//
// The baked-in-text detector already existed (archiveClipHasBakedEditText) but was wired into
// exactly ONE call site: curatedMediaSourcing's own adoption path. Every externally sourced clip
// — YouTube CC, GDELT TV news, Internet Archive, SepiaSearch, Wikimedia, Openverse, SerpAPI,
// stock — reached the timeline without any text check at all. GDELT is the starkest case: it
// serves CNN/FOX/MSNBC/BBC broadcast segments, which essentially always carry lower-thirds and
// news tickers.
//
// The hook goes in beatClipPassesVisionGate, which its own comment identifies as the funnel every
// rescue/adoption route passes through — so one hook covers them all.

const src = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

afterEach(() => {
  delete process.env.ENABLE_BEAT_CLIP_TEXT_FILTER;
});

describe("RONDE 23 — the filter flag", () => {
  it("is on by default", () => {
    expect(beatClipTextFilterEnabled()).toBe(true);
  });

  it("can be switched off explicitly, case-insensitively", () => {
    process.env.ENABLE_BEAT_CLIP_TEXT_FILTER = "false";
    expect(beatClipTextFilterEnabled()).toBe(false);
    process.env.ENABLE_BEAT_CLIP_TEXT_FILTER = "FALSE";
    expect(beatClipTextFilterEnabled()).toBe(false);
  });

  it("stays on for any other value", () => {
    process.env.ENABLE_BEAT_CLIP_TEXT_FILTER = "true";
    expect(beatClipTextFilterEnabled()).toBe(true);
  });
});

describe("RONDE 23 — external clips are checked, once per asset", () => {
  const helper = src.slice(
    src.indexOf("async function beatClipHasBakedText("),
    src.indexOf("/** Vision gate on every adopted beat clip"),
  );

  it("reuses the existing detector rather than inventing a second one", () => {
    // RONDE 24 moved the memo into archiveClipFilter so archive ingestion shares it; the beat
    // gate now goes through that shared entry point instead of calling the raw detector itself.
    expect(helper).toMatch(/cachedClipHasBakedEditText\(\s*clipPath/);
  });

  it("caches by content key, so one asset costs one vision call across all beats", () => {
    expect(helper).toContain("clipContentKey(clipPath)");
  });

  it("honors the kill switch before doing any work", () => {
    const flagAt = helper.indexOf("beatClipTextFilterEnabled()");
    const callAt = helper.indexOf("cachedClipHasBakedEditText");
    expect(flagAt).toBeGreaterThan(-1);
    expect(flagAt).toBeLessThan(callAt);
  });

  it("fails OPEN on a detector error instead of emptying the cascade", () => {
    // A broken vision call must not reject every candidate — that would starve the render.
    // The fail-open behaviour now lives with the shared memo; assert it where it is implemented.
    const filterSrc = readFileSync(path.join(__dirname, "archiveClipFilter.ts"), "utf8");
    const cached = filterSrc.slice(
      filterSrc.indexOf("export async function cachedClipHasBakedEditText("),
      filterSrc.indexOf("export async function archiveClipHasBakedEditText("),
    );
    expect(cached).toContain("catch (err)");
    expect(cached).toContain("verdict = false;");
  });
});

describe("RONDE 23 — wired into the shared adoption funnel", () => {
  const gate = src.slice(
    src.indexOf("async function beatClipPassesVisionGate("),
    src.indexOf("const result = await evaluateClipVisionGate("),
  );

  it("rejects a clip with baked-in text", () => {
    // RONDE 29 split the call out of the `if` so the verdict can also be counted
    // (recordGateVerdict). What has to hold is that the check runs and its true branch fails
    // the clip — not the exact expression shape, which pinned an implementation detail.
    expect(gate).toContain("await beatClipHasBakedText(clipPath)");
    expect(gate).toMatch(/if \(hasBakedText\)|if \(await beatClipHasBakedText\(clipPath\)\)/);
    expect(gate).toContain("pass: false");
  });

  it("records the rejection under its own audit reason", () => {
    expect(gate).toContain('"baked_text"');
  });

  it("runs BEFORE the CLIP evaluation, so a text clip never costs a vision score", () => {
    const textAt = gate.indexOf("beatClipHasBakedText(clipPath)");
    expect(textAt).toBeGreaterThan(-1);
    // `gate` is sliced to end at the evaluateClipVisionGate call, so being inside it proves order.
    expect(gate).not.toContain("const result = await evaluateClipVisionGate(");
  });
});
