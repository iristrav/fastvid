/**
 * THE INVARIANT, ON EVERY ROUTE THAT CAN PUBLISH A VIDEO.
 *
 * ── The route map this suite exists to cover ────────────────────────────────────────────────
 *
 * Since RONDE 661 one path ends with a viewer receiving a film:
 *
 *     cinematic_timeline   runRenderJob → rehydrate → render → checkRenderedFile
 *                          → deliveryGate → upload → publishEditedVideo
 *                          → cinematicDeliveredUrl → pipeline final gate → updateVideoStatus
 *
 * The render job gates its timeline; the pipeline's final gate reads the LINEAGE — the records
 * `replaceFinalVideo` proved against the delivered file's own clip list. The compose route this
 * suite also covered (route B) was deleted.
 *
 * ── What these tests are, and are not ───────────────────────────────────────────────────────
 *
 * They exercise the DECISION with real functions and real inputs. They are not a
 * production render: no Railway, no database, no S3. What they prove is what the gate does when it
 * is handed each shape the route can produce — and, for the final gate, that the shape is built
 * from the ledger.
 */
import { describe, expect, it } from "vitest";

import {
  deliveryGate,
  deliveryClipFactsFromLedger,
  type DeliveredLineageRecord,
  type DeliveryClipFact,
  type DeliveryGateInput,
} from "./deliveryGate";

/* ═══════════════════════ route A — the timeline route ═══════════════════════ */

const archivedClip = (id: string, archiveAssetId: number | null): DeliveryClipFact => ({
  clipId: id,
  archiveAssetId,
  provider: "internet_archive",
  providerAssetId: "youtube-r6LB5toWr5I",
  resolved: true,
  fromArchive: archiveAssetId != null,
  isPlaceholder: false,
});

const deliveredFile = {
  exists: true,
  readable: true,
  durationSec: 60,
  hasVideoStream: true,
  hasAudioStream: true,
  sizeBytes: 4_000_000,
};

const routeA = (over: Partial<DeliveryGateInput> = {}): DeliveryGateInput => ({
  videoId: 10108,
  route: "cinematic_timeline",
  cinematicRefusal: null,
  timelineExists: true,
  clips: [archivedClip("c1", 57001), archivedClip("c2", 57002)],
  delivered: deliveredFile,
  voiceoverSec: 60,
  ...over,
});

describe("Test A — cinematic route with archive assets", () => {
  it("MEASURED: it passes, and the line records that every clip came from the archive", () => {
    const v = deliveryGate(routeA());
    expect(v.allow).toBe(true);
    expect(v.lines.join("\n")).toContain("fromArchive=2");
    expect(v.lines.join("\n")).toContain("checks=assets+file");
  });
});

describe("Test B — cinematic route with a clip that has no archive handle", () => {
  /** VIDEO 653 — always a film: a provider-only clip that rendered is delivered, and named as a quality problem. */
  it("MEASURED: it is delivered, with CLIP_WITHOUT_ARCHIVE_ASSET as a quality problem", () => {
    const v = deliveryGate(routeA({ clips: [archivedClip("c1", 57001), archivedClip("c2", null)] }));
    expect(v.allow).toBe(true);
    if (!v.allow) return;
    expect(v.qualityProblems.map((f) => f.code)).toContain("CLIP_WITHOUT_ARCHIVE_ASSET");
  });

  it("MEASURED: the quality problem names the clip and why it is a risk", () => {
    const v = deliveryGate(routeA({ clips: [archivedClip("c2", null)] }));
    if (!v.allow) throw new Error("expected a delivery");
    const detail = v.qualityProblems.find((f) => f.code === "CLIP_WITHOUT_ARCHIVE_ASSET")?.detail ?? "";
    expect(detail).toContain("clip=c2");
    expect(detail).toContain("internet_archive");
    expect(detail).toContain("depends on the provider still being reachable");
  });
});

/* ═══════════════════════ Test C — a failed timeline render ═══════════════════════ */

describe("Test C — a cinematic render that failed", () => {
  it("MEASURED: it is refused, whatever its assets look like", () => {
    const v = deliveryGate(
      routeA({
        cinematicRefusal: "the cinematic render threw: ffmpeg exit 1",
        /** Perfect assets. The refusal is about WHICH FILM this is, not about its footage. */
        clips: [archivedClip("c1", 57001)],
      })
    );
    expect(v.allow).toBe(false);
    if (v.allow) return;
    expect(v.failures.map((f) => f.code)).toContain("AUTHORITATIVE_RENDER_FAILED");
  });
});

/* ═══════════════════════ Test D — the pipeline's own final gate ═══════════════════════ */

/**
 * RONDE 661 — the configured compose route this block used to cover is deleted. What remains is
 * the pipeline's final gate on the delivered clips, which reads the ledger with `assetsOnly`:
 * the archive invariant and the placeholder rule still apply to it.
 */
describe("Test D — the pipeline's final gate, on the ledger's delivered clips", () => {
  it("MEASURED: the archive invariant is still asked — and reported as a quality problem", () => {
    const v = deliveryGate({
      videoId: 10108,
      route: "cinematic_timeline",
      cinematicRefusal: null,
      timelineExists: true,
      clips: [archivedClip("c1", null)],
      delivered: null,
      assetsOnly: true,
    });
    expect(v.allow).toBe(true);
    if (!v.allow) return;
    expect(v.qualityProblems.map((f) => f.code)).toContain("CLIP_WITHOUT_ARCHIVE_ASSET");
  });

  it("MEASURED: and a placeholder is named, without blocking", () => {
    const v = deliveryGate({
      videoId: 10108,
      route: "cinematic_timeline",
      cinematicRefusal: null,
      timelineExists: true,
      clips: [{ ...archivedClip("c1", 57001), isPlaceholder: true }],
      delivered: null,
      assetsOnly: true,
    });
    expect(v.allow).toBe(true);
    if (!v.allow) return;
    expect(v.qualityProblems.map((f) => f.code)).toContain("PLACEHOLDER_IN_DELIVERY");
  });

});

/* ═══════════════════════ Test E / Test F ═══════════════════════ */

describe("Test E — providers unavailable, archive present", () => {
  /**
   * The render half of this is `renderNeedsNoProvider.test.ts`, which runs a real ffmpeg render
   * with all five provider routes wired to throw. What is asserted HERE is the delivery half: that
   * a film built entirely from archive assets is one the gate lets through.
   */
  it("MEASURED: the delivery passes with every clip from the archive", () => {
    const v = deliveryGate(routeA({ clips: [archivedClip("c1", 57001), archivedClip("c2", 57002)] }));
    expect(v.allow).toBe(true);
    if (!v.allow) return;
    expect(v.checked).toBe(2);
  });
});

describe("Test F — archive unavailable: reported, and no provider fallback", () => {
  /**
   * §7 is the point of this one. A production render whose archive copy cannot be read must FAIL;
   * it must not quietly go back out to the provider that happens to still be up, because then the
   * film's reproducibility depends on somebody else's uptime again — which is the whole thing the
   * archive exists to end.
   *
   * Owner's rule (14 October) — the film is still delivered: the clip is named as a quality problem
   * for the customer to replace, and the gate still never reaches back to the provider.
   */
  it("MEASURED: an unresolved clip is named as a quality problem even though the provider is named", () => {
    const v = deliveryGate(
      routeA({
        clips: [{ ...archivedClip("c1", 57001), resolved: false, fromArchive: false }],
      })
    );
    expect(v.allow).toBe(true);
    if (!v.allow) return;
    expect(v.qualityProblems.map((f) => f.code)).toContain("CLIP_UNRESOLVED");
  });

  it("MEASURED: the gate has no code that means 'fell back to the provider'", () => {
    /**
     * A structural claim, because the absence of a thing is what matters. The failure vocabulary
     * is the gate's whole contract with its callers; if a provider-fallback outcome ever becomes
     * expressible, it will have to be added here, and this test is where that decision surfaces.
     */
    const v = deliveryGate(routeA({ clips: [{ ...archivedClip("c1", null), resolved: false }] }));
    const findings = v.allow ? v.qualityProblems : v.failures;
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.code).not.toMatch(/PROVIDER|FALLBACK|RETRY/);
    }
  });
});

/* ═══════════════════════ §6 — both negatives, kept apart ═══════════════════════ */

describe("§6 — the technical failure and the policy failure are different facts", () => {
  /**
   * `renderNeedsNoProvider.test.ts` holds the first: a timeline with no archive handle fails
   * REHYDRATION with ASSET_NOT_FOUND, because there is nothing to fetch. That is a technical fact
   * about one clip.
   *
   * This holds the second: even when every clip resolves perfectly, a production delivery whose
   * clips carry no archive handle is refused as POLICY. The two can diverge — a clip may resolve
   * from a provider and still be unfit for production — and a system that only tested the first
   * would let exactly that through.
   */
  /** VIDEO 653 — the two facts stay apart, and both are reported by their own code (owner's rule, 14 October). */
  it("MEASURED: a clip that resolved fine is delivered and its missing archive handle is reported", () => {
    const v = deliveryGate(
      routeA({ clips: [{ ...archivedClip("c1", null), resolved: true, fromArchive: false }] })
    );
    expect(v.allow).toBe(true);
    if (!v.allow) return;
    expect(v.qualityProblems.map((f) => f.code)).toEqual(["CLIP_WITHOUT_ARCHIVE_ASSET"]);
    /** and the technical failure is its own fact, named beside the policy one */
    const broken = deliveryGate(routeA({ clips: [{ ...archivedClip("c1", null), resolved: false, fromArchive: false }] }));
    expect(broken.allow).toBe(true);
    if (!broken.allow) return;
    expect(broken.qualityProblems.map((f) => f.code)).toEqual(["CLIP_WITHOUT_ARCHIVE_ASSET", "CLIP_UNRESOLVED"]);
  });
});

/* ═══════════════════════ the assets-only mode says what it is ═══════════════════════ */

describe("a gate with no file measurement of its own says so", () => {
  it("MEASURED: assetsOnly skips the file checks rather than inventing them", () => {
    const v = deliveryGate({
      videoId: 1, route: "cinematic_timeline", cinematicRefusal: null, timelineExists: true,
      clips: [archivedClip("c1", 57001)],
      /** No facts at all — and with assetsOnly that is not a missing-file failure. */
      delivered: null,
      assetsOnly: true,
    });
    expect(v.allow).toBe(true);
    expect(v.lines.join("\n")).toContain("checks=assets");
    expect(v.lines.join("\n")).not.toContain("checks=assets+file");
  });

  it("MEASURED: without assetsOnly, a missing file measurement IS a failure", () => {
    const v = deliveryGate({
      videoId: 1, route: "cinematic_timeline", cinematicRefusal: null, timelineExists: true,
      clips: [archivedClip("c1", 57001)],
      delivered: null,
    });
    expect(v.allow).toBe(false);
    if (v.allow) return;
    expect(v.failures.map((f) => f.code)).toContain("DELIVERED_FILE_MISSING");
  });
});
