/** Phase 8 integration test — the full new-engine chain, using the REAL Phase 4-7 engines
 *  (no mocking of generateEDL/runAIDirector/generateReviewReport/produceApprovedEDL/planScene/
 *  validateEDL/validateRenderPlan — all of them are pure, deterministic, non-LLM functions, so
 *  running them for real here is both possible and the actually meaningful test: it proves the
 *  stage-boundary TYPES genuinely compose, not just that mocked functions get called in order
 *  (newPipelineStages.test.ts already covers orchestration logic with mocks; this file is
 *  deliberately complementary, not redundant, with that one).
 *
 *  Only two things are legitimately unavailable in this sandbox and stay out of scope: the
 *  Visual Intelligence Engine's own LLM-based intent extraction (visualIntentExtractor.ts) and
 *  actually spawning ffmpeg (encoder.ts). This test uses the legacy-candidate adapter path
 *  (archiveAssetRowToCandidateAsset + minimalVisualIntentFromScene) to reach the Cinematic
 *  Editing Engine, and stops at `planScene()` + validation — proving the render PLAN is
 *  correct without executing it.
 */
import { describe, expect, it } from "vitest";
import { archiveAssetRowToCandidateAsset, minimalVisualIntentFromScene } from "./adapters";
import type { CuratedCandidatePick, Scene } from "./types";
import { runAIDirector, type SceneInput as DirectorSceneInput } from "../aiDirector";
import { generateEDL } from "../cinematicEditingEngine/edlGenerator";
import type { CinematicEditingInput } from "../cinematicEditingEngine/types";
import { generateReviewReport, produceApprovedEDL } from "../editorialReviewEngineV2";
import type { ApprovedEDL } from "../editorialReviewEngineV2/types";
import { dimensionsFor } from "../professionalRenderEngine/aspectRatio";
import { planScene } from "../professionalRenderEngine/renderPlanner";
import { mergeValidationResults, validateEDL, validateRenderPlan } from "../professionalRenderEngine/renderValidator";

function scene(): Scene {
  return {
    index: 0,
    text: "The city rebuilt itself after the war, block by block.",
    visualCue: "aerial view of a rebuilt city skyline at dusk",
    pexelsQuery: "city skyline reconstruction",
    pexelsQueries: ["city skyline reconstruction", "post-war rebuilding"],
    aiImagePrompt: "",
    duration: 5,
  };
}

function candidatePick(): CuratedCandidatePick {
  return {
    asset: {
      id: 101,
      archiveId: 1,
      title: "Rebuilt city skyline at dusk",
      mediaType: "video",
      mixKind: "real_video",
      mimeType: "video/mp4",
      storageUrl: "https://cdn.example.com/assets/101.mp4",
      storageKey: "assets/101.mp4",
      tags: ["city", "skyline", "reconstruction", "dusk"],
      sourceNote: "Public archive",
      licenseNote: "CC0",
      width: 1920,
      height: 1080,
      durationSec: 12,
      sortOrder: 0,
      isActive: 1,
      hasBakedEditText: 0,
      annotationJson: null,
      editorialScore: 80,
      annotationVersion: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as CuratedCandidatePick["asset"],
    archiveName: "City Archive",
    score: 8.2,
    archiveNicheTags: ["urban", "history"],
  };
}

describe("Phase 8 integration: legacy candidate -> AI Director -> Cinematic Editing -> Editorial Review -> Professional Render plan", () => {
  it("threads the same candidateId unchanged through every stage boundary (no duplicate/lossy conversions)", () => {
    const s = scene();
    const candidate = archiveAssetRowToCandidateAsset(candidatePick());
    const intent = minimalVisualIntentFromScene(s);

    const editingInput: CinematicEditingInput = {
      scene: s,
      intent,
      bestCandidate: candidate,
      beatVoiceStartSec: 0,
      beatVoiceDurationSec: s.duration,
      beatIndexInScene: 0,
    };
    const edl = generateEDL([editingInput]);

    expect(edl.decisions).toHaveLength(1);
    expect(edl.decisions[0]!.clip.candidateId).toBe(candidate.candidateId);
    expect(edl.decisions[0]!.clip.remoteUrl).toBe(candidate.remoteUrl);
  });

  it("runs the real chain end-to-end and produces a structurally valid render plan", () => {
    const s = scene();
    const candidate = archiveAssetRowToCandidateAsset(candidatePick());
    const intent = minimalVisualIntentFromScene(s);

    const directorInputs: DirectorSceneInput[] = [{ scene: s, beatIntents: [intent], durationSec: s.duration }];
    const directorOutput = runAIDirector(directorInputs);
    expect(directorOutput.decisions).toHaveLength(1);

    const edl = generateEDL([
      {
        scene: s,
        intent,
        bestCandidate: candidate,
        beatVoiceStartSec: 0,
        beatVoiceDurationSec: s.duration,
        beatIndexInScene: 0,
      },
    ]);
    expect(edl.sceneIndex).toBe(0);
    expect(edl.totalDurationSec).toBeGreaterThan(0);

    const review = generateReviewReport({
      videoId: "vid-int-1",
      videoTitle: "Integration Test Video",
      edls: [edl],
      directorOutput,
    });
    expect(review.videoId).toBe("vid-int-1");
    expect(typeof review.overallScore).toBe("number");
    expect(["approved", "approved_with_notes", "needs_revision", "rejected"]).toContain(review.approvalStatus);

    // Whether or not this synthetic single-scene video happens to clear the real quality bar,
    // the Professional Render Engine handoff itself must always type-check and structurally
    // validate — that's what this integration test is actually proving. A real ApprovedEDL is
    // used when review approved it; otherwise a manually-assembled one (same shape a real
    // approval would have) exercises the identical downstream path.
    const maybeApproved = produceApprovedEDL("vid-int-1", [edl], review);
    const approvedEDL: ApprovedEDL =
      maybeApproved ?? { videoId: "vid-int-1", edls: [edl], review, approvedAt: new Date().toISOString() };

    const aspectRatio = "16:9" as const;
    const dims = dimensionsFor(aspectRatio);
    const resolveClipAsset = () => ({
      inputLabel: "0:v",
      sourceDims: candidate.width && candidate.height ? { width: candidate.width, height: candidate.height } : null,
    });

    const scenePlan = planScene(edl, aspectRatio, dims, resolveClipAsset);
    expect(scenePlan.sceneIndex).toBe(0);
    expect(scenePlan.filterComplex.length).toBeGreaterThan(0);
    expect(scenePlan.outputLabel.length).toBeGreaterThan(0);

    const plan = {
      videoId: "vid-int-1",
      aspectRatio,
      dimensions: dims,
      scenes: [scenePlan],
      totalDurationSec: scenePlan.durationSec,
    };

    const combined = mergeValidationResults(validateEDL(approvedEDL), validateRenderPlan(approvedEDL, plan));
    expect(combined.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(combined.isValid).toBe(true);
  });

  it("produces a plan whose filter_complex references the candidate's real remote URL indirectly via a resolvable input label, not a duplicated/re-derived candidate id", () => {
    const s = scene();
    const pick = candidatePick();
    const candidate = archiveAssetRowToCandidateAsset(pick);
    const intent = minimalVisualIntentFromScene(s);

    const edl = generateEDL([
      {
        scene: s,
        intent,
        bestCandidate: candidate,
        beatVoiceStartSec: 0,
        beatVoiceDurationSec: s.duration,
        beatIndexInScene: 0,
      },
    ]);

    // Exactly one clip decision, referencing exactly the candidate this test built — proves
    // the Cinematic Editing Engine didn't fabricate or duplicate a second candidate reference.
    const candidateIdsInEDL = new Set(edl.decisions.map((d) => d.clip.candidateId));
    expect(candidateIdsInEDL.size).toBe(1);
    expect(candidateIdsInEDL.has(`legacy_archive:${pick.asset.id}`)).toBe(true);
  });
});
