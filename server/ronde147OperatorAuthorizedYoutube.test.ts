/**
 * RONDE 147 — the operator's blanket YouTube authorisation.
 *
 * ── What changed, and why this file replaces RONDE 146's ─────────────────────────────────────
 *
 * RONDE 146 required a per-video whitelist: `ALLOW_OPERATOR_LICENSED_YOUTUBE=true` armed the
 * mechanism and `OPERATOR_LICENSED_YOUTUBE_IDS` named the assets it applied to. The FastVid owner
 * has since withdrawn that requirement — they hold authorisation for YouTube content as a whole,
 * so maintaining a list per clip is not the rule they want enforced.
 *
 * The whitelist and its tests are therefore GONE rather than left dead. Two files were retired,
 * both because they asserted the withdrawn requirement rather than because they were failing:
 *
 *     ronde146OperatorLicensedYoutubeScope.test.ts   the whitelist, in full
 *     ronde145OperatorLicensedYoutube.test.ts        the flag as R145/R146 defined it
 *
 * Nothing they guarded is lost — every one of their assertions has a stronger counterpart here:
 * the default being off is §1a, the untouched classifier is §6b, the licence URL echoed verbatim
 * is §6b, the provider scope is §4, and the "never presented as VERIFIED" rule they existed for
 * is §6, which is now enforceable because the override has its own status rather than borrowing
 * one. Deleting a superseded guard and restating it is how this repo has handled withdrawn rules
 * since RONDE 103; silently leaving it green would have been the alternative, and worse.
 *
 * ── The rule now ─────────────────────────────────────────────────────────────────────────────
 *
 *     ALLOW_OPERATOR_LICENSED_YOUTUBE=false   (default)  RONDE 124's flow, untouched
 *     ALLOW_OPERATOR_LICENSED_YOUTUBE=true               every youtube-* item is allowed
 *
 * ── The line this file exists to hold ────────────────────────────────────────────────────────
 *
 * "The operator permits this" and "the licence was verified" are different claims, and the second
 * is the one that would be false. So the override produces its OWN status:
 *
 *     status           OPERATOR_AUTHORIZED     never VERIFIED
 *     metadataStatus   what the archive said   preserved, whatever the decision concluded
 *     operatorAuthorized                       true only when the override carried it
 *
 * VERIFIED remains reachable only through the verification flow that earns it. §6 is the test
 * that says so, and the mutation suite at the end breaks if anyone collapses the two.
 */
import { describe, expect, it } from "vitest";

import {
  allowOperatorLicensedYoutube,
  classifyArchiveLicense,
  formatYoutubeLicenseLine,
  formatYoutubeUsageReport,
  isOperatorAuthorizedYoutube,
  isYoutubeOriginIdentifier,
  youtubeLicenseDecision,
  youtubeVideoIdFromIdentifier,
} from "./youtubeLicenseStatus";

const NC = "https://creativecommons.org/licenses/by-nc-nd/4.0/";
const CC_BY = "https://creativecommons.org/licenses/by/4.0/";

/** Two unrelated YouTube videos — neither is special, which is the point of §3. */
const VIDEO_A = "cS2JdEghHDo";
const VIDEO_B = "zUU-LNi7FBc";

const decide = (over: Partial<Parameters<typeof youtubeLicenseDecision>[0]> = {}) =>
  youtubeLicenseDecision({
    identifier: `youtube-${VIDEO_A}`,
    licenseUrl: NC,
    allowUnverified: false,
    allowOperatorLicensed: false,
    ...over,
  });

// ─── 1 ───────────────────────────────────────────────────────────────────────────────────────

describe("RONDE 147 §1 — flag off: RONDE 124's flow, unchanged", () => {
  it("1a. the default is false", () => {
    const prev = process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE;
    try {
      delete process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE;
      expect(allowOperatorLicensedYoutube()).toBe(false);
      for (const v of ["", "1", "yes", "on", "false", "FALSE"]) {
        process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE = v;
        expect(allowOperatorLicensedYoutube(), `"${v}" must not arm the override`).toBe(false);
      }
      for (const v of ["true", "TRUE", " true "]) {
        process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE = v;
        expect(allowOperatorLicensedYoutube()).toBe(true);
      }
    } finally {
      if (prev === undefined) delete process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE;
      else process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE = prev;
    }
  });

  it("1b. a REJECTED YouTube item stays refused", () => {
    const d = decide();
    expect(d.status).toBe("REJECTED");
    expect(d.allowed).toBe(false);
    expect(d.operatorAuthorized).toBe(false);
  });

  it("1c. VERIFIED still passes on its own licence, with no operator involvement", () => {
    const d = decide({ licenseUrl: CC_BY });
    expect(d.status).toBe("VERIFIED");
    expect(d.action).toBe("ALLOW");
    expect(d.operatorAuthorized).toBe(false);
    expect(d.licenseBasis).toBe("archive_metadata");
  });
});

// ─── 2 and 3 ─────────────────────────────────────────────────────────────────────────────────

describe("RONDE 147 §2/§3 — flag on: every YouTube clip, no whitelist", () => {
  it("2. an arbitrary YouTube clip is allowed", () => {
    const d = decide({ allowOperatorLicensed: true });
    expect(d.allowed).toBe(true);
    expect(d.action).toBe("ALLOW_OPERATOR_LICENSED_YOUTUBE");
    expect(d.operatorAuthorized).toBe(true);
  });

  it("3. a SECOND, unrelated YouTube clip is allowed too — there is no list", () => {
    // The two videos share nothing. If either needed naming somewhere, this fails.
    for (const id of [VIDEO_A, VIDEO_B, "dQw4w9WgXcQ", "abc_123-XYZ"]) {
      const d = decide({ identifier: `youtube-${id}`, allowOperatorLicensed: true });
      expect(d.allowed, id).toBe(true);
      expect(d.operatorAuthorized, id).toBe(true);
    }
  });

  it("3b. it applies whatever the metadata said — REJECTED and UNVERIFIED alike", () => {
    const rejected = decide({ allowOperatorLicensed: true });
    expect(rejected.metadataStatus).toBe("REJECTED");
    expect(rejected.allowed).toBe(true);

    const unverified = decide({ licenseUrl: null, rights: null, allowOperatorLicensed: true });
    expect(unverified.metadataStatus).toBe("UNVERIFIED");
    expect(unverified.allowed).toBe(true);
  });
});

// ─── 4 and 5 ─────────────────────────────────────────────────────────────────────────────────

describe("RONDE 147 §4/§5 — the override is YouTube-only", () => {
  const OTHER_PROVIDERS = [
    ["pexels", "pexels-12345"],
    ["pixabay", "pixabay-98765"],
    ["wikimedia", "commons-Bundesarchiv_Bild_183"],
    ["internet archive", "some-ordinary-archive-item"],
    ["NARA", "nara-12345678"],
    ["LOC", "loc-mss12345"],
    ["near-miss", "youtubelike-notactually"],
  ] as const;

  it("4/5. no other provider is affected, with the flag on", () => {
    for (const [name, identifier] of OTHER_PROVIDERS) {
      const d = youtubeLicenseDecision({
        identifier,
        licenseUrl: NC,
        allowUnverified: true,
        allowOperatorLicensed: true,
      });
      expect(d.allowed, `${name} must stay refused`).toBe(false);
      expect(d.action, name).toBe("REJECT");
      expect(d.operatorAuthorized, name).toBe(false);
      expect(d.status, name).toBe("REJECTED");
    }
  });

  it("4b. the predicate itself refuses them", () => {
    for (const [name, identifier] of OTHER_PROVIDERS) {
      expect(
        isOperatorAuthorizedYoutube({ identifier, allowOperatorLicensed: true }),
        name
      ).toBe(false);
    }
    expect(
      isOperatorAuthorizedYoutube({
        identifier: `youtube-${VIDEO_A}`,
        allowOperatorLicensed: true,
      })
    ).toBe(true);
  });

  /**
   * The scope is enforced by one regex, expressed in two helpers. Both are pinned directly:
   * removing either guard alone changes no behaviour (they agree by construction), so an
   * end-to-end test cannot see it — but a weakening of the regex itself fails here.
   */
  it("4c. isYoutubeOriginIdentifier is true only for the youtube- prefix", () => {
    for (const [name, identifier] of OTHER_PROVIDERS) {
      expect(isYoutubeOriginIdentifier(identifier), name).toBe(false);
    }
    expect(isYoutubeOriginIdentifier(`youtube-${VIDEO_A}`)).toBe(true);
    expect(isYoutubeOriginIdentifier(`youtube_${VIDEO_A}`)).toBe(true);
    expect(isYoutubeOriginIdentifier(null)).toBe(false);
  });

  it("4d. youtubeVideoIdFromIdentifier yields an id only for the youtube- prefix", () => {
    for (const [name, identifier] of OTHER_PROVIDERS) {
      expect(youtubeVideoIdFromIdentifier(identifier), name).toBeNull();
    }
    expect(youtubeVideoIdFromIdentifier(`youtube-${VIDEO_A}`)).toBe(VIDEO_A);
  });
});

// ─── 6 ───────────────────────────────────────────────────────────────────────────────────────

describe("RONDE 147 §6 — OPERATOR_AUTHORIZED is not VERIFIED", () => {
  it("6a. the override's status is OPERATOR_AUTHORIZED", () => {
    const d = decide({ allowOperatorLicensed: true });
    expect(d.status).toBe("OPERATOR_AUTHORIZED");
    expect(d.status).not.toBe("VERIFIED");
  });

  it("6b. the metadata's own verdict survives the override", () => {
    const d = decide({ allowOperatorLicensed: true });
    expect(d.metadataStatus).toBe("REJECTED");
    // R124: the classifier never sees a flag, so what it says cannot depend on one.
    expect(classifyArchiveLicense(NC)).toBe("REJECTED");
    expect(classifyArchiveLicense(null, null)).toBe("UNVERIFIED");
    // And the URL is echoed verbatim, never blanked or invented.
    expect(d.licenseUrl).toBe(NC);
    expect(decide({ licenseUrl: null, allowOperatorLicensed: true }).licenseUrl).toBeNull();
  });

  it("6c. the override cannot manufacture a VERIFIED anywhere", () => {
    for (const licenseUrl of [NC, null, "https://example.invalid/unknown"]) {
      const d = decide({ licenseUrl, allowOperatorLicensed: true });
      if (d.operatorAuthorized) expect(d.status).not.toBe("VERIFIED");
    }
  });

  it("6d. VERIFIED still means the verification flow said so", () => {
    const d = decide({ licenseUrl: CC_BY, allowOperatorLicensed: true });
    expect(d.status).toBe("VERIFIED");
    // Not the override's doing: an item allowed on its own licence keeps the archive as basis.
    expect(d.operatorAuthorized).toBe(false);
    expect(d.licenseBasis).toBe("archive_metadata");
  });
});

// ─── 7 ───────────────────────────────────────────────────────────────────────────────────────

describe("RONDE 147 §7 — flag off, UNVERIFIED YouTube follows the normal rules", () => {
  const unverified = (over: Partial<Parameters<typeof youtubeLicenseDecision>[0]>) =>
    youtubeLicenseDecision({
      identifier: `youtube-${VIDEO_A}`,
      licenseUrl: null,
      rights: null,
      allowOperatorLicensed: false,
      ...over,
    });

  it("7a. refused when ALLOW_UNVERIFIED_YOUTUBE is off", () => {
    const d = unverified({ allowUnverified: false });
    expect(d.status).toBe("UNVERIFIED");
    expect(d.allowed).toBe(false);
  });

  it("7b. allowed when ALLOW_UNVERIFIED_YOUTUBE is on — and it is NOT operator authorisation", () => {
    const d = unverified({ allowUnverified: true });
    expect(d.action).toBe("ALLOW_UNVERIFIED_YOUTUBE");
    expect(d.status).toBe("UNVERIFIED");
    expect(d.operatorAuthorized).toBe(false);
    expect(d.licenseBasis).toBe("archive_metadata");
  });

  it("7c. the two flags stay independent", () => {
    // The unverified flag must not open REJECTED...
    expect(decide({ allowUnverified: true, allowOperatorLicensed: false }).allowed).toBe(false);
    // ...and the operator flag is the one that does.
    expect(decide({ allowUnverified: false, allowOperatorLicensed: true }).allowed).toBe(true);
  });
});

// ─── logging ─────────────────────────────────────────────────────────────────────────────────

describe("RONDE 147 — the log says who authorised it", () => {
  it("L1. the override's line carries the fields the operator asked for", () => {
    const line = formatYoutubeLicenseLine(decide({ allowOperatorLicensed: true }));
    expect(line).toContain("provider=youtube");
    expect(line).toContain("status=OPERATOR_AUTHORIZED");
    expect(line).toContain("operatorAuthorized=true");
    expect(line).toContain("source=operator");
    expect(line).toContain("archive metadata says REJECTED");
    expect(line).toContain("NOT verified by FastVid and NOT verified by YouTube");
  });

  it("L2. licenseUrl=null is preserved rather than filled in", () => {
    const line = formatYoutubeLicenseLine(
      decide({ licenseUrl: null, rights: null, allowOperatorLicensed: true })
    );
    expect(line).toContain("licenseUrl=null");
    expect(line).toContain("status=OPERATOR_AUTHORIZED");
  });

  it("L3. no line ever pairs VERIFIED with the operator as its source", () => {
    for (const d of [
      decide({ allowOperatorLicensed: true }),
      decide({ licenseUrl: CC_BY, allowOperatorLicensed: true }),
      decide({ licenseUrl: null, allowUnverified: true }),
      decide(),
    ]) {
      const line = formatYoutubeLicenseLine(d);
      expect(line).toMatch(/operatorAuthorized=(true|false)/);
      if (line.includes("operatorAuthorized=true")) {
        expect(line).not.toContain("status=VERIFIED");
      }
    }
  });

  it("L4. an operator-authorised item is marked in the usage report", () => {
    const report = formatYoutubeUsageReport([
      {
        sceneIndex: 2, beatIndex: 1, youtubeVideoId: VIDEO_A,
        licenseStatus: "OPERATOR_AUTHORIZED", licenseBasis: "operator_assertion",
        licenseUrl: null, rights: null, previewStatus: "ok", visionVerdict: "fits",
      },
    ]);
    expect(report).toContain("licenseStatus=OPERATOR_AUTHORIZED");
    expect(report).toContain("source=operator");
    expect(report).toContain("not VERIFIED");
    expect(report).toContain("⛔");
  });
});

// ─── the pipeline reads the decision, not the environment ────────────────────────────────────

describe("RONDE 147 — one decision, no second engine", () => {
  it("P1. both sourcing routes gate on `.allowed` and read no flag of their own", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const pipe = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const pool = fs.readFileSync(path.join(__dirname, "scenePool.ts"), "utf8");
    expect(pipe).toContain("if (!licenseDecision.allowed) {");
    expect(pool).toContain("if (!poolLicense.allowed) continue;");
    for (const src of [pipe, pool]) {
      expect(src).not.toContain("ALLOW_OPERATOR_LICENSED_YOUTUBE");
    }
  });

  it("P2. the licence counters read the metadata, not the decision's conclusion", () => {
    /**
     * Left on `status`, the else-branch would book every operator-authorised item as a licence
     * REJECTION, and the provider table would report mass refusals on a render that used the
     * footage. This is the one place the new status could have corrupted an existing number.
     */
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const pipe = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(pipe).toContain('licenseDecision.metadataStatus === "VERIFIED"');
    expect(pipe).toContain('licenseDecision.metadataStatus === "UNVERIFIED"');
    expect(pipe).not.toContain('licenseDecision.status === "VERIFIED"');
  });

  it("P3. the withdrawn whitelist is gone from the codebase, not merely unused", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const dir = __dirname;
    // Production files only: this very test file names the withdrawn variable in order to assert
    // its absence, and the comment above does too.
    const hits = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) =>
        fs.readFileSync(path.join(dir, f), "utf8").includes("OPERATOR_LICENSED_YOUTUBE_IDS")
      );
    expect(hits).toEqual([]);
  });
});
