import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  judgeBeatImage,
  createBeatImageGateState,
  beatImageRelevanceGateEnabled,
  maxBeatImageJudgementsPerRender,
  MAX_JUDGEMENTS_PER_BEAT,
} from "./beatImageRelevanceGate";

/**
 * RONDE 58 — the gate that actually looks at the frame.
 *
 * The two judges that came before it decide without seeing the image: the metadata gate reads
 * the provider's title, and CLIP is measurably inverted for this material (render 531 scored a
 * white-lives-matter sticker 0.2226 and a genuine Hitler photograph 0.2116 on the same beat).
 *
 * The behaviour that matters most here is not the verdict — that is the model's job — but that
 * every way this can break adopts the clip anyway. A model outage must never empty a montage.
 */

// RONDE 115: the gate now asks llm.ts whether a throw was a PRE-FLIGHT refusal (no key,
// every provider cooled down, budget spent) rather than a provider failure. The real
// predicate is used, not a stub — these tests are about provider failures and must keep
// landing in `failed`, which is exactly what the real predicate says about them.
vi.mock("./_core/llm", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  invokeLLM: vi.fn(),
}));

const llm = async () => (await import("./_core/llm")).invokeLLM as unknown as ReturnType<typeof vi.fn>;

const answer = (belongs: boolean, depicts = "a bunker interior", reason = "fits the period") => ({
  choices: [{ message: { content: JSON.stringify({ depicts, belongs, reason }) } }],
});

let dir: string;
let frame: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-r58-"));
  frame = path.join(dir, "frame.jpg");
  execFileSync(
    "ffmpeg",
    ["-y", "-f", "lavfi", "-i", "color=c=gray:s=320x240", "-frames:v", "1", frame],
    { stdio: "ignore" }
  );
});
afterAll(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});
afterEach(async () => {
  (await llm()).mockReset();
  vi.unstubAllEnvs();
});

const judge = async (overrides: Partial<Parameters<typeof judgeBeatImage>[0]> = {}) =>
  judgeBeatImage({
    framePaths: [frame],
    beatText: "In April 1945, Adolf Hitler and Eva Braun died in the Führerbunker.",
    videoTitle: "Why Hitler Chose Death",
    contentKey: `key-${Math.random()}`,
    state: createBeatImageGateState(),
    ...overrides,
  });

describe("RONDE 58 — the verdict", () => {
  it("passes a frame the model says belongs", async () => {
    (await llm()).mockResolvedValue(answer(true));
    const v = await judge();
    expect(v.verdict).toBe("fits");
    expect(v.depicts).toBe("a bunker interior");
  });

  it("rejects a frame the model says does not belong", async () => {
    (await llm()).mockResolvedValue(
      answer(false, "a modern political bumper sticker", "present-day, unrelated subject")
    );
    const v = await judge();
    expect(v.verdict).toBe("does_not_fit");
    expect(v.depicts).toContain("sticker");
    expect(v.reason).toContain("present-day");
  });

  it("actually sends the image and the narration", async () => {
    const mock = await llm();
    mock.mockResolvedValue(answer(true));
    await judge();
    const content = mock.mock.calls[0]![0].messages[1].content as Array<Record<string, unknown>>;
    const image = content.find((c) => c.type === "image_url") as { image_url: { url: string } };
    const text = content.find((c) => c.type === "text") as { text: string };
    expect(image.image_url.url.startsWith("data:image/")).toBe(true);
    expect(text.text).toContain("Führerbunker");
    // The frame is judged, not the file name — the prompt says so explicitly.
    expect(text.text).toMatch(/Judge the picture, not its file name/);
  });
});

describe("RONDE 58 — it fails open, in every direction", () => {
  const expectAdopts = (verdict: string) => expect(verdict).not.toBe("does_not_fit");

  it("a missing frame adopts the clip", async () => {
    const v = await judge({ framePaths: [path.join(dir, "nope.jpg")] });
    expect(v.verdict).toBe("unknown");
    expectAdopts(v.verdict);
    // And it never spent a call on it.
    expect((await llm())).not.toHaveBeenCalled();
  });

  it("a model error adopts the clip", async () => {
    (await llm()).mockRejectedValue(new Error("503 upstream unavailable"));
    const v = await judge();
    expect(v.verdict).toBe("unknown");
    expect(v.reason).toContain("judgement failed");
  });

  it("a timeout adopts the clip", async () => {
    (await llm()).mockImplementation(() => new Promise(() => {}));
    const v = await judge({ timeoutMs: 50 });
    expect(v.verdict).toBe("unknown");
  });

  it("a malformed answer adopts the clip", async () => {
    (await llm()).mockResolvedValue({ choices: [{ message: { content: "not json at all" } }] });
    expect((await judge()).verdict).toBe("unknown");
    (await llm()).mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ depicts: "x", reason: "y" }) } }],
    });
    expect((await judge()).verdict).toBe("unknown");
  });

  it("an empty narration adopts the clip — there is nothing to judge against", async () => {
    const v = await judge({ beatText: "   " });
    expect(v.verdict).toBe("unknown");
    expect((await llm())).not.toHaveBeenCalled();
  });

  it("the gate can be switched off entirely", async () => {
    vi.stubEnv("ENABLE_BEAT_IMAGE_RELEVANCE_GATE", "false");
    expect(beatImageRelevanceGateEnabled()).toBe(false);
    const v = await judge();
    expect(v.verdict).toBe("unknown");
    expect((await llm())).not.toHaveBeenCalled();
  });
});

describe("RONDE 58 — bounded cost", () => {
  it("the same clip is judged once per render, however often it comes back", async () => {
    const mock = await llm();
    mock.mockResolvedValue(answer(true));
    const state = createBeatImageGateState();
    for (let i = 0; i < 5; i++) {
      await judge({ contentKey: "same-clip", state });
    }
    expect(mock).toHaveBeenCalledTimes(1);
    expect(state.judgementAttempts).toBe(1);
  });

  it("a render-wide ceiling stops it spending without bound", async () => {
    const mock = await llm();
    mock.mockResolvedValue(answer(true));
    vi.stubEnv("MAX_BEAT_IMAGE_JUDGEMENTS", "3");
    expect(maxBeatImageJudgementsPerRender()).toBe(3);
    const state = createBeatImageGateState();
    for (let i = 0; i < 10; i++) {
      await judge({ contentKey: `clip-${i}`, state });
    }
    expect(mock).toHaveBeenCalledTimes(3);
    // Past the ceiling it goes on adopting, it does not start rejecting.
    const past = await judge({ contentKey: "clip-past", state });
    expect(past.verdict).toBe("unknown");
    expect(past.reason).toContain("budget spent");
  });

  it("a rejected verdict is cached too — a bad clip is not re-judged either", async () => {
    const mock = await llm();
    mock.mockResolvedValue(answer(false, "a webpage screenshot"));
    const state = createBeatImageGateState();
    await judge({ contentKey: "bad-clip", state });
    const second = await judge({ contentKey: "bad-clip", state });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(second.verdict).toBe("does_not_fit");
  });
});

describe("RONDE 58 — the wiring", () => {
  const SRC = () => fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

  it("runs on the candidate about to be adopted, not on every candidate", () => {
    const src = SRC();
    const idx = src.indexOf("let winner = pickBestFunnelCandidate(");
    expect(idx).toBeGreaterThan(-1);
    /**
     * Widened from 4600 in RONDE 131, which inserted the mismatch-feedback block into the refusal
     * branch and pushed the last assertion below past the old edge. The window is a way of saying
     * "in the funnel's adopt block" and nothing else — every assertion is unchanged, and each one
     * still fails if the line it names is deleted.
     */
    const block = src.slice(idx, idx + 6800);
    /**
     * SUPERSEDED BY RONDE 103, deliberately.
     *
     * This asserted `judgeBeatImage({` — the funnel calling the vision model directly. RONDE 103
     * made that a bypass by definition: the funnel held its own copy of the frame sampling, the
     * cleanup and the cache key, and it was the copy that keyed verdicts on the picture alone, so
     * a clip approved on beat 1 was never re-examined on beat 7. The call now goes through the
     * pipeline's single content decider, which is a STRONGER version of what this test guards —
     * the funnel still judges the candidate about to be adopted, and now it cannot judge it
     * differently from every other route.
     */
    expect(block).toContain("checkBeatRelevance({");
    expect(block).toContain('route: `funnel:${winner.candidate.source}`,');
    // Bounded per beat, and a rejected winner steps down to the next-best rather than to nothing.
    expect(block).toContain("look < MAX_JUDGEMENTS_PER_BEAT");
    expect(block).toContain("dedup.usedFunnelCandidateIds.add(winner.candidate.id);");
    // RONDE 61: the re-pick now also excludes what the gate refused, so a beat with a single
    // passer cannot be handed the very clip just rejected.
    expect(block).toMatch(
      /winner = pickBestFunnelCandidate\(scored, dedup\.usedFunnelCandidateIds, dedup\.beatImageRejectedIds\);/
    );
    // Only a definite "does not fit" costs the candidate its place.
    expect(block).toContain('if (judgement.verdict !== "does_not_fit") break;');
  });

  it("the gate's own state is render-scoped, not module-level", () => {
    const src = SRC();
    expect(src).toContain("beatImageGate: BeatImageGateState;");
    expect(src).toContain("beatImageGate: createBeatImageGateState(),");
    expect(src).toContain("state: dedup.beatImageGate,");
  });

  it("the frames it judges are cleaned up", () => {
    /**
     * SUPERSEDED BY RONDE 103, deliberately — and made harder to break.
     *
     * The cleanup used to be inlined at three call sites, and this test checked one of them. It
     * now lives once, in the central gate, so the assertion moved with it. That is strictly
     * stronger: a fourth route cannot be added with the cleanup forgotten, because there is no
     * longer a place to forget it.
     */
    const mod = fs.readFileSync(path.join(__dirname, "beatVisualRelevance.ts"), "utf8");
    const idx = mod.indexOf("function discardFrames(");
    expect(idx).toBeGreaterThan(-1);
    expect(mod.slice(idx, idx + 400)).toMatch(/for \(const p of framePaths\)[\s\S]{0,120}fs\.unlinkSync\(p\)/);
    // And the gate discards them on every exit, not only the happy one.
    expect(mod).toContain("discardFrames(framePaths);");
    // The funnel no longer owns a copy it could forget to clean up.
    const src = SRC();
    const funnel = src.slice(src.indexOf("let winner = pickBestFunnelCandidate("), src.indexOf("let winner = pickBestFunnelCandidate(") + 4600);
    expect(funnel).not.toContain("fs.unlinkSync");
  });

  it("a rejection is recorded in the audit, so the reason survives the render", () => {
    const src = SRC();
    const idx = src.indexOf("let winner = pickBestFunnelCandidate(");
    expect(src.slice(idx, idx + 4600)).toContain('"beat_image_gate"');
  });

  it("MAX_JUDGEMENTS_PER_BEAT is small — this is a verification step, not a search", () => {
    expect(MAX_JUDGEMENTS_PER_BEAT).toBeLessThanOrEqual(3);
    expect(MAX_JUDGEMENTS_PER_BEAT).toBeGreaterThanOrEqual(1);
  });
});
