/** Professional Render Engine — Render Validator (Phase 7).
 *
 *  Implements the seven pre-export checks the spec calls for verbatim: no missing clips, no
 *  overlapping edits, no invalid timestamps, no broken transitions, no invalid filters, no
 *  audio desync, no missing captions.
 *
 *  Split into two passes because the checks genuinely need different inputs: the first four
 *  are inspectable straight from the Approved EDL (before any rendering happens at all); the
 *  last three (invalid filters, audio desync, missing captions) can only be checked once a
 *  RenderPlan exists, since they're about whether the render plan faithfully represents what
 *  the EDL asked for. This module makes no creative or corrective decisions — it only reports
 *  ValidationIssues; renderPlanner.ts (task #117) decides what to do about them.
 */
import type {
  ApprovedEDL,
  EDL,
  EditDecision,
  RenderPlan,
  ValidationIssue,
  ValidationResult,
} from "./types";

function issue(
  type: ValidationIssue["type"],
  severity: ValidationIssue["severity"],
  description: string,
  sceneIndex?: number,
  beatId?: string
): ValidationIssue {
  return { type, severity, description, sceneIndex, beatId };
}

function toResult(issues: ValidationIssue[]): ValidationResult {
  return { isValid: !issues.some((i) => i.severity === "error"), issues };
}

const OVERLAP_TOLERANCE_SEC = 0.05;

function validateDecision(decision: EditDecision, sceneIndex: number, issues: ValidationIssue[]): void {
  const { clip, transitionIn, captions, beatId } = decision;

  // No missing clips.
  if (!clip.localPath && !clip.remoteUrl) {
    issues.push(issue("missing_clip", "error", `Beat ${beatId} has no localPath or remoteUrl`, sceneIndex, beatId));
  }

  // No invalid timestamps.
  if (clip.startSec < 0 || clip.endSec <= clip.startSec) {
    issues.push(
      issue(
        "invalid_timestamp",
        "error",
        `Beat ${beatId} has an invalid timeline span (startSec=${clip.startSec}, endSec=${clip.endSec})`,
        sceneIndex,
        beatId
      )
    );
  }
  if (clip.assetType === "video" && clip.trimStartSec < 0) {
    issues.push(
      issue("invalid_timestamp", "error", `Beat ${beatId} has a negative trimStartSec`, sceneIndex, beatId)
    );
  }
  if (clip.assetType === "video" && clip.trimEndSec <= clip.trimStartSec) {
    issues.push(
      issue(
        "invalid_timestamp",
        "error",
        `Beat ${beatId} trims to an empty or negative source span (trimStartSec=${clip.trimStartSec}, trimEndSec=${clip.trimEndSec})`,
        sceneIndex,
        beatId
      )
    );
  }

  // No broken transitions.
  if (transitionIn.durationSec < 0) {
    issues.push(
      issue("broken_transition", "error", `Beat ${beatId}'s incoming transition has a negative duration`, sceneIndex, beatId)
    );
  }
  const beatDurationSec = clip.endSec - clip.startSec;
  if (transitionIn.durationSec > beatDurationSec && beatDurationSec > 0) {
    issues.push(
      issue(
        "broken_transition",
        "warning",
        `Beat ${beatId}'s incoming transition (${transitionIn.durationSec}s) is longer than the beat itself (${beatDurationSec}s)`,
        sceneIndex,
        beatId
      )
    );
  }

  // No missing captions — a caption instruction with empty text is treated as broken, not
  // just an empty-content edge case, since it always renders as blank text on screen.
  for (const caption of captions) {
    if (!caption.text || caption.text.trim().length === 0) {
      issues.push(
        issue("missing_caption", "error", `Beat ${beatId} has a ${caption.captionType} caption with empty text`, sceneIndex, beatId)
      );
    }
  }
}

function validateOverlaps(edl: EDL, issues: ValidationIssue[]): void {
  const sorted = [...edl.decisions].sort((a, b) => a.clip.startSec - b.clip.startSec);
  for (let i = 0; i < sorted.length - 1; i++) {
    const curr = sorted[i]!;
    const next = sorted[i + 1]!;
    const overlap = curr.clip.endSec - next.clip.startSec;
    const allowedOverlap = next.transitionIn.durationSec + OVERLAP_TOLERANCE_SEC;
    if (overlap > allowedOverlap) {
      issues.push(
        issue(
          "overlapping_edit",
          "error",
          `Beat ${curr.beatId} (ends ${curr.clip.endSec}s) overlaps beat ${next.beatId} (starts ${next.clip.startSec}s) by more than its transition duration allows`,
          edl.sceneIndex,
          next.beatId
        )
      );
    }
  }
}

/** Checks the four structural properties inspectable directly from the Approved EDL, before
 *  any render planning happens. */
export function validateEDL(approvedEdl: ApprovedEDL): ValidationResult {
  const issues: ValidationIssue[] = [];
  for (const edl of approvedEdl.edls) {
    for (const decision of edl.decisions) {
      validateDecision(decision, edl.sceneIndex, issues);
    }
    validateOverlaps(edl, issues);
  }
  return toResult(issues);
}

/** Counts unbalanced `[`/`]` or unterminated `'`-quoted segments — a cheap, real sanity check
 *  that catches a malformed filter_complex string (a mismatched bracket or quote will always
 *  make FFmpeg reject the whole graph) without needing to actually run FFmpeg. It's a syntax
 *  smoke test, not a semantic one — it can't catch a well-formed filter with wrong parameters. */
function hasUnbalancedSyntax(filterComplex: string): boolean {
  let depth = 0;
  let inQuote = false;
  for (let i = 0; i < filterComplex.length; i++) {
    const ch = filterComplex[i];
    if (ch === "'" && filterComplex[i - 1] !== "\\") inQuote = !inQuote;
    if (inQuote) continue;
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (depth < 0) return true;
  }
  return depth !== 0 || inQuote;
}

/** Checks the three properties that only exist once a RenderPlan has been built from the EDL:
 *  filter syntax sanity, every EDL caption having a matching caption RenderStep, and every
 *  scene with audio content actually producing an audio filter graph. */
export function validateRenderPlan(approvedEdl: ApprovedEDL, plan: RenderPlan): ValidationResult {
  const issues: ValidationIssue[] = [];
  const planScenes = new Map(plan.scenes.map((s) => [s.sceneIndex, s]));

  for (const edl of approvedEdl.edls) {
    const scenePlan = planScenes.get(edl.sceneIndex);
    if (!scenePlan) {
      issues.push(
        issue("invalid_filter", "error", `No RenderPlan entry for scene ${edl.sceneIndex}`, edl.sceneIndex)
      );
      continue;
    }

    if (hasUnbalancedSyntax(scenePlan.filterComplex)) {
      issues.push(
        issue("invalid_filter", "error", `Scene ${edl.sceneIndex}'s filterComplex has unbalanced brackets or quotes`, edl.sceneIndex)
      );
    }
    if (hasUnbalancedSyntax(scenePlan.audioFilterComplex)) {
      issues.push(
        issue("invalid_filter", "error", `Scene ${edl.sceneIndex}'s audioFilterComplex has unbalanced brackets or quotes`, edl.sceneIndex)
      );
    }

    const expectedCaptionBeatIds = new Set(
      edl.decisions.filter((d) => d.captions.length > 0).map((d) => d.beatId)
    );
    const renderedCaptionBeatIds = new Set(
      scenePlan.steps.filter((s) => s.stepType === "caption").map((s) => s.beatId)
    );
    for (const beatId of expectedCaptionBeatIds) {
      if (!renderedCaptionBeatIds.has(beatId)) {
        issues.push(
          issue("missing_caption", "error", `Beat ${beatId} has caption instructions in the EDL but no caption RenderStep in the plan`, edl.sceneIndex, beatId)
        );
      }
    }

    const hasSoundInEdl = edl.decisions.some((d) => d.sounds.length > 0);
    if (hasSoundInEdl && scenePlan.audioFilterComplex.trim().length === 0) {
      issues.push(
        issue("audio_desync", "warning", `Scene ${edl.sceneIndex} has sound instructions in the EDL but an empty audioFilterComplex`, edl.sceneIndex)
      );
    }
  }

  return toResult(issues);
}

/** Merges an EDL-level and a RenderPlan-level result into one — the shape renderPlanner.ts's
 *  caller ultimately needs before exporting. */
export function mergeValidationResults(a: ValidationResult, b: ValidationResult): ValidationResult {
  const issues = [...a.issues, ...b.issues];
  return toResult(issues);
}
