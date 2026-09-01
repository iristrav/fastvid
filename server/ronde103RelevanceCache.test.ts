/**
 * RONDE 103 phase 3 — the verdict belongs to a (picture, narration) pair.
 *
 * The gate's cache used to be keyed on the picture alone, with the comment "contentKey -> verdict,
 * so the same clip is judged once per render". That reads like a saving and is a defect: the
 * question the model is asked is built from the beat's own words, so the first beat to look at a
 * clip decided for every later beat. A clip that genuinely fits "Berlin, April 1945" came back as
 * `fits` on a beat about a boardroom in 2019, was never re-examined, and was logged as though it
 * had been.
 *
 * These tests are about that one property and nothing else: when does a verdict get reused, and
 * when must it be earned again.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  createBeatImageGateState,
  judgeBeatImage,
  type BeatImageGateState,
} from "./beatImageRelevanceGate";
import { beatIdentityKey, type BeatVisualContext } from "./beatVisualRelevance";
import { __resetVerdictStoreForTests } from "./beatRelevanceVerdictStore";

const invoke = vi.hoisted(() => ({ fn: vi.fn() }));
// RONDE 115: the gate now asks llm.ts whether a throw was a PRE-FLIGHT refusal (no key,
// every provider cooled down, budget spent) rather than a provider failure. The real
// predicate is used, not a stub — these tests are about provider failures and must keep
// landing in `failed`, which is exactly what the real predicate says about them.
vi.mock("./_core/llm", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  invokeLLM: invoke.fn,
}));
vi.mock("./archiveClipFilter", () => ({
  prepareImageForVision: async (buf: Buffer) => ({ buffer: buf, mimeType: "image/jpeg" }),
  imageMimeToDataUrl: () => "data:image/jpeg;base64,AA",
}));

/** One real file on disk, because the gate refuses to judge frames it cannot read. */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r103-cache-"));
const FRAME = path.join(dir, "f.jpg");
fs.writeFileSync(FRAME, "not-really-a-jpeg-but-it-exists");

function answers(belongs: boolean, depicts = "a thing"): void {
  invoke.fn.mockResolvedValueOnce({
    choices: [{ message: { content: JSON.stringify({ depicts, belongs, reason: "r" }) } }],
  });
}

const BERLIN: BeatVisualContext = {
  sceneIndex: 0,
  beatIndex: 1,
  beatText: "Berlin was under constant bombardment in the last week of April 1945.",
  sceneText: "The final days of the Third Reich.",
  videoTitle: "The Fall of Berlin",
};
const BOARDROOM: BeatVisualContext = {
  sceneIndex: 3,
  beatIndex: 1,
  beatText: "The board met in Palo Alto to approve the acquisition.",
  sceneText: "A Silicon Valley takeover.",
  videoTitle: "The Fall of Berlin",
};

async function judge(
  contentKey: string,
  ctx: BeatVisualContext,
  state: BeatImageGateState
): Promise<string> {
  const j = await judgeBeatImage({
    framePaths: [FRAME],
    beatText: ctx.beatText,
    sceneText: ctx.sceneText,
    videoTitle: ctx.videoTitle,
    contentKey,
    beatIdentity: beatIdentityKey(ctx),
    state,
  });
  return j.verdict;
}

let state: BeatImageGateState;
beforeEach(() => {
  invoke.fn.mockReset();
  /**
   * RONDE 104: the durable verdict store keeps a process-level cache in front of the database,
   * and it is deliberately NOT render-scoped — a verdict about a (picture, narration) pair is the
   * same fact whoever asks. That is the feature, and it means these suites must clear it between
   * tests, or one test's answer silently answers the next test's question.
   */
  __resetVerdictStoreForTests();
  state = createBeatImageGateState();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("RONDE 103 phase 3 — the cache key", () => {
  it("TEST 1 — the same clip on the SAME beat is judged once", async () => {
    answers(true);
    expect(await judge("archive:99", BERLIN, state)).toBe("fits");
    expect(await judge("archive:99", BERLIN, state)).toBe("fits");
    expect(invoke.fn).toHaveBeenCalledTimes(1);
    expect(state.judgementAttempts).toBe(1);
  });

  it("TEST 2 — the same clip on a DIFFERENT beat is judged again", async () => {
    // The whole defect in one assertion: a clip that fits Berlin in 1945 must not be handed to a
    // beat about a Palo Alto boardroom carrying the earlier beat's approval.
    answers(true, "ruins of a bombed city");
    answers(false, "ruins of a bombed city");
    expect(await judge("archive:99", BERLIN, state)).toBe("fits");
    expect(await judge("archive:99", BOARDROOM, state)).toBe("does_not_fit");
    expect(invoke.fn).toHaveBeenCalledTimes(2);
  });

  it("TEST 3 — a DIFFERENT clip on the same beat is judged again", async () => {
    answers(true);
    answers(false);
    expect(await judge("archive:99", BERLIN, state)).toBe("fits");
    expect(await judge("archive:100", BERLIN, state)).toBe("does_not_fit");
    expect(invoke.fn).toHaveBeenCalledTimes(2);
  });

  it("TEST 4 — a cached verdict says so, so a log line cannot pretend it was a fresh look", async () => {
    answers(true);
    const first = await judgeBeatImage({
      framePaths: [FRAME], beatText: BERLIN.beatText, contentKey: "k",
      beatIdentity: beatIdentityKey(BERLIN), state,
    });
    const second = await judgeBeatImage({
      framePaths: [FRAME], beatText: BERLIN.beatText, contentKey: "k",
      beatIdentity: beatIdentityKey(BERLIN), state,
    });
    expect(first.cached).toBeUndefined();
    expect(second.cached).toBe(true);
    expect(second.verdict).toBe(first.verdict);
  });

  it("TEST 5 — a cached verdict costs nothing", async () => {
    answers(false);
    await judge("k", BERLIN, state);
    const spentAfterFirst = state.judgementAttempts;
    await judge("k", BERLIN, state);
    await judge("k", BERLIN, state);
    expect(state.judgementAttempts).toBe(spentAfterFirst);
  });

  it("TEST 6 — two beats with the SAME narration share a verdict; that is the equivalence class", async () => {
    /**
     * Beat identity is derived from the question, not the beat's position. Two beats that produce
     * the same question deserve the same answer — asking twice would be paying twice for a reply
     * the model cannot vary. This is also why `beat.index` is the wrong key: it would make these
     * two miss, and it would make s0b2 and s3b2 collide.
     */
    const a: BeatVisualContext = { ...BERLIN, sceneIndex: 0, beatIndex: 2 };
    const b: BeatVisualContext = { ...BERLIN, sceneIndex: 7, beatIndex: 9 };
    expect(beatIdentityKey(a)).toBe(beatIdentityKey(b));
    answers(true);
    expect(await judge("k", a, state)).toBe("fits");
    expect(await judge("k", b, state)).toBe("fits");
    expect(invoke.fn).toHaveBeenCalledTimes(1);
  });

  it("TEST 7 — a refusal is cached exactly like an acceptance, and only for its own beat", async () => {
    answers(false);
    answers(true);
    expect(await judge("k", BERLIN, state)).toBe("does_not_fit");
    expect(await judge("k", BERLIN, state)).toBe("does_not_fit");
    expect(invoke.fn).toHaveBeenCalledTimes(1);
    // ...and the refusal does not follow the clip onto an unrelated beat either.
    expect(await judge("k", BOARDROOM, state)).toBe("fits");
    expect(invoke.fn).toHaveBeenCalledTimes(2);
  });
});

describe("RONDE 103 phase 3 — what beat identity is derived from", () => {
  it("covers every input the prompt is built from: beat text, scene text, title", () => {
    const base = beatIdentityKey(BERLIN);
    expect(beatIdentityKey({ ...BERLIN, beatText: "Something else entirely." })).not.toBe(base);
    expect(beatIdentityKey({ ...BERLIN, sceneText: "A different scene." })).not.toBe(base);
    expect(beatIdentityKey({ ...BERLIN, videoTitle: "A different documentary" })).not.toBe(base);
  });

  it("ignores what the prompt cannot see: the beat's position in the video", () => {
    const base = beatIdentityKey(BERLIN);
    expect(beatIdentityKey({ ...BERLIN, sceneIndex: 42 })).toBe(base);
    expect(beatIdentityKey({ ...BERLIN, beatIndex: 42 })).toBe(base);
  });

  it("normalises only what the model cannot tell apart", () => {
    const base = beatIdentityKey(BERLIN);
    // Re-emitted with different spacing and a smart quote — the same question.
    expect(
      beatIdentityKey({
        ...BERLIN,
        beatText: "Berlin  was under constant bombardment, in the last week of April 1945!",
      })
    ).toBe(base);
    // A different number is a different question.
    expect(beatIdentityKey({ ...BERLIN, beatText: BERLIN.beatText.replace("1945", "1943") })).not.toBe(base);
  });

  it("a beat with no narration has no identity — the gate has nothing to ask about", () => {
    expect(beatIdentityKey({ sceneIndex: 0, beatIndex: 0, beatText: "   " })).toBe("");
  });

  it("truncates on the same boundaries the prompt does", () => {
    // buildPrompt slices beatText at 300 characters. Two beats the model is shown identically
    // must not miss the cache and be paid for twice.
    const long = "Berlin. ".repeat(80);
    expect(beatIdentityKey({ sceneIndex: 0, beatIndex: 0, beatText: long })).toBe(
      beatIdentityKey({ sceneIndex: 0, beatIndex: 0, beatText: `${long}And then something new.` })
    );
  });
});
