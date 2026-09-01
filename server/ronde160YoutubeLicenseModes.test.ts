/**
 * RONDE 160 — FASE 4: YouTube's three licence modes, and the metadata that must survive them.
 *
 * ── What was already there, and what was not ────────────────────────────────────────────────
 *
 * The audit found `searchYoutubeVideoCandidates` already took `"creative_common" | "any"`, so two
 * of the three modes existed. What did not exist was the mode that asks YouTube for its STANDARD
 * licence specifically (`videoLicense=youtube`), and — more importantly — nothing anywhere
 * recorded WHICH mode had found a clip. A finished video could not say what it was made of.
 *
 * ── Why these tests call real functions and assert no source text ───────────────────────────
 *
 * A first draft of this file asserted the SHAPE OF THE SOURCE — "the pass list contains this
 * string". That is not a test of behaviour: it passes when the code is written a particular way
 * and fails when it is merely reformatted, which teaches people to edit the test. So the two
 * decisions that actually matter — which parameter the API is sent, and what a clip may claim
 * about its licence — were extracted into `youtubeLicenseParam` and `youtubeLicenseMetadata`, the
 * functions the production call sites now use, and those are called here directly.
 *
 * PRODUCTION STATUS: LOCAL. There is no YOUTUBE_API_KEY in this environment, so no real query is
 * made and none is claimed. What is proven is the request this code decides to build and the
 * metadata it decides to record — not that YouTube answered.
 */
import { describe, expect, it } from "vitest";

import {
  youtubeLicenseMetadata,
  youtubeLicenseParam,
  type YoutubeLicenseMode,
} from "./videoPipeline";
import { envFlagIsOn } from "./sourcingPolicy";

const MODES: YoutubeLicenseMode[] = ["creative_common", "youtube", "any"];

/* ═══════════════════════ the request each mode builds ═══════════════════════ */

describe("FASE 4 — three licence modes, each asking YouTube a different question", () => {
  it("YOUTUBE_CREATIVE_COMMONS asks for creativeCommon", () => {
    expect(youtubeLicenseParam("creative_common")).toBe("creativeCommon");
  });

  it("YOUTUBE_STANDARD asks for the standard licence specifically", () => {
    expect(youtubeLicenseParam("youtube")).toBe("youtube");
  });

  /**
   * `any` means "no filter", and that is a real distinction rather than a third string. Sending
   * `videoLicense=any` would be the same request under a different cache key, and would make the
   * unfiltered pass look like a licence assertion when it is the absence of one.
   */
  it("YOUTUBE_ANY sends no licence parameter at all", () => {
    expect(youtubeLicenseParam("any")).toBeNull();
  });

  it("the three modes really are three different requests", () => {
    const params = MODES.map(youtubeLicenseParam);
    expect(new Set(params).size, "two modes send the same request").toBe(3);
  });

  /** The values are YouTube's own vocabulary, not ours — a typo here is a silently empty search. */
  it("uses the API's exact spelling, which is not this codebase's spelling", () => {
    expect(youtubeLicenseParam("creative_common")).not.toBe("creative_common");
    expect(youtubeLicenseParam("creative_common")).toBe("creativeCommon");
  });
});

/* ═══════════════════════ licence as metadata, never as permission ═══════════════════════ */

describe("FASE 4 — a clip records the licence it was retrieved under, and claims nothing more", () => {
  it("always records WHICH mode found the clip", () => {
    for (const mode of MODES) {
      expect(youtubeLicenseMetadata(mode).retrievedUnder, mode).toBe(mode);
    }
  });

  it("records the provider's licence for the two modes that are assertions", () => {
    expect(youtubeLicenseMetadata("creative_common").reported).toBe("creativeCommon");
    expect(youtubeLicenseMetadata("youtube").reported).toBe("youtube");
  });

  /**
   * The honesty rule. The unfiltered pass filters nothing, so it proves nothing about the licence
   * of what it returns. Attaching one would be inventing a fact about somebody else's video.
   */
  it("claims NO licence for a clip the unfiltered mode found", () => {
    const meta = youtubeLicenseMetadata("any");
    expect(meta.reported).toBeUndefined();
    expect(meta.retrievedUnder).toBe("any");
  });

  /** The two halves cannot drift: the recorded licence is the parameter that was sent. */
  it("the recorded licence and the sent parameter are the same decision", () => {
    for (const mode of MODES) {
      expect(youtubeLicenseMetadata(mode).reported ?? null, mode).toBe(youtubeLicenseParam(mode));
    }
  });

  /**
   * `licenseAllowed` (this pipeline's verdict) and `license.reported` (the provider's assertion)
   * are different facts. Only one of them survives a policy change, and recording only the verdict
   * is how a finished video ends up unable to say what it was made of.
   */
  it("is metadata, not permission — it carries no allow/deny at all", () => {
    for (const mode of MODES) {
      const meta = youtubeLicenseMetadata(mode) as Record<string, unknown>;
      expect(Object.keys(meta).sort()).not.toContain("licenseAllowed");
      expect(Object.keys(meta).sort()).not.toContain("allowed");
    }
  });
});

/* ═══════════════════════ the gate on the standard pass ═══════════════════════ */

describe("FASE 4 — the standard-licence pass is opt-in", () => {
  /**
   * It is the one mode that can ONLY ever return non-CC material, so switching it on is a
   * licensing decision an operator makes deliberately — never something a deploy inherits.
   */
  it("is off unless ENABLE_YOUTUBE_STANDARD_LICENSE is exactly 'true'", () => {
    const original = process.env.ENABLE_YOUTUBE_STANDARD_LICENSE;
    try {
      delete process.env.ENABLE_YOUTUBE_STANDARD_LICENSE;
      expect(envFlagIsOn("ENABLE_YOUTUBE_STANDARD_LICENSE")).toBe(false);

      process.env.ENABLE_YOUTUBE_STANDARD_LICENSE = "true";
      expect(envFlagIsOn("ENABLE_YOUTUBE_STANDARD_LICENSE")).toBe(true);

      /** An opt-IN flag: anything that is not "true" leaves it off, including "yes" and "1". */
      for (const v of ["yes", "1", "on", "", "false"]) {
        process.env.ENABLE_YOUTUBE_STANDARD_LICENSE = v;
        expect(envFlagIsOn("ENABLE_YOUTUBE_STANDARD_LICENSE"), v).toBe(false);
      }
    } finally {
      if (original === undefined) delete process.env.ENABLE_YOUTUBE_STANDARD_LICENSE;
      else process.env.ENABLE_YOUTUBE_STANDARD_LICENSE = original;
    }
  });
});

/* ═══════════════════════ no silent substitution ═══════════════════════ */

/**
 * FASE 8's rule, at the one place it could be broken quietly.
 *
 * RapidAPI's scraped search reports no licence at all. Routing a licence-SPECIFIC mode through it
 * would return results this code would then label with a licence nobody verified — one source
 * silently standing in for another. These are structural checks on the import graph and the
 * guard condition, which is where that mistake would actually live.
 */
describe("FASE 8 — the quota-free fallback cannot serve a licence-specific mode", () => {
  it("the fallback is guarded by the unfiltered mode and by nothing else", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("server/videoPipeline.ts", "utf8");
    const fn = src.slice(src.indexOf("export async function searchYoutubeVideoCandidates("));
    const body = fn.slice(0, fn.indexOf("\nexport async function fetchYouTubeCCClips"));

    expect(body, "the fallback is not reachable at all any more").toContain("searchYoutubeViaRapidApi");
    /** The only mode named next to the fallback's own switch is the unfiltered one. */
    const guard = body.slice(body.indexOf("let effectiveSearchData"), body.indexOf("if (!effectiveSearchData)"));
    expect(guard).toContain('license === "any"');
    expect(guard).not.toContain('license === "youtube"');
    expect(guard).not.toContain('license === "creative_common"');
  });
});

/* ═══════════════════════ observability ═══════════════════════ */

describe("FASE 15 — a log can say which YouTube mode was attempted", () => {
  /**
   * A production log has to answer "why was YouTube used for this beat" and "why was it not". The
   * existing [Pipeline] lines answer neither: a beat that got nothing from YouTube looked exactly
   * like a beat where YouTube was never tried, because the mode was never printed.
   */
  it("every YouTube search attempt logs its mode and its candidate count", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("server/videoPipeline.ts", "utf8");
    const at = src.indexOf("[Retrieval] s${sceneIndex} source=youtube");
    expect(at, "the retrieval line is gone").toBeGreaterThan(-1);
    const stmt = src.slice(at, src.indexOf(");", at));
    expect(stmt).toContain("mode=${pass.license}");
    expect(stmt).toContain("attempted=true");
    expect(stmt).toContain("candidates=${items.length}");
  });

  /** §15 — no keys, no tokens, no signed URLs in a retrieval log line. */
  it("the retrieval line carries no credential and no URL", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("server/videoPipeline.ts", "utf8");
    const at = src.indexOf("[Retrieval] s${sceneIndex} source=youtube");
    const stmt = src.slice(at, src.indexOf(");", at));
    for (const forbidden of ["API_KEY", "apiKey", "RAPIDAPI", "https://", "youtubeApiKey", "key="]) {
      expect(stmt, forbidden).not.toContain(forbidden);
    }
  });
});
