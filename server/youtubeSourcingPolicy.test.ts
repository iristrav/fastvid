/**
 * YOUTUBE IS AN AUTHORISED PRODUCTION SOURCE, NOT A CC-ONLY ONE.
 *
 * ── The defect this closes ──────────────────────────────────────────────────────────────────
 *
 * `PoolRequest.youtubeLicenseMode` was built, typed and documented, and NOTHING in production ever
 * set it. `scenePool` fell through to a hardcoded `?? "creative_common"` on every render, so the
 * ranked retrieval path RONDE 175 wired up specifically so YouTube could compete as a source asked
 * YouTube for Creative Commons material and nothing else — silently, in a project that holds
 * authorisation to use YouTube generally.
 *
 * The same shape as the counters of RONDE 115, 119 and 120: a knob exists, nothing turns it, and
 * its default quietly governs the system. This file is the caller-and-default check for a SETTING
 * rather than for a counter.
 *
 * ── The line this file holds ────────────────────────────────────────────────────────────────
 *
 * A wider net is not a lower bar. The policy decides which QUESTION retrieval asks; it decides
 * nothing about what survives afterwards. Every relevance, person, vision, image-gate, adoption,
 * dedup, lineage and delivery check is unchanged, and the tests at the end assert that the gates
 * are still called and still able to refuse.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

import {
  youtubeOperatorAuthorized,
  youtubeRetrievalMode,
  type YoutubeLicenseMode,
} from "./sourcingPolicy";
import { allowOperatorLicensedYoutube } from "./youtubeLicenseStatus";
/** Statically imported: the module is large, and its load must not count against a test timeout. */
import { capYoutubeClipDurationForTest } from "./videoPipeline";

const SERVER = __dirname;
const read = (f: string) => fs.readFileSync(path.join(SERVER, f), "utf8");

/** Runs `fn` with the named env vars set, and puts the environment back however it ends. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const AUTHORISED = { ALLOW_OPERATOR_LICENSED_YOUTUBE: undefined, YOUTUBE_LICENSE_MODE: undefined };
const WITHDRAWN = { ALLOW_OPERATOR_LICENSED_YOUTUBE: "false", YOUTUBE_LICENSE_MODE: undefined };

/* ═══════════════ 1. the question retrieval asks ═══════════════ */

describe("the licence question the project's policy names", () => {
  it("an authorised project asks the widest question there is", () => {
    /**
     * `any` sends no `videoLicense` filter, which is the highest-recall query the Data API takes:
     * CC and standard-licence material ranked together by YouTube's own relevance.
     */
    expect(withEnv(AUTHORISED, youtubeRetrievalMode)).toBe("any");
  });

  it("withdrawing the authorisation restores Creative Commons only, exactly", () => {
    expect(withEnv(WITHDRAWN, youtubeRetrievalMode)).toBe("creative_common");
  });

  it("the operator can name a mode outright, in either direction", () => {
    const modes: YoutubeLicenseMode[] = ["creative_common", "youtube", "any"];
    for (const mode of modes) {
      expect(
        withEnv({ ...AUTHORISED, YOUTUBE_LICENSE_MODE: mode }, youtubeRetrievalMode),
        mode
      ).toBe(mode);
    }
  });

  it("a mode this codebase does not have falls back to the policy, never to a guess", () => {
    expect(
      withEnv({ ...AUTHORISED, YOUTUBE_LICENSE_MODE: "public_domain" }, youtubeRetrievalMode)
    ).toBe("any");
    expect(
      withEnv({ ...WITHDRAWN, YOUTUBE_LICENSE_MODE: "nonsense" }, youtubeRetrievalMode)
    ).toBe("creative_common");
  });

  it("only the literal `false` withdraws the authorisation", () => {
    for (const v of ["", "1", "yes", "on", "true", "no"]) {
      expect(
        withEnv({ ALLOW_OPERATOR_LICENSED_YOUTUBE: v }, youtubeOperatorAuthorized),
        `"${v}" is not the word "false"`
      ).toBe(true);
    }
    for (const v of ["false", "FALSE", " false "]) {
      expect(withEnv({ ALLOW_OPERATOR_LICENSED_YOUTUBE: v }, youtubeOperatorAuthorized), v).toBe(
        false
      );
    }
  });

  it("the archive gate and the live-retrieval policy never disagree about the authorisation", () => {
    /** One authorisation, two paths. A change to one that misses the other is a split brain. */
    for (const v of [undefined, "", "true", "false", "FALSE", " false ", "no"]) {
      expect(
        withEnv({ ALLOW_OPERATOR_LICENSED_YOUTUBE: v }, youtubeOperatorAuthorized),
        `value=${String(v)}`
      ).toBe(withEnv({ ALLOW_OPERATOR_LICENSED_YOUTUBE: v }, allowOperatorLicensedYoutube));
    }
  });
});

/* ═══════════════ 2. the setting now has a caller ═══════════════ */

describe("the pool's licence mode is chosen, not inherited from a literal", () => {
  it("scenePool's default is the policy, and no longer a hardcoded creative_common", () => {
    const pool = read("scenePool.ts");
    expect(pool).toContain("req.youtubeLicenseMode ?? youtubeRetrievalMode()");
    expect(
      pool,
      "a hardcoded CC fallback is how the ranked YouTube path became CC-only in every render " +
        "without anyone choosing that"
    ).not.toContain('youtubeLicenseMode ?? "creative_common"');
  });

  it("the mode type has ONE declaration, beside the function that chooses it", () => {
    /**
     * Two copies of the union is how the halves drift until a mode exists on one side and not the
     * other. `videoPipeline` re-exports it so every existing importer is untouched.
     */
    expect(read("sourcingPolicy.ts")).toContain(
      'export type YoutubeLicenseMode = "creative_common" | "youtube" | "any";'
    );
    expect(read("videoPipeline.ts")).toContain(
      'export type { YoutubeLicenseMode } from "./sourcingPolicy";'
    );
  });
});

/* ═══════════════ 3. the cascade's passes ═══════════════ */

describe("the licence passes are ordered by what the project may use", () => {
  const PIPELINE = read("videoPipeline.ts");

  it("the widest pass runs first when the authorisation is in force", () => {
    /**
     * Every pass breaks on `fetched >= count` and on the render's download ceiling, so ordering
     * IS budget: a CC pass that fills the beat means the later passes never run at all. Putting
     * the unfiltered pass last therefore produced CC-only in practice — from an ordering rather
     * than from a rule.
     */
    expect(PIPELINE).toContain("const recallFirst = youtubeOperatorAuthorized();");
    expect(PIPELINE).toContain("if (recallFirst && youtubeFairUseEnabled()) licensePasses.push(anyPass);");
    expect(PIPELINE).toContain("if (!recallFirst && youtubeFairUseEnabled()) licensePasses.push(anyPass);");
  });

  it("the explicit standard-licence pass is on under the authorisation and opt-in without it", () => {
    expect(PIPELINE).toContain(
      'youtubeOperatorAuthorized()\n    ? envFlagIsNotOff("ENABLE_YOUTUBE_STANDARD_LICENSE")\n    : envFlagIsOn("ENABLE_YOUTUBE_STANDARD_LICENSE")'
    );
  });

  it("the licence-specific passes still run — they are what can name a licence", () => {
    /** `any` filters nothing, so a clip it returns can never honestly claim a reported licence. */
    expect(PIPELINE).toContain("licensePasses.push(ccPass);");
    expect(PIPELINE).toContain("licensePasses.push(stdPass);");
  });
});

/* ═══════════════ 4. a wider net is not a lower bar ═══════════════ */

describe("everything a candidate has to survive is untouched", () => {
  const PIPELINE = read("videoPipeline.ts");

  it("a downloaded clip is still judged on what it SHOWS — by the beat that will use it", () => {
    /**
     * This used to assert a pre-pool screening at download time. That screening is gone: it judged
     * against ONE beat's sentence and deleted the file for the whole scene, and its 24-judgement
     * slice was spent in arrival order before any ranking. What it was really guarding — that a
     * YouTube clip cannot reach the screen without the picture editor having looked at it — is
     * unchanged and is now enforced in one place instead of two.
     *
     * `beatClipRefusedByRelevanceGate` obtains a verdict for the clip against the sentence it is
     * about to run under (`finalSay: true`, which overrules the spend caps precisely because this
     * look decides something), and `composeBarrierAllows` turns away anything refused. See
     * youtubeIsJudgedWhereItIsUsed.test.ts.
     */
    expect(PIPELINE, "no clip is judged before it belongs to a beat")
      .not.toContain("youtubeClipPassesImageGate");
    expect(PIPELINE).toContain("beatClipRefusedByRelevanceGate(dedup, clipPath, scene.index");
    expect(PIPELINE).toContain("finalSay: true,");
  });

  it("the relevance floor and the person gate still run on every row", () => {
    expect(PIPELINE).toContain("if (requiredPersonName && !textMentionsPersonName(hay, requiredPersonName))");
    expect(PIPELINE).toContain("scoreVisualRelevance(hay, relevanceKeywords)");
  });

  it("an unfiltered result still claims NO licence — the policy widens retrieval, not the record", () => {
    const src = read("youtubePoolSource.ts");
    expect(src).toContain('license: mode === "any" ? null : mode');
    expect(src).toContain('...(mode === "creative_common" ? { reported: "creativeCommon" } : {})');
    expect(PIPELINE).toContain("license: youtubeLicenseMetadata(pass.license),");
  });

  it("the clip still gets its transform on adopt, and its lineage entry", () => {
    expect(PIPELINE).toContain("function clipRequiresFairUseTransform(filePath: string): boolean");
    expect(PIPELINE).toContain("/_ytfu_|_ytcc_|_archive_|_wikivid_|_septube_|_gdelt_/i");
    expect(PIPELINE).toContain('"youtube_cc",');
  });

  it("SEARCH_GATE_STRICT is not touched anywhere in this change", () => {
    /** A sourcing-policy round is exactly where a query-provenance gate gets loosened by accident. */
    expect(PIPELINE).not.toContain("SEARCH_GATE_STRICT=false");
    expect(read("sourcingPolicy.ts")).not.toContain("SEARCH_GATE_STRICT=false");
  });
});

/* ═══════════════ 5. the excerpt ceiling ═══════════════ */

describe("the five-second ceiling is a fair-use mitigation, and applies where fair use does", () => {
  it("an authorised project is not cut to five seconds by default", () => {
    expect(
      withEnv({ ALLOW_OPERATOR_LICENSED_YOUTUBE: undefined, FAIR_USE_YT_MAX_SEC: undefined }, () =>
        capYoutubeClipDurationForTest(7.5, "ytfu")
      )
    ).toBe(7.5);
  });

  it("withdrawing the authorisation restores the ceiling", () => {
    expect(
      withEnv({ ALLOW_OPERATOR_LICENSED_YOUTUBE: "false", FAIR_USE_YT_MAX_SEC: undefined }, () =>
        capYoutubeClipDurationForTest(7.5, "ytfu")
      )
    ).toBe(5);
  });

  it("an operator who sets the ceiling still gets it, authorised or not", () => {
    expect(
      withEnv({ ALLOW_OPERATOR_LICENSED_YOUTUBE: undefined, FAIR_USE_YT_MAX_SEC: "4" }, () =>
        capYoutubeClipDurationForTest(7.5, "ytfu")
      )
    ).toBe(4);
  });

  it("it never applied to the licence-named passes, and still does not", () => {
    for (const tag of ["ytcc", "ytstd"]) {
      expect(
        withEnv({ ALLOW_OPERATOR_LICENSED_YOUTUBE: "false" }, () =>
          capYoutubeClipDurationForTest(7.5, tag)
        ),
        tag
      ).toBe(7.5);
    }
  });
});
