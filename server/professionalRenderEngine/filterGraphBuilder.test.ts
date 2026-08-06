import { describe, expect, it } from "vitest";
import { buildBeatNode, buildFilterComplex, formatNode, joinFilterChain, labelForBeat, sanitizeLabel } from "./filterGraphBuilder";

describe("Filter Graph Builder (Phase 7)", () => {
  it("sanitizeLabel strips non-alphanumeric characters and prefixes a leading digit", () => {
    expect(sanitizeLabel("s0-b1.mp4")).toBe("s0_b1_mp4");
    expect(sanitizeLabel("3clips")).toBe("_3clips");
    expect(sanitizeLabel("clean_label")).toBe("clean_label");
  });

  it("labelForBeat produces a distinct, deterministic label per stage", () => {
    expect(labelForBeat("s0-b1", "clip")).toBe("clip_s0_b1");
    expect(labelForBeat("s0-b1", "camera")).toBe("camera_s0_b1");
    expect(labelForBeat("s0-b1", "clip")).toBe(labelForBeat("s0-b1", "clip"));
  });

  it("joinFilterChain comma-joins filter fragments and skips blank ones", () => {
    const result = joinFilterChain([
      { filter: "scale=1920:1080", reason: "test" },
      { filter: "", reason: "no-op" },
      { filter: "zoompan=z=1.04", reason: "test" },
    ]);
    expect(result).toBe("scale=1920:1080,zoompan=z=1.04");
  });

  it("joinFilterChain returns an empty string for no fragments", () => {
    expect(joinFilterChain([])).toBe("");
  });

  it("formatNode produces valid FFmpeg [in]filter[out] syntax", () => {
    const node = formatNode({ inputs: ["0:v"], filter: "scale=1920:1080", output: "v0" });
    expect(node).toBe("[0:v]scale=1920:1080[v0]");
  });

  it("formatNode supports multiple inputs (e.g. xfade)", () => {
    const node = formatNode({ inputs: ["v0", "v1"], filter: "xfade=transition=dissolve:duration=0.5:offset=3", output: "v01" });
    expect(node).toBe("[v0][v1]xfade=transition=dissolve:duration=0.5:offset=3[v01]");
  });

  it("buildFilterComplex joins multiple nodes with semicolons in order", () => {
    const result = buildFilterComplex([
      { inputs: ["0:v"], filter: "scale=1920:1080", output: "v0" },
      { inputs: ["v0"], filter: "zoompan=z=1.04", output: "v1" },
    ]);
    expect(result).toBe("[0:v]scale=1920:1080[v0];[v0]zoompan=z=1.04[v1]");
  });

  it("buildBeatNode returns null when there are no filter fragments (no pointless identity node)", () => {
    expect(buildBeatNode(["0:v"], [], "out")).toBeNull();
  });

  it("buildBeatNode builds a real node when fragments exist", () => {
    const node = buildBeatNode(["0:v"], [{ filter: "scale=1920:1080", reason: "test" }], "out");
    expect(node).toEqual({ inputs: ["0:v"], filter: "scale=1920:1080", output: "out" });
  });
});
