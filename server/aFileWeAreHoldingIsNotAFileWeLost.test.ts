/**
 * RONDE 255 — A FILE THIS RENDER IS HOLDING, REFUSED BY THE ONE CHECK THAT NEVER SAW IT.
 *
 * ── What render 585 lost, and to what ───────────────────────────────────────────────────────
 *
 *     [Validator] BLOCKING VIDEO/vc_bcc6087010 [49.830s → 62.399s] missing_asset:
 *       no rehydration route exists for this provider: provider=serpapi
 *       providerAssetId=https://offloadmedia.feverup.com/.../Los-Angeles-skyline.jpg
 *       archiveAssetId=null mediaUrl=yes
 *     [CinematicPipeline] video=585 plan NOT stored code=CINEMATIC_TIMELINE_INVALID
 *     [RenderJob] video=585 route=legacy_compose RENDER_FALLBACK_USED
 *
 * One shot. The whole plan — four camera moves, two transitions, the ambience bed and the ducking
 * — was thrown away over a single clip, and the film was then made by the legacy route USING THAT
 * SAME PICTURE. The asset was never lost. Its bytes were on disk, and compose read them.
 *
 * ── Two checks, two different questions ─────────────────────────────────────────────────────
 *
 *     planner    identityIsRehydratable(identity)      → TRUE   (a mediaUrl is present)
 *     validator  identityHasRehydrationRoute(identity) → FALSE  (serpapi has no route, and there
 *                                                                is no archiveAssetId)
 *
 * Both are right about their own question. The planner let the beat through on the weaker one, and
 * the validator killed the plan on the stronger one.
 *
 * `localOnlyIdentityFor` exists for exactly this and says so in its own note — "the planner was
 * refusing a beat over a download that was never going to happen". It sits behind the WEAKER check:
 *
 *     const localOnly = rehydratable ? null : localOnlyIdentityFor(…);
 *
 * So for the one case it was written for, `rehydratable` is truthy and the escape hatch is skipped.
 * Render 585 printed the receipt: `localOnly=0`.
 *
 * And it would not have helped if it HAD fired, because it verifies the file exists and then
 * returns an identity that says nothing about that. The conclusion was computed and dropped — the
 * same shape as everything else this sequence of rounds has been about.
 *
 * ── What changes ────────────────────────────────────────────────────────────────────────────
 *
 * The fact travels. An identity can now say "this render held the file", the planner asks the
 * question the VALIDATOR will ask so the fallback is reachable, and the validator reports a clip
 * like this as `local_only_asset` — non-blocking, named, and counted.
 *
 * NOTHING IS PROMISED THAT IS NOT TRUE. `identityHasRehydrationRoute` still answers false for
 * SerpAPI, because SerpAPI genuinely has no route: RONDE 96 established that its results carry no
 * id at all, so the normalised URL is the best handle that exists. The stored plan now records
 * which of its shots are renderable today and not guaranteed tomorrow, instead of being discarded
 * whole for containing one.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  REHYDRATABLE_PROVIDERS,
  identityFromAdoption,
  identityIsRehydratable,
  providerIsRehydratable,
} from "./assetIdentity";
import { identityHasRehydrationRoute } from "./assetRehydrator";
import { identityFrom, localOnlyIdentityFor } from "./cinematicPipelineInputs";
import { NON_BLOCKING_ISSUES, validateTimeline } from "./timelineValidator";
import type { AssetSourceIdentity } from "./projectTimeline";

/**
 * The providers this system has no documented way back to.
 *
 * RONDE 145 read every adapter and drew the line here; RONDE 96 established that SerpAPI results
 * carry no id at all, so a normalised URL is the best handle that exists for one. Held in one
 * place because two separate tests ask about it — "are they refused" and "are they absent" are
 * different questions and both are asked below.
 */
const NO_ROUTE_PROVIDERS = [
  "serpapi", "sepiasearch", "flickr", "vimeo", "media_ccc", "gdelt",
] as const;

/** The adoption record render 585 actually held for the Los Angeles still. */
const SERPAPI_ADOPTION = {
  provider: "serpapi",
  providerAssetId:
    "https://offloadmedia.feverup.com/secretlosangeles.com/wp-content/uploads/Los-Angeles-skyline.jpg",
  sourceUrl:
    "https://offloadmedia.feverup.com/secretlosangeles.com/wp-content/uploads/Los-Angeles-skyline.jpg",
  assetTitle: "Los Angeles skyline",
};

/** A real file on disk, because the whole point is that the bytes are here. */
function heldFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r255-"));
  const file = path.join(dir, "extend_s1b3.mp4");
  fs.writeFileSync(file, Buffer.alloc(2048, 7));
  return file;
}

/** One-clip timeline, shaped like the one the planner produced for s1b3. */
function timelineWith(source: AssetSourceIdentity) {
  return {
    schemaVersion: 1,
    /** The clip ends at 62.399s, so the track must reach it — this is the shot's real slot. */
    durationSec: 62.399,
    format: { widthPx: 1920, heightPx: 1080, fps: 30 },
    tracks: [
      {
        kind: "VIDEO" as const,
        clips: [
          {
            id: "vc_bcc6087010",
            timelineStart: 49.83,
            timelineEnd: 62.399,
            source,
            transitionIn: "hard_cut" as const,
            transitionOut: "hard_cut" as const,
          },
        ],
      },
    ],
  };
}

describe("1. the two checks that disagreed about one asset", () => {
  /**
   * ROUND 596 ENDED THE DISAGREEMENT. This assertion is what replaced it.
   *
   * ── What this test used to say, and why it no longer can ────────────────────────────────
   *
   * It asserted the two answers DIFFER for this asset:
   *
   *     identityIsRehydratable(serpapi + mediaUrl)      → TRUE   ("a mediaUrl is present")
   *     identityHasRehydrationRoute(serpapi + mediaUrl) → FALSE  ("serpapi has no route")
   *
   * That was a faithful record of render 585: one asset, two answers, and a plan discarded
   * between them. RONDE 255 made the PLANNER ask the stronger question, which fixed the
   * consequence — but it left the two predicates saying different things, and render 595 was
   * billed to the half that was left. `internet_archive` + an id has no route either, and the
   * weaker predicate called it recoverable right up until the rehydrator reported
   * `ASSET_NOT_FOUND … has no fetchable URL`.
   *
   * So the weaker question was removed rather than routed around: `identityIsRehydratable` now
   * names the routes that exist and `identityHasRehydrationRoute` is the same function. The
   * disagreement this test was written to document cannot be expressed any more, and asserting
   * it would be asserting the defect.
   *
   * ── What is asserted instead ────────────────────────────────────────────────────────────
   *
   * The same asset, the same verdict, from both names — and the verdict is still FALSE, which is
   * the half of RONDE 255 that must never move. Nothing here says serpapi became recoverable.
   */
  it("the two questions are now one question, and it still answers no", () => {
    const identity = identityFromAdoption(SERPAPI_ADOPTION)!;
    expect(identityIsRehydratable(identity), "serpapi has no route").toBe(false);
    expect(identityHasRehydrationRoute(identity), "serpapi has no route").toBe(false);
    expect(
      identityHasRehydrationRoute(identity),
      "the two predicates disagree about one asset again"
    ).toBe(identityIsRehydratable(identity));
  });

  /**
   * AND THEY AGREE ABOUT EVERY PROVIDER THIS SYSTEM CANNOT GO BACK TO.
   *
   * One asset is an example; the rule is the point. Each of these carries a media URL — the thing
   * that used to make the weaker predicate say yes — and none of them has a documented re-fetch
   * route, so both names must answer false for all of them.
   */
  it("AND FOR EVERY PROVIDER WITH NO DOCUMENTED ROUTE", () => {
    for (const provider of NO_ROUTE_PROVIDERS) {
      const identity = identityFromAdoption({
        provider,
        providerAssetId: "an-id-nothing-can-look-up",
        sourceUrl: `https://cdn.example.invalid/${provider}/still.jpg`,
      })!;
      expect(identityIsRehydratable(identity), `${provider} is not rehydratable`).toBe(false);
      expect(identityHasRehydrationRoute(identity), `${provider} has no route`).toBe(false);
    }
  });

  /**
   * THE GATE THAT KEPT THE FALLBACK SHUT. `identityFrom` is what the planner calls, and it answers
   * the weaker question — so `localOnly` was never consulted for the case it was written for.
   */
  it("the planner now asks the question the validator will ask", () => {
    expect(
      identityFrom(SERPAPI_ADOPTION),
      "render 585 got an identity here and skipped the local-file fallback"
    ).toBeNull();
  });

  /** And still answers yes for a provider that genuinely has a route. */
  it("a provider with a real route is unaffected", () => {
    const wikimedia = identityFrom({
      provider: "wikimedia",
      providerAssetId: "File:Kim_Kardashian_2013.png",
      sourceUrl: "https://upload.wikimedia.org/wikipedia/commons/f/fb/Kim_Kardashian_2013.png",
    });
    expect(wikimedia).not.toBeNull();
    expect(identityHasRehydrationRoute(wikimedia!)).toBe(true);
  });
});

describe("2. the file being here is written down, not just checked", () => {
  it("an identity built from a held file says so", () => {
    const identity = localOnlyIdentityFor(SERPAPI_ADOPTION, heldFile());
    expect(identity, "the file exists and has bytes").not.toBeNull();
    expect(
      identity!.heldLocallyAtRender,
      "render 585 verified the file and returned an identity that did not mention it"
    ).toBe(true);
  });

  it("a missing file still produces nothing at all", () => {
    expect(localOnlyIdentityFor(SERPAPI_ADOPTION, "/nope/does/not/exist.mp4")).toBeNull();
  });

  it("an empty file is not a held file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r255-empty-"));
    const empty = path.join(dir, "zero.mp4");
    fs.writeFileSync(empty, Buffer.alloc(0));
    expect(localOnlyIdentityFor(SERPAPI_ADOPTION, empty)).toBeNull();
  });

  /** The flag is a statement about THIS render, so it is never invented for an absent file. */
  it("and no identity claims it without a file behind it", () => {
    expect(identityFromAdoption(SERPAPI_ADOPTION)!.heldLocallyAtRender).toBeUndefined();
  });
});

describe("3. the validator reports it instead of killing the plan", () => {
  it("a held local-only clip is a finding, not a blocking issue", () => {
    const identity = localOnlyIdentityFor(SERPAPI_ADOPTION, heldFile())!;
    const result = validateTimeline(timelineWith(identity) as never);
    const codes = result.issues.map((i) => i.code);
    expect(codes, "render 585 raised missing_asset here").not.toContain("missing_asset");
    expect(codes).toContain("local_only_asset");
    const blocking = result.issues.filter((i) => !NON_BLOCKING_ISSUES.has(i.code));
    expect(blocking, "one non-durable shot must not discard the whole plan").toEqual([]);
  });

  /** The finding names the shot and says what is actually true about it. */
  it("and says what it is, in words an operator can act on", () => {
    const identity = localOnlyIdentityFor(SERPAPI_ADOPTION, heldFile())!;
    const issue = validateTimeline(timelineWith(identity) as never).issues.find(
      (i) => i.code === "local_only_asset"
    )!;
    expect(issue.elementId).toBe("vc_bcc6087010");
    expect(issue.reason).toContain("serpapi");
    expect(issue.reason.toLowerCase()).toContain("re-render");
  });

  /**
   * THE OTHER SIDE, AND THE REASON THIS IS NOT A LOOSENING. An asset with no handle of any kind is
   * still refused, still blocking. What changed is the clip we are holding, not the clip we lost.
   */
  it("an asset with no handle at all still blocks", () => {
    const orphan: AssetSourceIdentity = { provider: "UNVERIFIED" };
    const result = validateTimeline(timelineWith(orphan) as never);
    expect(result.issues.map((i) => i.code)).toContain("missing_asset");
    expect(result.issues.filter((i) => !NON_BLOCKING_ISSUES.has(i.code)).length).toBeGreaterThan(0);
  });

  it("and a provider with no route and no held file still blocks", () => {
    const identity = identityFromAdoption(SERPAPI_ADOPTION)!;
    const result = validateTimeline(timelineWith(identity) as never);
    expect(result.issues.map((i) => i.code)).toContain("missing_asset");
    expect(result.issues.filter((i) => !NON_BLOCKING_ISSUES.has(i.code)).length).toBeGreaterThan(0);
  });
});

describe("4. nothing was promised that is not true", () => {
  it("serpapi still has no rehydration route", () => {
    const identity = localOnlyIdentityFor(SERPAPI_ADOPTION, heldFile())!;
    expect(
      identityHasRehydrationRoute(identity),
      "holding the file today is not a route to it tomorrow"
    ).toBe(false);
  });

  /**
   * THE GUARD THAT WENT BLIND, AND WHY IT IS NOW A RUNTIME QUESTION.
   *
   * ── How it stopped guarding ─────────────────────────────────────────────────────────────
   *
   * It read `REHYDRATABLE_PROVIDERS` out of `assetRehydrator.ts` with a regex. Round 596 moved
   * that literal to `assetIdentity.ts`, beside the route rule that needs it, and re-exported it —
   * a correct move that the regex could not follow. The match returned nothing and the test threw
   * instead of checking, which is the worst failure mode a safety net has: it looks red for the
   * wrong reason, and while it is red it is protecting nothing.
   *
   * That mattered more here than anywhere else. Round 596's FIRST draft of the route rule dropped
   * this very allow-list from the `stored_url` branch — which would have readmitted render 585's
   * SerpAPI still without a word — and this list is the boundary RONDE 145 drew to prevent it.
   *
   * ── Why it asks the runtime and not the source ──────────────────────────────────────────
   *
   * A source-text assertion only ever proves a string is absent from one file. It cannot see a
   * provider admitted through a second list, a normalisation that folds a name onto an allowed
   * one, or a literal that has simply moved house again. The question this test exists to ask is
   * "can this provider be fetched again", and `providerIsRehydratable` IS that question — so it
   * is asked directly, of the real exported configuration, in both of the forms callers use.
   */
  it("THE PROVIDER LIST WAS NOT WIDENED — asked of the runtime, not of a source file", () => {
    for (const forbidden of NO_ROUTE_PROVIDERS) {
      expect(
        providerIsRehydratable(forbidden),
        `${forbidden} has no documented re-fetch route and must not be rehydratable`
      ).toBe(false);
      expect(
        REHYDRATABLE_PROVIDERS,
        `${forbidden} was added to the rehydration provider list`
      ).not.toContain(forbidden);
    }
  });

  it("and the providers that DO have a route are all still on it", () => {
    /**
     * The other direction, so the guard cannot be satisfied by emptying the list. These are the
     * providers RONDE 145 proved reachable by reading each adapter.
     */
    for (const allowed of [
      "curated", "archive", "wikimedia", "loc", "internet_archive",
      "pexels", "pixabay", "youtube", "youtube_cc",
      "nasa", "nara", "europeana", "openverse",
    ]) {
      expect(providerIsRehydratable(allowed), `${allowed} lost its route`).toBe(true);
    }
  });

  it("the list is matched on the whole name, not on a fragment of one", () => {
    /**
     * `providerIsRehydratable` trims and lower-cases and then asks for an exact member. A
     * substring test would let `serpapi_images` or `archive.org_scrape` in through a name that
     * merely contains an allowed one, which is how allow-lists usually leak.
     */
    expect(providerIsRehydratable("  WIKIMEDIA  ")).toBe(true);
    for (const nearMiss of ["archive.org", "wikimedia_scrape", "youtube_cc_mirror", "pexels_cdn"]) {
      expect(providerIsRehydratable(nearMiss), `${nearMiss} slipped in on a partial name`).toBe(false);
    }
  });

  it("and the blocking issues that were blocking still are", () => {
    for (const code of [
      "missing_asset", "video_overlap", "negative_duration", "end_before_start",
      "zero_duration", "invalid_transition",
    ]) {
      expect(NON_BLOCKING_ISSUES.has(code as never), code).toBe(false);
    }
  });
});
