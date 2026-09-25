/**
 * RONDE 654 — PROVE, ON THE DELIVERED FILE, THAT EVERY CHANGE OF PICTURE IS ONE OF OUR OWN CUTS.
 *
 * The planner keeps each YouTube piece inside one shot of its source; this is the check that it
 * worked. The delivered MP4 is scanned for hard cuts and for gradual transitions, and every change
 * found is compared with the timeline's own edit points (every clip boundary, widened by the
 * transition planned there). A change that is not near one of them is a transition INSIDE a shot
 * — the one thing the operator asked never to see — and it is logged with its time.
 *
 * Measurement only. It decides nothing and cannot fail a render: a graphic card fading in can read
 * as a soft change, so a finding is a place to look, not a verdict.
 */
import type { ProjectTimeline } from "./projectTimeline";

export type TimelineEditPoint = { at: number; halfWidth: number };

/** Every place the edit itself changes picture: clip boundaries, widened by their transitions. */
export function timelineEditPoints(timeline: ProjectTimeline): TimelineEditPoint[] {
  const track = timeline.tracks.find((t) => t.kind === "VIDEO");
  const clips = track && track.kind === "VIDEO" ? track.clips.filter((c) => !c.disabled) : [];
  const points: TimelineEditPoint[] = [];
  for (const c of clips) {
    points.push({ at: c.timelineStart, halfWidth: Math.max(0, (c.transitionInSec ?? 0) / 2) });
    points.push({ at: c.timelineEnd, halfWidth: Math.max(0, (c.transitionOutSec ?? 0) / 2) });
  }
  return points;
}

/** Pure: the changes that sit near no edit point. */
export function unexpectedSceneChanges(
  changes: readonly number[],
  editPoints: readonly TimelineEditPoint[],
  toleranceSec = 0.3
): number[] {
  return changes.filter((t) => !editPoints.some((p) => Math.abs(t - p.at) <= p.halfWidth + toleranceSec));
}

export function formatCutCheck(p: {
  videoId: number;
  jobId: number;
  changes: number;
  unexpected: readonly number[];
}): string {
  return (
    `[CutCheck] video=${p.videoId} job=${p.jobId} pictureChanges=${p.changes} ` +
    `atOwnCuts=${p.changes - p.unexpected.length} insideAShot=${p.unexpected.length}` +
    (p.unexpected.length
      ? ` at ${p.unexpected.slice(0, 12).map((t) => `${t.toFixed(2)}s`).join(", ")} — check these moments`
      : " — every change of picture is one of the edit's own cuts")
  );
}

export function deliveredCutCheckEnabled(): boolean {
  return process.env.CUT_CHECK !== "off";
}

/** Scan the delivered file. Never throws; null when the scan could not run. */
export async function scanDeliveredCuts(filePath: string, timeline: ProjectTimeline): Promise<{
  changes: number[];
  unexpected: number[];
} | null> {
  try {
    const { detectInteriorCutTimesInFile, probeVideoDurationSec, ffmpegBin } = await import("./archiveVideoSplitter");
    const { detectGradualTransitionsInFile } = await import("./youtubeSoftCuts");
    const dur = await probeVideoDurationSec(filePath);
    if (!(dur > 0)) return null;
    const [hard, soft] = await Promise.all([
      detectInteriorCutTimesInFile(filePath, dur, 60_000),
      detectGradualTransitionsInFile(filePath, { ffmpegBin: ffmpegBin(), timeoutMs: 60_000, durationSec: dur }),
    ]);
    /** A gradual transition is judged by its middle. */
    const changes = [...hard, ...soft.map((w) => (w.start + w.end) / 2)].sort((a, b) => a - b);
    return { changes, unexpected: unexpectedSceneChanges(changes, timelineEditPoints(timeline)) };
  } catch {
    return null;
  }
}
