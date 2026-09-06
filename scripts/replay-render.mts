/**
 * Replay a recorded render against the current code.
 *
 * Usage:
 *   npx tsx scripts/replay-render.mts <bundle.jsonl>
 *
 * Needs no database, no provider keys, no network and no ffmpeg — a bundle is self-contained. It
 * exits 1 when a previously adopted clip would now be refused, so a replay can guard a change in
 * CI the same way a test does.
 */
import { loadReplayBundle } from "../server/renderReplay";
import { formatReplayReport, replayBundle } from "../server/renderReplayEngine";

const file = process.argv[2];
if (!file) {
  console.error("usage: npx tsx scripts/replay-render.mts <bundle.jsonl>");
  process.exit(2);
}

const { bundle, skipped } = loadReplayBundle(file);
if (skipped > 0) {
  console.warn(`[Replay] ${skipped} unreadable line(s) skipped — bundle from an interrupted render?`);
}
if (bundle.adoptions.length === 0) {
  console.error(
    "[Replay] this bundle records no adoption decisions. Either the render never reached the " +
      "adoption stage, or it ran without RENDER_REPLAY_RECORD=true."
  );
  process.exit(2);
}

const result = replayBundle(bundle);
console.log(formatReplayReport(bundle, result));

if (result.lost.length > 0) {
  console.error(`[Replay] FAIL — ${result.lost.length} adoption(s) regressed.`);
  process.exit(1);
}
process.exit(0);
