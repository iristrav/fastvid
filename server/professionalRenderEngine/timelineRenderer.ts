/** Professional Render Engine — Timeline Renderer (Phase 7).
 *
 *  Assembles one scene's already-built per-beat filter fragments (clip + camera + captions +
 *  motion graphics + effects — built by clipRenderer.ts/cameraRenderer.ts/captionRenderer.ts/
 *  motionGraphicsRenderer.ts/effectsRenderer.ts, this file makes none of those decisions
 *  itself) into one scene-level `-filter_complex` string, joining consecutive beats with the
 *  transition the EDL already specified for that join.
 *
 *  Reuses transitionRenderer.ts's `isHardCut()`/`renderTransition()` for the join itself, and
 *  the exact same running-duration bookkeeping videoPipeline.ts's montage builder uses:
 *  `prevDur = prevDur + nextBeatDur - transitionDur` for a crossfaded join (the overlap
 *  shortens the combined timeline), or `prevDur = prevDur + nextBeatDur` for a hard cut (no
 *  overlap to subtract) — confirmed by this phase's research to be the real production
 *  formula, not a new one invented here.
 *
 *  A hard cut (`cut`/`match_cut`) joins with a plain `concat=n=2:v=1:a=0` node — the identical
 *  fallback the real montage builder takes whenever a transition's duration is ~0.
 */
import { buildBeatNode, buildFilterComplex, labelForBeat } from "./filterGraphBuilder";
import { isHardCut, renderTransition } from "./transitionRenderer";
import type { FilterFragment, FilterGraphNode, TransitionInstruction } from "./types";

export type BeatRenderInput = {
  beatId: string;
  /** The raw FFmpeg input stream label for this beat's own clip (e.g. "0:v"), before any of
   *  this scene's own filters are applied. */
  inputLabel: string;
  /** This beat's already-built clip/camera/caption/motion-graphic/effect fragments, in the
   *  order they should be chained (clip prep first, then camera, then overlays). */
  fragments: FilterFragment[];
  /** This beat's on-timeline duration in seconds. */
  durationSec: number;
  /** The transition INTO this beat from the previous one. Ignored for the scene's first beat
   *  (nothing precedes it to transition from). */
  transitionIn: TransitionInstruction;
};

export type SceneTimelineResult = {
  filterComplex: string;
  outputLabel: string;
  totalDurationSec: number;
};

function joinNode(prevOutput: string, currOutput: string, output: string): FilterGraphNode {
  return { inputs: [prevOutput, currOutput], filter: "concat=n=2:v=1:a=0", output };
}

/** Builds one scene's full filter_complex: each beat's own fragments chained into a per-beat
 *  node, then those nodes joined pairwise via the transition the EDL specified for each join. */
export function assembleSceneTimeline(sceneIndex: number, beats: BeatRenderInput[]): SceneTimelineResult {
  if (beats.length === 0) {
    return { filterComplex: "", outputLabel: "", totalDurationSec: 0 };
  }

  const nodes: FilterGraphNode[] = [];

  const prepOutputs: string[] = beats.map((beat) => {
    const output = labelForBeat(beat.beatId, `s${sceneIndex}_prep`);
    const node = buildBeatNode([beat.inputLabel], beat.fragments, output);
    if (node) {
      nodes.push(node);
      return output;
    }
    // No fragments to apply (e.g. a static camera_hold clip with no captions/effects) — pass
    // the raw input straight through rather than emitting a pointless identity node.
    return beat.inputLabel;
  });

  let prevOutput = prepOutputs[0]!;
  let prevDurationSec = beats[0]!.durationSec;

  for (let i = 1; i < beats.length; i++) {
    const beat = beats[i]!;
    const currOutput = prepOutputs[i]!;
    const isLast = i === beats.length - 1;
    const joinedLabel = isLast ? labelForBeat(`s${sceneIndex}`, "scene_out") : `s${sceneIndex}_join${i}`;
    const transition = beat.transitionIn;

    if (isHardCut(transition.type)) {
      nodes.push(joinNode(prevOutput, currOutput, joinedLabel));
      prevDurationSec = prevDurationSec + beat.durationSec;
    } else {
      const node = renderTransition(transition, [prevOutput, currOutput], prevDurationSec, joinedLabel);
      if (node) {
        nodes.push(node);
        prevDurationSec = prevDurationSec + beat.durationSec - transition.durationSec;
      } else {
        nodes.push(joinNode(prevOutput, currOutput, joinedLabel));
        prevDurationSec = prevDurationSec + beat.durationSec;
      }
    }

    prevOutput = joinedLabel;
  }

  return {
    filterComplex: buildFilterComplex(nodes),
    outputLabel: prevOutput,
    totalDurationSec: prevDurationSec,
  };
}
