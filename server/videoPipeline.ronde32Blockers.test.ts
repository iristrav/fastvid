import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

// RONDE 32 — the two production blockers the implementation review raised against D/A/B/C.
//
// B1  FIX A leaves rescueClips EMPTY whenever the scene's survivors already meet minNeeded —
//     which is exactly the case where the scene HAS good footage. If compose then fails twice,
//     the last-resort branch reached for rescueClips[0], found nothing, generated a fresh
//     fallback card and shipped a whole scene as one static image while real, validated clips
//     sat on disk. Render 529's scene 0 (5 clips, minNeeded 5) sits precisely on that boundary.
// B2  A salvaged compose (FIX D) skipped composeSceneVideo entirely, so usedClips stayed empty
//     and composedUsedClips[i] became []. Two consumers fall back to sceneVisualResults, two do
//     not — allClipPaths (quality report) and buildEditorScenesFromPipeline — so a salvaged
//     scene reported zero footage to exactly the instruments used to judge these fixes.
//
// Scope note, unchanged from the D/A/B/C tests: the last-resort and salvage branches themselves
// live in _runVideoPipelineInner, which needs a database, an LLM and a TTS provider. The
// decision helpers are covered behaviourally with real ffmpeg/ffprobe; the wiring at the two
// call sites is covered structurally, because the review's central point was that a fix landing
// on only one of the two paths is how this class of bug survives.

const REPO_PIPELINE = path.join(__dirname, "videoPipeline.ts");
const src = () => fs.readFileSync(REPO_PIPELINE, "utf8");

function writeTestVideo(filePath: string, durationSec: number): void {
  execFileSync(
    "ffmpeg",
    [
      "-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=25",
      "-t", durationSec.toFixed(3),
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an",
      filePath,
    ],
    { stdio: "ignore" }
  );
}

function writeTestAudio(filePath: string, durationSec: number): void {
  execFileSync(
    "ffmpeg",
    [
      "-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
      "-t", durationSec.toFixed(3), "-c:a", "libmp3lame", "-b:a", "64k",
      filePath,
    ],
    { stdio: "ignore" }
  );
}

async function probeDurationSec(filePath: string): Promise<number> {
  const { probeVideoStreamMeta } = await import("./videoPipeline");
  return (await probeVideoStreamMeta(filePath))?.durationSec ?? 0;
}

describe("RONDE 32 B1 — a scene with real survivors is never written off as a fallback card", () => {
  let dir: string;
  let clipA: string;
  let clipB: string;
  let clipC: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-r32-b1-"));
    clipA = path.join(dir, "scene_0_b0_survivor_a.mp4");
    clipB = path.join(dir, "scene_0_b1_survivor_b.mp4");
    clipC = path.join(dir, "scene_0_b2_survivor_c.mp4");
    for (const p of [clipA, clipB, clipC]) writeTestVideo(p, 4);
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("survivors = [A,B,C] are all recognised as reusable, so the ?? chain never reaches generation", async () => {
    const { usableSurvivorClips } = await import("./videoPipeline");
    // The scenario: minNeeded = 3, survivors = 3 -> missing = 0 -> rescueClips = [].
    const survivors = await usableSurvivorClips([clipA, clipB, clipC]);
    expect(survivors).toEqual([clipA, clipB, clipC]);

    // This is the exact expression both last-resort paths evaluate.
    const rescueClips: string[] = [];
    const reusableLastClip = rescueClips[0] ?? survivors[0];
    expect(reusableLastClip).toBe(clipA);
    // Non-undefined -> no sceneRescueColorFallbackCount++, no generateGuaranteedBeatClip,
    // no recordClipAdopt("fallback"). The scene keeps real footage.
    expect(reusableLastClip).toBeDefined();
  }, 60_000);

  it("survivors = [] and rescueClips = [] still fall through to the original fallback route", async () => {
    const { usableSurvivorClips } = await import("./videoPipeline");
    const survivors = await usableSurvivorClips([]);
    expect(survivors).toEqual([]);

    const rescueClips: string[] = [];
    const reusableLastClip = rescueClips[0] ?? survivors[0];
    // Undefined -> the pre-existing generate/colour-card branch runs, and the quality
    // bookkeeping increments exactly as it always did.
    expect(reusableLastClip).toBeUndefined();
  }, 60_000);

  it("rescue clips keep first claim when both exist (precedence deliberately unchanged)", async () => {
    const { usableSurvivorClips } = await import("./videoPipeline");
    const survivors = await usableSurvivorClips([clipA, clipB, clipC]);
    const rescueClips = ["/tmp/rescue_0.mp4"];
    expect(rescueClips[0] ?? survivors[0]).toBe("/tmp/rescue_0.mp4");
  }, 60_000);

  it("rejects clips that are missing, empty, undecodable, or one of our own fallback cards", async () => {
    const { usableSurvivorClips } = await import("./videoPipeline");
    const missing = path.join(dir, "nope.mp4");
    const empty = path.join(dir, "empty.mp4");
    const garbage = path.join(dir, "garbage.mp4");
    const ownCard = path.join(dir, "scene_0_fallback.mp4");
    fs.writeFileSync(empty, Buffer.alloc(0));
    fs.writeFileSync(garbage, Buffer.alloc(8192, 0x41));
    writeTestVideo(ownCard, 4); // real video, but named like a pipeline fallback card

    const survivors = await usableSurvivorClips([missing, empty, garbage, ownCard, clipB]);
    expect(survivors).toEqual([clipB]);
  }, 60_000);

  it("composeLastResortSceneFromClip turns a survivor into a full scene with voiceover", async () => {
    const { composeLastResortSceneFromClip } = await import("./videoPipeline");
    const audio = path.join(dir, "scene_7_audio.mp3");
    writeTestAudio(audio, 6);

    const out = await composeLastResortSceneFromClip(7, 6, clipA, audio, dir);
    expect(out).toBe(path.join(dir, "scene_7_lastresort.mp4"));
    expect(fs.existsSync(out)).toBe(true);
    // This path trims, it does not pad: the video runs as long as the source clip (4s) even
    // though the scene is 6s. That is the pre-existing last-resort behaviour and is asserted
    // here as-is — what matters for B1 is that the output was built from the SURVIVOR, which
    // its 4s length demonstrates (a generated fallback card would be the full scene duration).
    const dur = await probeDurationSec(out);
    expect(dur).toBeGreaterThan(3.5);
    expect(dur).toBeLessThan(4.5);
  }, 120_000);

  it("composeLastResortSceneFromClip still produces a scene when the voiceover is missing", async () => {
    const { composeLastResortSceneFromClip } = await import("./videoPipeline");
    const out = await composeLastResortSceneFromClip(8, 5, clipB, path.join(dir, "no_such_audio.mp3"), dir);
    expect(fs.existsSync(out)).toBe(true);
    // Silent-audio substitution kicked in; the video is still the 4s survivor.
    expect(fs.existsSync(path.join(dir, "scene_8_lastresort_silent.mp3"))).toBe(true);
    expect(await probeDurationSec(out)).toBeGreaterThan(3.5);
  }, 120_000);

  it("both last-resort paths consult survivors before generating anything new", () => {
    const s = src();
    const chain = s.match(/const reusableLastClip = rescueClips\[0\] \?\? lastResortSurvivors\[0\];/g) ?? [];
    expect(chain.length).toBe(2);

    const survivorLookups = s.match(/const lastResortSurvivors = await usableSurvivorClips\(/g) ?? [];
    expect(survivorLookups.length).toBe(2);

    // The "fallback" adopt record must hang off the "nothing to reuse" condition — not off
    // rescueClips alone, which FIX A can legitimately leave empty for a scene full of good
    // footage. That is the B1 property and it is unchanged.
    expect(s).not.toContain("const hadRescueClips = rescueClips.length > 0;");
    // RONDE 48 (C1): Stage4's branch is still keyed on the same reuse chain — `lastClip` is
    // seeded FROM reusableLastClip — but the colour-card counter no longer hangs off it. It
    // moved into the failure path of the guaranteed-clip call, because a scene that gets real
    // footage from that call is not a colour rescue. The counter itself is asserted in
    // videoPipeline.ronde48StageFourCounter.test.ts; what B1 guards here is the branch key.
    expect(s).toContain("let lastClip = reusableLastClip;");
    expect(s).toMatch(/if \(!lastClip\) \{[\s\S]{0,600}?recordClipAdopt\(visualDedup\.clipAdoptAudit/);
  });

  it("the P5A colour card only runs when there is genuinely nothing to reuse", () => {
    const s = src();
    // Ordering inside the P5A rescue block, asserted by position rather than by a char window —
    // RONDE 34 (point 7) inserted a parity attempt here (generate a guaranteed clip and mux it
    // like Stage4 does) and the block will keep growing. The invariant is the ORDER: reuse a
    // real clip first, then try to produce one, and only then write the scene off as a card.
    const p5 = s.indexOf("`P5A composeSceneVideo s${scene.index}`");
    expect(p5).toBeGreaterThan(-1);
    const at = (needle: string) => {
      const i = s.indexOf(needle, p5);
      expect(i).toBeGreaterThan(-1);
      return i;
    };
    const reuse = at("const reusableLastClip = rescueClips[0] ?? lastResortSurvivors[0];");
    const reuseBranch = at("if (reusableLastClip) {");
    const parity = at("parityClip = await generateGuaranteedBeatClip(");
    const counter = at("visualDedup.sceneRescueColorFallbackCount++;");
    const card = at("result = await generateColorFallback(");

    expect(reuse).toBeLessThan(reuseBranch);
    expect(reuseBranch).toBeLessThan(parity);
    expect(parity).toBeLessThan(counter);
    expect(counter).toBeLessThan(card);
    // The counter still fires only alongside the card, never for a scene that got real footage.
    expect(card - counter).toBeLessThan(200);
  });
});

describe("RONDE 32 B2 — a salvaged scene reports the clips it is made of", () => {
  let dir: string;
  let clipA: string;
  let clipB: string;
  let clipC: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-r32-b2-"));
    clipA = path.join(dir, "scene_1_b0_survivor_a.mp4");
    clipB = path.join(dir, "scene_1_b1_survivor_b.mp4");
    clipC = path.join(dir, "scene_1_b2_survivor_c.mp4");
    for (const p of [clipA, clipB, clipC]) writeTestVideo(p, 4);
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("salvage contributes the real survivor set, not an empty array", async () => {
    const { usableSurvivorClips } = await import("./videoPipeline");
    const usedClips: string[] = [];
    // This is what the salvage branch now does with sceneVisualResults[i]?.clips.
    usedClips.push(...(await usableSurvivorClips([clipA, clipB, clipC])));

    expect(usedClips).toEqual([clipA, clipB, clipC]);

    // composedUsedClips[i] = usedClips, and the two consumers that do NOT fall back to
    // sceneVisualResults then see real footage instead of a zero-clip scene.
    const composedUsedClips = [[], usedClips, []] as string[][];
    const allClipPaths = composedUsedClips.flat().filter(Boolean);
    expect(allClipPaths).toHaveLength(3);
    expect(composedUsedClips[1]).not.toHaveLength(0);
  }, 60_000);

  it("both salvage branches populate usedClips from the scene's own clips", () => {
    const s = src();
    const pushes = s.match(/usedClips\.push\(\.\.\.\(await usableSurvivorClips\(/g) ?? [];
    expect(pushes.length).toBe(2);
    // Stage4 reads sceneVisualResults[i], P5A reads its svr binding — the same set each path
    // handed to its first compose attempt.
    expect(s).toContain("usedClips.push(...(await usableSurvivorClips(sceneVisualResults[i]?.clips ?? [])));");
    expect(s).toContain("usedClips.push(...(await usableSurvivorClips(svr?.clips ?? [])));");
  });

  it("salvage does not fabricate montage metadata it cannot know", () => {
    // Deliberate: composeMeta.montageDurations stays empty on the salvage path. The clip list
    // is recoverable (B2); per-clip montage timings are not, and the voice/montage sync audit
    // downstream is already guarded on montageDurations.length > 0, so leaving it empty skips
    // an audit rather than feeding it invented numbers.
    const s = src();
    const salvageIdx = s.indexOf("compose timed out but produced a complete output");
    expect(salvageIdx).toBeGreaterThan(-1);
    const scoped = s.slice(salvageIdx, salvageIdx + 900);
    expect(scoped).not.toMatch(/composeMeta\.montageDurations\s*=\s*\[[^\]]/);
  });
});
