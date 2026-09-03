/**
 * ONE PHYSICAL ASSET HAS ONE LIFECYCLE, ACROSS EVERY FILE THE PIPELINE DERIVED FROM IT.
 *
 * ── The two lines render 567 printed about one clip ─────────────────────────────────────────
 *
 *     [AssetNotRendered] assetId=…#18 provider=youtube_cc scene=0 beat=0
 *                        reachedSelected=true  reachedAssigned=false DROPPED_WITHOUT_EVENT
 *     [AssetNotRendered] assetId=…#30 provider=youtube_cc scene=0 beat=0
 *                        reachedSelected=false reachedAssigned=true  DROPPED_WITHOUT_EVENT
 *
 * Same scene, same beat, same provider, same file — `scene_0_ytcc_0__pid_youtube_cc-…_transformed.mp4`
 * — and exactly mirrored lifecycles. Read as two assets, it says two YouTube clips each lost half
 * their history. It is one clip, and the mirror is the tell.
 *
 * `adoptClip` fair-use-transforms a YouTube clip and `linkDerivedPath` opens a CHILD record for the
 * transformed file. That is deliberate: it is how provenance survives a rename, and the child
 * inherits the parent's provider identity as proof rather than inference. ADOPTED lands on the
 * child; SELECTED had already landed on the parent. `formatSelectedButNotRendered` then walked the
 * records flat and reported both halves as incomplete.
 *
 * ── What this file pins ─────────────────────────────────────────────────────────────────────
 *
 * That the report folds a derivation chain onto its root, and that folding hides nothing: an asset
 * genuinely left out still produces exactly one line, and one that reached the film under a derived
 * name produces none — because it is in the film.
 */
import { describe, expect, it } from "vitest";

import { VisualSourceLedger, formatSelectedButNotRendered } from "./visualSourceLineage";

const YT_ID = "d5d161a4db2fca58";
const RAW = `/w/scene_0_ytcc_0__pid_youtube_cc-${YT_ID}.mp4`;
const TRANSFORMED = `/w/scene_0_ytcc_0__pid_youtube_cc-${YT_ID}_transformed.mp4`;

/** Render 567's exact shape: selected on the parent, adopted on the transformed child. */
function ledgerWithTransformedYoutubeClip() {
  const ledger = new VisualSourceLedger({ renderId: "r1", videoId: 567 });
  const parent = ledger.createLineage({
    sceneIndex: 0,
    beatIndex: 0,
    candidateId: `youtube_cc:${YT_ID}`,
    contentKey: `youtube_cc:${YT_ID}`,
    provider: "youtube_cc",
    providerAssetId: YT_ID,
    localPath: RAW,
    mediaType: "video",
    route: "primary",
  });
  ledger.recordEvent(parent.lineageId, "SELECTED", { status: "OK", currentPath: RAW });
  const child = ledger.linkDerivedPath(TRANSFORMED, RAW, "TRANSFORMED");
  expect(child, "the transform did not produce a derived record").not.toBeNull();
  ledger.recordEvent(child!.lineageId, "ADOPTED", { status: "OK", currentPath: TRANSFORMED });
  return { ledger, parent, child: child! };
}

describe("a transformed clip is not a second asset", () => {
  it("reports one line, not a mirrored pair", () => {
    const { ledger } = ledgerWithTransformedYoutubeClip();
    const lines = formatSelectedButNotRendered(ledger.allRecords(), ledger.allEvents(), true);
    expect(lines).toHaveLength(1);
  });

  it("the single line says the asset was both selected and adopted", () => {
    const { ledger } = ledgerWithTransformedYoutubeClip();
    const [line] = formatSelectedButNotRendered(ledger.allRecords(), ledger.allEvents(), true);
    expect(line).toContain("reachedSelected=true");
    expect(line).toContain("reachedAssigned=true");
    // The half-lives that made one clip look like two must not come back.
    expect(line).not.toContain("reachedSelected=false");
    expect(line).not.toContain("reachedAssigned=false");
  });

  it("keeps the provider and the beat the reader needs to act", () => {
    const { ledger } = ledgerWithTransformedYoutubeClip();
    const [line] = formatSelectedButNotRendered(ledger.allRecords(), ledger.allEvents(), true);
    expect(line).toContain("provider=youtube_cc");
    expect(line).toContain("scene=0 beat=0");
  });

  it("names the derived record, so every event stays reachable", () => {
    const { ledger, child } = ledgerWithTransformedYoutubeClip();
    const [line] = formatSelectedButNotRendered(ledger.allRecords(), ledger.allEvents(), true);
    expect(line).toContain(`derivedIds=${child.lineageId}`);
  });
});

describe("folding hides nothing", () => {
  /** The whole point: a clip that IS in the film must not be reported as lost. */
  it("is silent when the derived file reached the final video", () => {
    const { ledger, child } = ledgerWithTransformedYoutubeClip();
    ledger.recordEvent(child.lineageId, "FINAL_VIDEO", { status: "OK", currentPath: TRANSFORMED });
    expect(formatSelectedButNotRendered(ledger.allRecords(), ledger.allEvents(), true)).toHaveLength(0);
  });

  /** And an asset genuinely left out is still reported — once, with its verdict. */
  it("still reports a genuinely dropped asset", () => {
    const { ledger } = ledgerWithTransformedYoutubeClip();
    const [line] = formatSelectedButNotRendered(ledger.allRecords(), ledger.allEvents(), true);
    expect(line).toContain("DROPPED_WITHOUT_EVENT");
  });

  /** A REPLACED event anywhere on the chain explains the whole chain. */
  it("carries a replacement reason recorded against the derived file", () => {
    const { ledger, child } = ledgerWithTransformedYoutubeClip();
    ledger.recordEvent(child.lineageId, "REPLACED", {
      status: "REPLACED",
      reason: "scene_resourced:scene_0_resourced",
    });
    const [line] = formatSelectedButNotRendered(ledger.allRecords(), ledger.allEvents(), true);
    expect(line).toContain("outcome=REPLACED");
    expect(line).toContain("reason=scene_resourced:scene_0_resourced");
    expect(line).not.toContain("DROPPED_WITHOUT_EVENT");
  });

  /** Two genuinely different assets stay two lines — the fold is by derivation, not by beat. */
  it("does not merge unrelated assets that share a beat", () => {
    const { ledger } = ledgerWithTransformedYoutubeClip();
    const other = ledger.createLineage({
      sceneIndex: 0,
      beatIndex: 0,
      candidateId: "wikimedia:File_X",
      contentKey: "wikimedia:File_X",
      provider: "wikimedia",
      providerAssetId: "File:X",
      localPath: "/w/scene_0_b0_pool_wikimedia_File_X.mp4",
      mediaType: "image",
      route: "primary",
    });
    ledger.recordEvent(other.lineageId, "SELECTED", { status: "OK" });
    const lines = formatSelectedButNotRendered(ledger.allRecords(), ledger.allEvents(), true);
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).toContain("provider=wikimedia");
    expect(lines.join("\n")).toContain("provider=youtube_cc");
  });

  /** A record nothing ever chose is not an incident and must stay out of the report. */
  it("ignores an asset that was never selected or adopted", () => {
    const ledger = new VisualSourceLedger({ renderId: "r2" });
    ledger.createLineage({
      sceneIndex: 1,
      beatIndex: 1,
      candidateId: "pexels:1",
      contentKey: "pexels:1",
      provider: "pexels",
      providerAssetId: "1",
      localPath: "/w/a.mp4",
      mediaType: "video",
      route: "primary",
    });
    expect(formatSelectedButNotRendered(ledger.allRecords(), ledger.allEvents(), true)).toHaveLength(0);
  });

  /** Nothing is claimed about a render whose final video was never verified. */
  it("says nothing when the final video was not verified", () => {
    const { ledger } = ledgerWithTransformedYoutubeClip();
    expect(formatSelectedButNotRendered(ledger.allRecords(), ledger.allEvents(), false)).toHaveLength(0);
  });
});

describe("a chain longer than one hop still folds", () => {
  /** transform → pad → overlay is the real compose path, and it is one asset throughout. */
  it("folds transform → pad → overlay onto the root", () => {
    const { ledger, parent } = ledgerWithTransformedYoutubeClip();
    const padded = ledger.linkDerivedPath("/w/pad_combined_s0b0_1.mp4", TRANSFORMED, "PADDED");
    expect(padded).not.toBeNull();
    const overlaid = ledger.linkDerivedPath("/w/ov_s0b0_1.mp4", "/w/pad_combined_s0b0_1.mp4", "OVERLAYED");
    expect(overlaid).not.toBeNull();
    const lines = formatSelectedButNotRendered(ledger.allRecords(), ledger.allEvents(), true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`assetId=${parent.lineageId}`);
    expect(lines[0]).toContain("provider=youtube_cc");
  });

  /** And the whole chain goes silent when its last file is in the film. */
  it("is silent when the last file in the chain reached the video", () => {
    const { ledger } = ledgerWithTransformedYoutubeClip();
    ledger.linkDerivedPath("/w/pad_combined_s0b0_1.mp4", TRANSFORMED, "PADDED");
    const last = ledger.resolve("/w/pad_combined_s0b0_1.mp4");
    ledger.recordEvent(last!.lineageId, "FINAL_VIDEO", { status: "OK" });
    expect(formatSelectedButNotRendered(ledger.allRecords(), ledger.allEvents(), true)).toHaveLength(0);
  });
});
