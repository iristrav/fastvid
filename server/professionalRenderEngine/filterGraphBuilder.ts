/** Professional Render Engine — Filter Graph Builder (Phase 7).
 *
 *  Low-level FFmpeg `-filter_complex` string assembly, shared by every renderer in this
 *  directory. The drawtext/drawbox/overlay/filter_complex string patterns already exist,
 *  repeated ad hoc across textOverlay/renderer.ts, visualDirector/renderer.ts, and
 *  videoPipeline.ts's montage builders (confirmed by this phase's research pass) — this
 *  module is that shared vocabulary factored into one tested place instead of copy-pasted a
 *  fourth time.
 *
 *  Pure string assembly only: no filter here inspects or validates FFmpeg syntax semantics
 *  (renderValidator.ts owns that); this only joins already-built fragments correctly.
 */
import type { FilterFragment, FilterGraphNode } from "./types";

/** FFmpeg filter_complex labels must be alphanumeric/underscore only. beatId values (e.g.
 *  "s0-b1", "beat.3") aren't guaranteed to satisfy that, so every label this module produces
 *  is derived through this sanitizer rather than beatIds being used raw. */
export function sanitizeLabel(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_]/g, "_");
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

/** The stream label for one beat's processing at a given stage, e.g. labelForBeat("s0-b1",
 *  "clip") -> "clip_s0_b1". Stages stay distinct so the same beat's clip/camera/caption
 *  outputs never collide on one label. */
export function labelForBeat(beatId: string, stage: string): string {
  return `${sanitizeLabel(stage)}_${sanitizeLabel(beatId)}`;
}

/** Joins fragments meant to apply sequentially to ONE stream (e.g. scale,then camera zoompan,
 *  then a caption drawtext) into one comma-separated filter chain — the syntax FFmpeg expects
 *  for a single `-vf`/single filter_complex node with multiple effects. Empty/blank fragments
 *  are skipped so an instruction with no filter to contribute doesn't leave a stray comma. */
export function joinFilterChain(fragments: FilterFragment[]): string {
  return fragments
    .map((f) => f.filter.trim())
    .filter((f) => f.length > 0)
    .join(",");
}

/** Formats one filter_complex graph node: `[in1][in2]filter[output]`. */
export function formatNode(node: FilterGraphNode): string {
  const inputs = node.inputs.map((i) => `[${i}]`).join("");
  return `${inputs}${node.filter}[${node.output}]`;
}

/** Joins multiple graph nodes into one complete `-filter_complex` string, `;`-separated in
 *  the order given — callers are responsible for ordering nodes so every input label a node
 *  references was already produced by an earlier node (or is a raw ffmpeg input like "0:v"). */
export function buildFilterComplex(nodes: FilterGraphNode[]): string {
  return nodes.map(formatNode).join(";");
}

/** Combines the two most common operations for a beat: chain together this beat's filter
 *  fragments (clip scale + camera movement + any per-clip effects) into one filter string,
 *  then wrap it as a graph node reading from `inputs` and writing to `output`. Returns null
 *  (no node) when there's nothing to render — e.g. a beat whose only "filter" is a no-op
 *  camera_hold with an empty fragment list — so callers don't emit a pointless identity node. */
export function buildBeatNode(inputs: string[], fragments: FilterFragment[], output: string): FilterGraphNode | null {
  const filter = joinFilterChain(fragments);
  if (!filter) return null;
  return { inputs, filter, output };
}
