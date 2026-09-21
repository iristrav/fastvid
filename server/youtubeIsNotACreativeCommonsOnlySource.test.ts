/**
 * RONDE 268 — YOUTUBE IS NOT A CREATIVE-COMMONS-ONLY SOURCE, AND ALREADY WAS NOT.
 *
 * ── The question, and the answer the code gives ─────────────────────────────────────────────
 *
 * The brief asks whether a Creative Commons filter is technically blocking the general YouTube
 * route, and asks for it to be repaired if so. It is not, and this file is the proof — because
 * "already correct" is a claim that needs evidence exactly as much as a repair does, and because
 * the next round must not be able to remove it by accident.
 *
 * `searchYoutubeVideoCandidates` takes a `YoutubeLicenseMode` mapped one-to-one onto YouTube's own
 * `videoLicense` parameter, and `any` means SEND NOTHING — no filter at all, whatever ranks best.
 * `fetchYouTubeCCClips` builds three passes from it, and with the shipped defaults all three run,
 * with the unfiltered one FIRST.
 *
 * ── The production evidence ─────────────────────────────────────────────────────────────────
 *
 * Render 586, three modes in the retrieval log:
 *
 *     [Retrieval] s2 source=youtube mode=any             duration=short
 *     [Retrieval] s0 source=youtube mode=creative_common duration=medium
 *     [Retrieval] s1 source=youtube mode=youtube         duration=short
 *
 * And both files that were actually delivered came from the UNFILTERED pass — `ytfu` is
 * `anyPass.fileTag`:
 *
 *     scene_0_ytfu_0__pid_youtube_cc-c33de2c03809c228_rapid_tmp.mp4   7 297 358 bytes
 *     scene_2_ytfu_0__pid_youtube_cc-937a3dba11bffd50_rapid_tmp.mp4   6 285 351 bytes
 *
 * So the ordinary-YouTube route is not merely implemented: it is the route that produced this
 * project's only two delivered YouTube clips. That is PRODUCTION-PROVEN, and it is the one thing
 * in this area that did not need building.
 *
 * ── What this file does NOT say ─────────────────────────────────────────────────────────────
 *
 * Nothing here is about rights. The owner has stated they arrange licensing themselves, and this
 * round adds no permission and removes no check: §4 pins that a clip found under `any` still
 * records WHICH question was asked, so an unfiltered result can never later read as a Creative
 * Commons assertion. Licensed is not relevant, and relevant is not Vision FIT — the selection
 * gates in front of every one of these passes are untouched.
 */
import { describe, expect, it } from "vitest";

import { youtubeLicenseParam } from "./videoPipeline";
import { youtubeOperatorAuthorized } from "./sourcingPolicy";
import { stripComments } from "./sourceScan.test.support";
import fs from "fs";
import path from "path";

const PIPE = stripComments(fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8"));

/* ═══════════ 1. the mode vocabulary ═══════════ */

describe("R268 §1 — three modes, and one of them is no filter at all", () => {
  it("ANY SENDS NOTHING — which is the whole meaning of an unfiltered search", () => {
    expect(youtubeLicenseParam("any")).toBeNull();
  });

  it("and the other two are YouTube's own parameter, one to one", () => {
    expect(youtubeLicenseParam("creative_common")).toBe("creativeCommon");
    expect(youtubeLicenseParam("youtube")).toBe("youtube");
  });

  it("`any` is NOT sent as videoLicense=any, which would be a licence assertion", () => {
    /**
     * Sending `videoLicense=any` would be the same request under a different cache key AND would
     * make the unfiltered pass look like an assertion about licensing when it is precisely the
     * absence of one. Null is the honest value.
     */
    expect(youtubeLicenseParam("any")).not.toBe("any");
  });
});

/* ═══════════ 2. all three passes exist, and the unfiltered one is not last ═══════════ */

describe("R268 §2 — the general route is built, not just available", () => {
  const block = PIPE.slice(
    PIPE.indexOf('const ccPass = { license: "creative_common"'),
    PIPE.indexOf("for (const query of uniqueQueries.slice(0, 2))")
  );

  it("THE THREE PASSES ARE ALL CONSTRUCTED", () => {
    expect(block).toContain('const ccPass = { license: "creative_common"');
    expect(block).toContain('const stdPass = { license: "youtube"');
    expect(block).toContain('const anyPass = { license: "any"');
  });

  it("and the unfiltered pass runs FIRST when the operator is authorised", () => {
    expect(block).toContain("const recallFirst = youtubeOperatorAuthorized();");
    expect(block).toContain("if (recallFirst && youtubeFairUseEnabled()) licensePasses.push(anyPass);");
    const anyFirst = block.indexOf("if (recallFirst && youtubeFairUseEnabled()) licensePasses.push(anyPass);");
    const cc = block.indexOf("licensePasses.push(ccPass);");
    expect(anyFirst, "Creative Commons is queued ahead of the unfiltered pass").toBeLessThan(cc);
  });

  it("CC IS NOT A PRECONDITION — it is one pass among three, never a gate on the others", () => {
    /**
     * The shape that would BE the reported defect: a single unconditional push of ccPass with the
     * others behind a check on it. Each pass is pushed independently; none reads another.
     */
    expect(block, "a pass was made conditional on the CC pass").not.toMatch(
      /ccPass[\s\S]{0,200}?if \([^)]*cc/i
    );
  });
});

/* ═══════════ 3. the defaults ship it on ═══════════ */

describe("R268 §3 — on by default, not behind a flag nobody set", () => {
  it("OPERATOR AUTHORISATION DEFAULTS TO ON", () => {
    const before = process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE;
    try {
      delete process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE;
      expect(youtubeOperatorAuthorized()).toBe(true);
    } finally {
      if (before === undefined) delete process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE;
      else process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE = before;
    }
  });

  it("and it can still be switched OFF explicitly, which is what a flag is for", () => {
    const before = process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE;
    try {
      process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE = "false";
      expect(youtubeOperatorAuthorized()).toBe(false);
    } finally {
      if (before === undefined) delete process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE;
      else process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE = before;
    }
  });

  it("the unfiltered pass is opt-OUT, not opt-in", () => {
    expect(PIPE).toContain('return envFlagIsNotOff("ENABLE_YOUTUBE_FAIR_USE");');
  });

  it("and so is the standard-licence pass, once the operator is authorised", () => {
    expect(PIPE).toContain('? envFlagIsNotOff("ENABLE_YOUTUBE_STANDARD_LICENSE")');
    expect(PIPE).toContain(': envFlagIsOn("ENABLE_YOUTUBE_STANDARD_LICENSE")');
  });
});

/* ═══════════ 4. an unfiltered result never claims Creative Commons ═══════════ */

describe("R268 §4 — what a clip may honestly claim about its own licence", () => {
  it("WHICH QUESTION WAS ASKED IS ALWAYS RECORDED", () => {
    expect(PIPE, "a clip could no longer say which licence mode found it").toContain(
      "retrievedUnder"
    );
  });

  it("and only the CC pass reports a Creative Commons licence", () => {
    const pool = stripComments(
      fs.readFileSync(path.join(__dirname, "youtubePoolSource.ts"), "utf8")
    );
    expect(pool).toContain('...(mode === "creative_common" ? { reported: "creativeCommon" } : {})');
    expect(
      pool,
      "an unfiltered result was labelled Creative Commons, which is a claim nobody verified"
    ).not.toMatch(/mode === "any"[\s\S]{0,80}reported: "creativeCommon"/);
  });

  it("this round adds no permission and removes no check", () => {
    /**
     * Rights are arranged outside FASTVID, by the owner, and were never this file's subject. What
     * is asserted here is only that the unfiltered route EXISTS and is honest about itself. Every
     * selection gate in front of it is untouched — a licensed clip still has to be relevant, still
     * has to be eligible, still has to be ranked, and still has to earn a Vision FIT.
     */
    expect(PIPE).toContain("const alreadyRefused = youtubeDownloadRefusal(videoId);");
    expect(PIPE).toContain("if (!canAffordYoutubeTurn(YOUTUBE_MIN_TURN_MS)) {");
  });
});

/* ═══════════ 5. the production evidence, pinned ═══════════ */

describe("R268 §5 — the two delivered clips came from the unfiltered pass", () => {
  it("`ytfu` IS THE UNFILTERED PASS — which is what render 586's filenames carried", () => {
    /**
     * `scene_0_ytfu_0__pid_youtube_cc-c33de2c03809c228_rapid_tmp.mp4` and its scene-2 sibling are
     * the only two YouTube files this project has ever delivered in production. `ytfu` is
     * `anyPass.fileTag`, so both came from the route with no licence filter — the general YouTube
     * source, not Creative Commons.
     */
    const block = PIPE.slice(
      PIPE.indexOf('const anyPass = { license: "any"'),
      PIPE.indexOf('const anyPass = { license: "any"') + 200
    );
    expect(block).toContain('fileTag: "ytfu"');
  });

  it("and the CC pass has a different tag, so the two are distinguishable in a log", () => {
    expect(PIPE).toContain('fileTag: "ytcc"');
    expect(PIPE).toContain('fileTag: "ytstd"');
  });
});
