/** Editorial Review Engine V2 — types (Phase 6, "professional documentary editor reviewing a
 *  rough cut before it's rendered").
 *
 *  Sits after the Cinematic Editing Engine (Phase 4) and consumes both its EDL output and the
 *  AI Director's (Phase 5) DirectorOutput — reusing both wholesale rather than re-deriving
 *  anything they already computed (see retentionReviewer.ts, which reads
 *  DirectorOutput.retentionRisks/hookGuidance/highlightMoments directly instead of
 *  recomputing them). Every reviewer is a pure function over already-produced data: no
 *  rendering, no FFmpeg, no media search, no re-scoring candidates — it only reads the plan
 *  and reports on it, exactly like a human editor reviewing an edit decision list on paper.
 *
 *  Reuses DimensionScore from the existing, live, post-render editorialReviewEngine.ts — same
 *  {score, feedback, issue?, suggestion?} shape is exactly what's needed here too; importing
 *  it instead of redefining it is the literal "do not duplicate existing systems" instruction
 *  applied to the one piece of that file that transfers unchanged.
 */
import type { DimensionScore } from "../editorialReviewEngine";
import type { EDL, EditDecision } from "../cinematicEditingEngine/types";
import type { DirectorDecision, DirectorOutput } from "../aiDirector/types";

export type { DimensionScore };

// ─── Input contract ─────────────────────────────────────────────────────────────

export type ReviewInputV2 = {
  videoId: string;
  videoTitle: string;
  /** One EDL per scene, in video order — Phase 4's complete output for this video. */
  edls: EDL[];
  /** Phase 5's complete output for this video — same scene order as `edls`. */
  directorOutput: DirectorOutput;
};

// ─── Quality scoring ────────────────────────────────────────────────────────────

/** The literal Phase 6 "QUALITY SCORING" list. Distinct from (not a rename of) the legacy
 *  post-render EditorialDimension union — that one scores what was actually rendered from
 *  audit logs; this one scores what the plan says will happen, before anything renders. */
export type ReviewDimension =
  | "narrativeClarity"
  | "visualAccuracy"
  | "visualDiversity"
  | "pacing"
  | "emotionalFlow"
  | "viewerRetention"
  | "shotVariety"
  | "transitionQuality"
  | "textUsage"
  | "historicalAccuracy"
  | "contextConsistency"
  | "overallProfessionalQuality";

// ─── Problem detection ────────────────────────────────────────────────────────────

export type ProblemType =
  | "repeated_footage"
  | "repeated_camera_movement"
  | "repeated_transition"
  | "weak_opening"
  | "weak_ending"
  | "long_static_section"
  | "low_visual_variety"
  | "low_emotional_variation"
  | "too_much_text"
  | "too_little_movement"
  | "poor_timing"
  | "off_topic_visual"
  | "visual_continuity_issue";

export type ProblemSeverity = "low" | "medium" | "high";

export type Problem = {
  type: ProblemType;
  severity: ProblemSeverity;
  /** Which scene this problem was found in, when localized. Absent for whole-video problems
   *  (e.g. a single dominant visual style across every scene). */
  sceneIndex?: number;
  beatId?: string;
  description: string;
  /** What data led to this detection — the concrete numbers/text, not just the label, so a
   *  human reviewer can verify the finding without re-deriving it. */
  evidence: string;
};

// ─── Suggested improvements ──────────────────────────────────────────────────────

export type RecommendationPriority = "low" | "medium" | "high";

export type Recommendation = {
  problemType: ProblemType;
  sceneIndex?: number;
  beatId?: string;
  /** Human-readable, matches the Phase 6 spec's own example style — e.g. "Replace Scene 7
   *  with stronger archive footage." */
  recommendation: string;
  priority: RecommendationPriority;
  reason: string;
};

// ─── Auto fixes ───────────────────────────────────────────────────────────────────

/** Only fix types that are mechanically executable against the EDL alone (a field swap) get
 *  generated as AutoFix entries — see autoFixApply.ts. Fixes that require new footage
 *  (swapping in a different candidate, replacing duplicate visuals with fresh material) are
 *  emitted as Recommendations instead, never as AutoFixes: the Review Engine "should NOT
 *  search media," so it cannot itself produce a replacement candidate to swap in. */
export type AutoFixType = "change_shot_type" | "change_camera_movement" | "change_transition" | "reduce_text_duration";

export type AutoFix = {
  type: AutoFixType;
  sceneIndex: number;
  beatId: string;
  description: string;
  /** The exact field this fix changes and its value before/after — mechanical enough that
   *  applyAutoFix()/revertAutoFix() (autoFixApply.ts) can execute and undo it deterministically. */
  field: string;
  before: string | number;
  after: string | number;
  /** Always true — typed as a literal (not a plain boolean) so "every automatic fix must be
   *  reversible" is structurally guaranteed, not just documented. Every AutoFix this engine
   *  generates has a matching revertAutoFix() path, verified by autoFixApply.test.ts. */
  reversible: true;
  reason: string;
};

// ─── Review report ──────────────────────────────────────────────────────────────

export type ApprovalStatus = "approved" | "approved_with_notes" | "needs_revision" | "rejected";

export type ReviewReport = {
  videoId: string;
  videoTitle: string;
  reviewedAt: string;
  scores: Record<ReviewDimension, DimensionScore>;
  overallScore: number;
  problems: Problem[];
  recommendations: Recommendation[];
  autoFixes: AutoFix[];
  approvalStatus: ApprovalStatus;
  /** 0..1 — how confident the review itself is, based on how much data was available (more
   *  scenes/beats analyzed = higher confidence). Not a quality score — a video can score low
   *  with high confidence (clearly bad) or score fine with low confidence (too little data to
   *  be sure). */
  confidenceScore: number;
};

/** What a future renderer (Phase 7+) actually consumes — the EDL plus proof it passed review.
 *  Never produced for a rejected review (see reviewReportGenerator.ts's produceApprovedEDL). */
export type ApprovedEDL = {
  videoId: string;
  edls: EDL[];
  review: ReviewReport;
  approvedAt: string;
};

// ─── Shared helper types reviewers pass around ───────────────────────────────────

/** One beat's decision plus which scene it belongs to and its position within that scene —
 *  most reviewers work over this flattened view rather than the nested EDL[]/decisions[]
 *  shape, since cross-scene analysis (repeated footage, repeated transitions) needs a single
 *  ordered sequence. */
export type FlatBeat = {
  sceneIndex: number;
  beatIndexInScene: number;
  decision: EditDecision;
};

export function flattenEDLs(edls: EDL[]): FlatBeat[] {
  const out: FlatBeat[] = [];
  for (const edl of edls) {
    edl.decisions.forEach((decision, beatIndexInScene) => {
      out.push({ sceneIndex: edl.sceneIndex, beatIndexInScene, decision });
    });
  }
  return out;
}

export type { EDL, EditDecision, DirectorDecision, DirectorOutput };
