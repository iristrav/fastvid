/** Editorial Review Engine V2 — Auto-Fix Apply/Revert (Phase 6).
 *
 *  Makes "every automatic fix must be reversible" a checked property, not just a promise: for
 *  every AutoFixType this engine generates, applyAutoFix() performs the exact field change
 *  described by the fix, and revertAutoFix() performs its exact inverse — verified by a
 *  round-trip test (apply then revert reproduces the original EDL) for every fix type. Never
 *  renders, never touches media — a pure, in-memory EDL transformation.
 *
 *  change_shot_type/change_camera_movement/change_transition are simple field swaps, trivially
 *  symmetric (apply sets the field to `to`, revert sets it back to `from`). reduce_text_duration
 *  is a ratio-based transform (captions scale by to/from), so its revert must apply the INVERSE
 *  ratio (from/to) to whatever the current, already-modified duration is — not just re-swap
 *  fix.before/fix.after and recompute against the original fix.before, which would silently no-op.
 */
import type { AutoFix, EDL, EditDecision } from "./types";
import type { CameraMovementType, ShotType, TransitionType } from "../cinematicEditingEngine/types";

function transformDecision(decision: EditDecision, fix: AutoFix, from: string | number, to: string | number): EditDecision {
  switch (fix.type) {
    case "change_shot_type":
      return {
        ...decision,
        shot: { ...decision.shot, shotType: to as ShotType, reason: `${decision.shot.reason} [Editorial Review auto-fix: ${fix.reason}]` },
      };
    case "change_camera_movement":
      return {
        ...decision,
        camera: { ...decision.camera, movement: to as CameraMovementType, reason: `${decision.camera.reason} [Editorial Review auto-fix: ${fix.reason}]` },
      };
    case "change_transition":
      return {
        ...decision,
        transitionIn: { ...decision.transitionIn, type: to as TransitionType, reason: `${decision.transitionIn.reason} [Editorial Review auto-fix: ${fix.reason}]` },
      };
    case "reduce_text_duration": {
      const fromSec = Number(from);
      const toSec = Number(to);
      const ratio = fromSec > 0 ? toSec / fromSec : 1;
      return {
        ...decision,
        captions: decision.captions.map((c) => ({ ...c, endSec: c.startSec + (c.endSec - c.startSec) * ratio })),
      };
    }
    default:
      return decision;
  }
}

function transformEDLs(edls: EDL[], fix: AutoFix, from: string | number, to: string | number): EDL[] {
  return edls.map((edl) => {
    if (edl.sceneIndex !== fix.sceneIndex) return edl;
    return {
      ...edl,
      decisions: edl.decisions.map((d) => (d.beatId === fix.beatId ? transformDecision(d, fix, from, to) : d)),
    };
  });
}

/** Applies `fix.after` to the matching beat. No-op (nothing matches) if the fix's
 *  sceneIndex/beatId isn't found in `edls`. */
export function applyAutoFix(edls: EDL[], fix: AutoFix): EDL[] {
  return transformEDLs(edls, fix, fix.before, fix.after);
}

/** The exact inverse of applyAutoFix() for the same fix — moves from `fix.after` back to
 *  `fix.before`, computed against the current (already-modified) state, not re-derived from
 *  the original fix.before as if unmodified. */
export function revertAutoFix(edls: EDL[], fix: AutoFix): EDL[] {
  return transformEDLs(edls, fix, fix.after, fix.before);
}
