/**
 * RONDE 141 — the authorisation the owner actually gave, made the default.
 *
 * ── Why this file exists separately ──────────────────────────────────────────────────────────
 *
 * RONDE 147 built the operator's blanket YouTube authorisation and left it switched off, because
 * an authorisation is not something code may assume. The FastVid owner has since given it in so
 * many words — "hij mag gewoon alles van het web en van youtube halen, ik heb daar akkoord voor" —
 * so the switch now defaults on.
 *
 * That flip inverted one assertion in ronde147 and required three RONDE 124 tests to pin the flag
 * they were actually about. Both edits are the kind that can hide a behaviour change inside a
 * test-file diff, so the change itself is asserted HERE, at the default, with nothing injected:
 * what a render now does that it did not do yesterday, in one file a person can read.
 *
 * ── What did NOT change, and is asserted below just as hard ──────────────────────────────────
 *
 * The record. `metadataStatus` still carries what the archive said, the status is
 * OPERATOR_AUTHORIZED and never VERIFIED, and the usage report still marks every one of these with
 * ⛔ and the sentence saying FastVid verified no right to it. The owner's decision changed; what
 * FastVid knows and writes down did not.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  allowOperatorLicensedYoutube,
  formatYoutubeLicenseLine,
  formatYoutubeUsageReport,
  youtubeLicenseDecision,
} from "./youtubeLicenseStatus";

const NC_ND = "https://creativecommons.org/licenses/by-nc-nd/4.0/";
const CC_BY = "https://creativecommons.org/licenses/by/4.0/";
const YT = "youtube-cS2JdEghHDo";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE;
  // The whole point: NOTHING is set. This is what a deployment that never heard of the flag does.
  delete process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE;
});
afterEach(() => {
  if (saved === undefined) delete process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE;
  else process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE = saved;
});

describe("RONDE 141 §1 — with nothing configured, YouTube material is used", () => {
  it("the authorisation is in force out of the box", () => {
    expect(allowOperatorLicensedYoutube()).toBe(true);
  });

  it("THE CHANGE: a -nc-nd YouTube item is now allowed, where yesterday it was refused", () => {
    /**
     * This is the exact case from the production log that started RONDE 124: 56 archive items
     * refused with `licenseurl=none, rights=none`, plus the ones whose uploader chose -nc or -nd.
     * They are now used, on the owner's authorisation, and the decision says so in every field.
     */
    const d = youtubeLicenseDecision({ identifier: YT, licenseUrl: NC_ND });
    expect(d.allowed).toBe(true);
    expect(d.action).toBe("ALLOW_OPERATOR_LICENSED_YOUTUBE");
    expect(d.operatorAuthorized).toBe(true);
    expect(d.licenseBasis).toBe("operator_assertion");
  });

  it("an item with no licence metadata at all is allowed too", () => {
    const d = youtubeLicenseDecision({ identifier: YT });
    expect(d.allowed).toBe(true);
    expect(d.metadataStatus).toBe("UNVERIFIED");
    expect(d.operatorAuthorized).toBe(true);
  });

  it("`false` still switches the whole thing off, in one variable", () => {
    process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE = "false";
    const d = youtubeLicenseDecision({ identifier: YT, licenseUrl: NC_ND });
    expect(d.allowed).toBe(false);
    expect(d.action).toBe("REJECT");
    expect(d.operatorAuthorized).toBe(false);
  });
});

describe("RONDE 141 §2 — the record is exactly as complete as it was", () => {
  it("the status is OPERATOR_AUTHORIZED and never VERIFIED", () => {
    const d = youtubeLicenseDecision({ identifier: YT, licenseUrl: NC_ND });
    expect(d.status).toBe("OPERATOR_AUTHORIZED");
    expect(d.status).not.toBe("VERIFIED");
  });

  it("what the archive said survives the override, verbatim", () => {
    // The evidence the owner overrode has to remain recoverable, or a later rights check has
    // nothing to check against.
    expect(youtubeLicenseDecision({ identifier: YT, licenseUrl: NC_ND }).metadataStatus).toBe(
      "REJECTED"
    );
    expect(youtubeLicenseDecision({ identifier: YT }).metadataStatus).toBe("UNVERIFIED");
    expect(youtubeLicenseDecision({ identifier: YT, licenseUrl: NC_ND }).licenseUrl).toBe(NC_ND);
  });

  it("an item that passes on its OWN licence is not relabelled as an override", () => {
    // Rule 3 is checked last on purpose: something that never needed overriding must keep the
    // record of why it was usable.
    const d = youtubeLicenseDecision({ identifier: YT, licenseUrl: CC_BY });
    expect(d.status).toBe("VERIFIED");
    expect(d.action).toBe("ALLOW");
    expect(d.operatorAuthorized).toBe(false);
    expect(d.licenseBasis).toBe("archive_metadata");
  });

  it("the log line still names the authority, and never claims a licence", () => {
    const line = formatYoutubeLicenseLine(
      youtubeLicenseDecision({ identifier: YT, licenseUrl: NC_ND })
    );
    expect(line).toContain("status=OPERATOR_AUTHORIZED");
    expect(line).toContain("operatorAuthorized=true");
    expect(line).toContain("source=operator");
    expect(line).toContain("NOT verified by FastVid");
    expect(line).not.toContain("status=VERIFIED");
  });

  it("the usage report still flags every operator-authorised clip with ⛔", () => {
    const report = formatYoutubeUsageReport([
      {
        sceneIndex: 2,
        beatIndex: 1,
        youtubeVideoId: "cS2JdEghHDo",
        licenseStatus: "OPERATOR_AUTHORIZED",
        licenseBasis: "operator_assertion",
        licenseUrl: NC_ND,
        rights: null,
        previewStatus: "ok",
        visionVerdict: "fits",
      },
    ]);
    expect(report).toContain("⛔");
    expect(report).toContain("not VERIFIED");
    expect(report).toContain("source=operator");
  });
});

describe("RONDE 141 §3 — the scope did not widen with the default", () => {
  it("a non-YouTube archive item is untouched, under every setting", () => {
    /**
     * The line that keeps this honest. The owner authorised YouTube and the open web; a museum
     * item whose uploader marked it -nc is neither, and it stays refused. Asserted at the default
     * BECAUSE the default moved — a flag that quietly started covering everything would be the
     * failure mode worth catching here.
     */
    for (const id of ["SomeNewsreel1943", "nara-12345", "wikimedia-file", "pexels-1"]) {
      const d = youtubeLicenseDecision({ identifier: id, licenseUrl: NC_ND });
      expect(d.allowed, id).toBe(false);
      expect(d.operatorAuthorized, id).toBe(false);
      expect(d.status, id).toBe("REJECTED");
    }
  });

  it("a non-YouTube item with no metadata is still refused, not swept in", () => {
    const d = youtubeLicenseDecision({ identifier: "SomeNewsreel1943" });
    expect(d.allowed).toBe(false);
    expect(d.metadataStatus).toBe("UNVERIFIED");
    expect(d.youtubeVideoId).toBeNull();
  });
});

describe("RONDE 141 §4 — the switch reads the one word that means off", () => {
  it("a typo cannot silently disable an authorisation that was given", () => {
    for (const v of ["no", "off", "0", "nee", "", "true"]) {
      process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE = v;
      expect(allowOperatorLicensedYoutube(), `"${v}" disabled the authorisation`).toBe(true);
    }
    for (const v of ["false", "FALSE", " False "]) {
      process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE = v;
      expect(allowOperatorLicensedYoutube(), `"${v}" did not switch it off`).toBe(false);
    }
  });
});
