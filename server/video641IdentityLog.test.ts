import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * VIDEO 641 (L1) — "identity guessed, not seen" was logged for every refusal by the situation rule:
 * the log compared the final verdict with the model's answer, not with what reached the identity
 * rule. Log only — the verdict is the same before and after.
 */
const answer = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("./_core/llm", async (importOriginal) => {
  const real = await importOriginal<typeof import("./_core/llm")>();
  return {
    ...real,
    invokeLLM: vi.fn(async () => ({ choices: [{ message: { content: JSON.stringify(answer.current) } }] })),
  };
});
vi.mock("./beatRelevanceVerdictStore", async (importOriginal) => {
  const real = await importOriginal<typeof import("./beatRelevanceVerdictStore")>();
  return { ...real, lookupVerdict: vi.fn(async () => null), persistVerdict: vi.fn(async () => {}) };
});

import { createBeatImageGateState, judgeBeatImage } from "./beatImageRelevanceGate";

let dir: string;
let frame: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "l1-"));
  frame = path.join(dir, "frame.jpg");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=1:duration=1", "-frames:v", "1", frame]);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

let logs: string[];
beforeEach(() => {
  vi.restoreAllMocks();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((l: unknown) => void logs.push(String(l)));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const judge = (beatText: string) =>
  judgeBeatImage({
    framePaths: [frame],
    beatText,
    contentKey: `clip-${Math.random()}`,
    beatIdentity: `beat-${Math.random()}`,
    state: createBeatImageGateState(),
    timeoutMs: 10_000,
  });
const identityLines = () => logs.filter((l) => l.includes("identity guessed, not seen"));
const situationLines = () => logs.filter((l) => l.includes("subject without the situation"));

describe("L1 — the identity-guess log names its own cause", () => {
  it("a refusal by the situation rule is logged as that, not as an identity guess; the verdict is unchanged", async () => {
    answer.current = {
      depicts: "A man resembling Elon Musk sitting in a car.",
      subject_matches: true,
      situation_matches: false,
      belongs: true,
      reason: "It shows Musk, who is named in the line.",
      framing: "medium shot",
    };
    const j = await judge("Elon Musk announced the Tesla Model 3 on stage in 2016.");
    expect(j.verdict).toBe("does_not_fit");
    expect(j.reason).toMatch(/^situation not shown/);
    expect(situationLines()).toHaveLength(1);
    expect(identityLines()).toEqual([]);
  });

  it("a real identity guess is still logged as one; the verdict is unchanged", async () => {
    answer.current = {
      depicts: "A man resembling Elon Musk standing on a stage with a car.",
      subject_matches: true,
      situation_matches: true,
      belongs: true,
      reason: "The man appears to be Elon Musk presenting a car, which matches the line.",
      framing: "medium shot",
    };
    const j = await judge("Elon Musk announced the Tesla Model 3 on stage in 2016.");
    expect(j.verdict).toBe("does_not_fit");
    expect(j.reason).toMatch(/^identity guessed, not seen: /);
    expect(identityLines()).toHaveLength(1);
    expect(situationLines()).toEqual([]);
  });

  it("an approval that passes both rules logs neither", async () => {
    answer.current = {
      depicts: "A red car on a stage under spotlights.",
      subject_matches: true,
      situation_matches: true,
      belongs: true,
      reason: "A car presented on a stage, as the line describes.",
      framing: "wide shot",
    };
    const j = await judge("The new car was presented on stage in 2016.");
    expect(j.verdict).toBe("fits");
    expect(identityLines()).toEqual([]);
    expect(situationLines()).toEqual([]);
  });

  it("the comparison is with the verdict that reached the rule", () => {
    const GATE = fs.readFileSync(path.join(__dirname, "beatImageRelevanceGate.ts"), "utf8");
    expect(GATE).toContain("if (judgement !== judgementAfterSituation) {");
    expect(GATE).not.toContain("if (judgement !== judgementAsGiven) {");
  });
});
