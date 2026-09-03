/**
 * A GENERIC FILLER MAY NOT QUIETLY TAKE AN ADOPTED ASSET'S BEAT.
 *
 * ── The state this makes impossible to reach unreported ─────────────────────────────────────
 *
 *     an ADOPTED real asset  +  the same beat  +  a guaranteed filler  +  no ending on the asset
 *
 * VID-0567's beat 0 was exactly that: a YouTube clip found, downloaded, judged `fits`, selected,
 * transformed and ADOPTED, a beat filled with `scene_0_slot100_guaranteed.mp4`, and nothing on the
 * ledger saying what became of the clip.
 *
 * The mechanism is that adoption and ACCEPTANCE are separate events in that order. The funnel
 * records ADOPTED when it picks a winner (videoPipeline ~33405) and sets `funnelClip`; the clip
 * only becomes the beat's clip when `pushSceneClip` returns true — the sole writer of
 * `clipBeatIndices` — and every caller discards that boolean. A refusal therefore left the asset
 * adopted, the beat empty, and `rescueBeatVisualWhenEmptyInner` free to fill it.
 *
 * ── What is asserted here ───────────────────────────────────────────────────────────────────
 *
 * That the render now catches the state, and — just as important — that it stays quiet for every
 * legitimate one. An invariant that fires on healthy renders is noise, and noise is how a real
 * finding gets scrolled past.
 *
 * The check REPORTS; it does not reinstate the clip. A barrier that judged this footage wrong for
 * this narration made an editorial decision, and overriding it to avoid a placeholder would turn a
 * blocking problem into a non-blocking one.
 */
import { describe, expect, it } from "vitest";

import { VisualSourceLedger, formatFillerOverAdoptedAsset } from "./visualSourceLineage";

const YT = "d5d161a4db2fca58";
const RAW = `/w/scene_0_ytcc_0__pid_youtube_cc-${YT}.mp4`;
const TRANSFORMED = `/w/scene_0_ytcc_0__pid_youtube_cc-${YT}_transformed.mp4`;

/** Render 567's shape: adopted on the transformed child, identity on the root. */
function adoptedYoutubeOnBeat0() {
  const ledger = new VisualSourceLedger({ renderId: "r1", videoId: 567 });
  const root = ledger.createLineage({
    sceneIndex: 0,
    beatIndex: 0,
    candidateId: `youtube_cc:${YT}`,
    contentKey: `youtube_cc:${YT}`,
    provider: "youtube_cc",
    providerAssetId: YT,
    localPath: RAW,
    mediaType: "video",
    route: "primary",
  });
  ledger.recordEvent(root.lineageId, "SELECTED", { status: "OK" });
  const child = ledger.linkDerivedPath(TRANSFORMED, RAW, "TRANSFORMED")!;
  ledger.recordEvent(child.lineageId, "ADOPTED", { status: "OK", currentPath: TRANSFORMED });
  return { ledger, root, child };
}

const beat0 = new Set(["0:0"]);

describe("the invariant fires on the state that produced VID-0567", () => {
  it("names the adopted asset whose beat a filler took", () => {
    const { ledger, root } = adoptedYoutubeOnBeat0();
    const lines = formatFillerOverAdoptedAsset(ledger.allRecords(), ledger.allEvents(), beat0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("INVARIANT_BROKEN");
    expect(lines[0]).toContain(`assetId=${root.lineageId}`);
  });

  /** By canonical identity, never by a path or a position. */
  it("reports the provider and its asset id", () => {
    const { ledger } = adoptedYoutubeOnBeat0();
    const [line] = formatFillerOverAdoptedAsset(ledger.allRecords(), ledger.allEvents(), beat0);
    expect(line).toContain("provider=youtube_cc");
    expect(line).toContain(`providerAssetId=${YT}`);
    expect(line).toContain("scene=0 beat=0");
  });

  /**
   * Adoption lands on the derived child while identity lives on the root. Folding first is what
   * lets the line name a provider at all — the child alone would report the beat and little else.
   */
  it("folds the transform chain onto its root", () => {
    const { ledger, root, child } = adoptedYoutubeOnBeat0();
    const lines = formatFillerOverAdoptedAsset(ledger.allRecords(), ledger.allEvents(), beat0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`assetId=${root.lineageId}`);
    expect(lines[0]).not.toContain(`assetId=${child.lineageId}`);
  });
});

describe("it stays quiet on every legitimate render", () => {
  /** The asset is in the film under its derived name — nothing was taken from it. */
  it("silent when the asset reached the final video", () => {
    const { ledger, child } = adoptedYoutubeOnBeat0();
    ledger.recordEvent(child.lineageId, "FINAL_VIDEO", { status: "OK" });
    expect(formatFillerOverAdoptedAsset(ledger.allRecords(), ledger.allEvents(), beat0)).toHaveLength(0);
  });

  /** The push refused it and said so — explained, so not an invariant breach. */
  it("silent when the refusal was recorded", () => {
    const { ledger } = adoptedYoutubeOnBeat0();
    ledger.recordRejection(TRANSFORMED, "off_subject", `youtube_cc:${YT}`);
    expect(formatFillerOverAdoptedAsset(ledger.allRecords(), ledger.allEvents(), beat0)).toHaveLength(0);
  });

  /** A later pass swapped it deliberately, with a reason. */
  it("silent when an explicit REPLACED explains it", () => {
    const { ledger, child } = adoptedYoutubeOnBeat0();
    ledger.recordEvent(child.lineageId, "REPLACED", {
      status: "REPLACED",
      reason: "scene_resourced:scene_0_resourced",
    });
    expect(formatFillerOverAdoptedAsset(ledger.allRecords(), ledger.allEvents(), beat0)).toHaveLength(0);
  });

  /** A filler on a DIFFERENT beat says nothing about this asset. */
  it("silent when the filler landed on another beat", () => {
    const { ledger } = adoptedYoutubeOnBeat0();
    const elsewhere = new Set(["0:3", "1:0"]);
    expect(formatFillerOverAdoptedAsset(ledger.allRecords(), ledger.allEvents(), elsewhere)).toHaveLength(0);
  });

  /** No filler anywhere: nothing to answer for. */
  it("silent when no beat was filled", () => {
    const { ledger } = adoptedYoutubeOnBeat0();
    expect(formatFillerOverAdoptedAsset(ledger.allRecords(), ledger.allEvents(), new Set())).toHaveLength(0);
  });

  /** An asset that was never adopted cannot have had its beat taken. */
  it("silent for a candidate that was only ever found", () => {
    const ledger = new VisualSourceLedger({ renderId: "r2" });
    ledger.createLineage({
      sceneIndex: 0,
      beatIndex: 0,
      candidateId: "pexels:1",
      contentKey: "pexels:1",
      provider: "pexels",
      providerAssetId: "1",
      localPath: "/w/p.mp4",
      mediaType: "video",
      route: "primary",
    });
    expect(formatFillerOverAdoptedAsset(ledger.allRecords(), ledger.allEvents(), beat0)).toHaveLength(0);
  });

  /** A download that never finished is an ending, the same one the vanished rule accepts. */
  it("silent when the download failed and nothing later succeeded", () => {
    const { ledger, child } = adoptedYoutubeOnBeat0();
    ledger.recordEvent(child.lineageId, "DOWNLOAD_FAILED", { status: "FAILED" });
    expect(formatFillerOverAdoptedAsset(ledger.allRecords(), ledger.allEvents(), beat0)).toHaveLength(0);
  });
});

describe("it separates assets that merely share a beat", () => {
  it("reports each unexplained adopted asset once", () => {
    const { ledger } = adoptedYoutubeOnBeat0();
    const other = ledger.createLineage({
      sceneIndex: 0,
      beatIndex: 0,
      candidateId: "wikimedia:File_X",
      contentKey: "wikimedia:File_X",
      provider: "wikimedia",
      providerAssetId: "File:X",
      localPath: "/w/wiki.mp4",
      mediaType: "image",
      route: "primary",
    });
    ledger.recordEvent(other.lineageId, "ADOPTED", { status: "OK", currentPath: "/w/wiki.mp4" });
    const lines = formatFillerOverAdoptedAsset(ledger.allRecords(), ledger.allEvents(), beat0);
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).toContain("provider=youtube_cc");
    expect(lines.join("\n")).toContain("provider=wikimedia");
  });

  /** Explaining one does not silence the other. */
  it("keeps reporting the unexplained one when its neighbour is resolved", () => {
    const { ledger } = adoptedYoutubeOnBeat0();
    const other = ledger.createLineage({
      sceneIndex: 0,
      beatIndex: 0,
      candidateId: "wikimedia:File_X",
      contentKey: "wikimedia:File_X",
      provider: "wikimedia",
      providerAssetId: "File:X",
      localPath: "/w/wiki.mp4",
      mediaType: "image",
      route: "primary",
    });
    ledger.recordEvent(other.lineageId, "ADOPTED", { status: "OK", currentPath: "/w/wiki.mp4" });
    ledger.recordEvent(other.lineageId, "FINAL_VIDEO", { status: "OK" });
    const lines = formatFillerOverAdoptedAsset(ledger.allRecords(), ledger.allEvents(), beat0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("provider=youtube_cc");
  });
});
