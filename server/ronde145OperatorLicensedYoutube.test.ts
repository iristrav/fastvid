/**
 * RONDE 145 — the operator asserts rights the metadata cannot see.
 *
 * The FastVid owner states they have an agreement covering YouTube material and asked for the
 * REJECTED category to be opened on that basis. This round adds a second, separate flag for that
 * decision: `ALLOW_OPERATOR_LICENSED_YOUTUBE`, default off, YouTube-origin identifiers only.
 *
 * ── The line these tests hold ────────────────────────────────────────────────────────────────
 *
 * RONDE 124's founding rule is that nothing in this module claims a licence that the metadata does
 * not show. The override must not touch that rule, so the tests below are mostly about what did
 * NOT change:
 *
 *   · the CLASSIFICATION is untouched — a -nc/-nd licence still classifies as REJECTED;
 *   · the reports still print REJECTED, and print WHY it was used anyway;
 *   · with the flag off, behaviour is byte-for-byte what it was;
 *   · non-YouTube archive items are unaffected under either flag.
 *
 * Only the ACTION changes, and it is recorded as the operator's. If a rightsholder ever asks, the
 * log has to show that FastVid read the licence correctly, saw the refusal, and that a human
 * overrode it — not that an -nc licence was mistaken for permission.
 *
 * Worth stating plainly in the file that implements it: REJECTED means the UPLOADER chose
 * "non-commercial" or "no derivative works" on their own video. That choice belongs to the
 * uploader, not to the platform, and a platform-level agreement does not transfer it.
 */
import { describe, expect, it } from "vitest";

import {
  allowOperatorLicensedYoutube,
  classifyArchiveLicense,
  formatYoutubeLicenseLine,
  formatYoutubeUsageReport,
  youtubeLicenseDecision,
  type YoutubeUsageEntry,
} from "./youtubeLicenseStatus";

const NC = "https://creativecommons.org/licenses/by-nc-nd/4.0/";
const CC_BY = "https://creativecommons.org/licenses/by/4.0/";

/**
 * NARROWED BY RONDE 146, deliberately.
 *
 * RONDE 145 required only the flag, which made the override a blanket rule: with it on, every
 * `youtube-*` item whose licence said no was used. RONDE 146 added the second condition — the
 * asset has to be NAMED in `OPERATOR_LICENSED_YOUTUBE_IDS` — so `allowOperatorLicensed: true`
 * alone no longer allows anything.
 *
 * The helper therefore supplies the id list as well. Every assertion below is unchanged: they
 * were about what the override does to a cleared asset, and that is exactly what they still test.
 * RONDE 146's own file covers the case this one can no longer express — an armed flag against an
 * UNLISTED video, which must stay refused.
 */
const CLEARED_ID = "cS2JdEghHDo";

const decide = (over: Partial<Parameters<typeof youtubeLicenseDecision>[0]> = {}) =>
  youtubeLicenseDecision({
    identifier: `youtube-${CLEARED_ID}`,
    licenseUrl: NC,
    allowUnverified: false,
    allowOperatorLicensed: false,
    licensedIds: new Set([CLEARED_ID]),
    ...over,
  });

describe("RONDE 145 — the classification is untouched", () => {
  it("A. a -nc/-nd licence still classifies as REJECTED, flag or no flag", () => {
    // The flag must not reach classifyArchiveLicense: what the metadata says is a fact about the
    // metadata, not a setting.
    expect(classifyArchiveLicense(NC)).toBe("REJECTED");
    expect(classifyArchiveLicense("https://creativecommons.org/licenses/by-nc/4.0/")).toBe("REJECTED");
    expect(classifyArchiveLicense(null, "Non-Commercial use only")).toBe("REJECTED");
  });

  it("B. the decision carries REJECTED through even when it allows the item", () => {
    const d = decide({ allowOperatorLicensed: true });
    expect(d.status).toBe("REJECTED");
    expect(d.allowed).toBe(true);
    expect(d.action).toBe("ALLOW_OPERATOR_LICENSED_YOUTUBE");
    // The licence URL is echoed verbatim, never blanked to hide what it said.
    expect(d.licenseUrl).toBe(NC);
  });
});

describe("RONDE 145 — off by default, and the default is the old behaviour", () => {
  it("C. the flag is off unless explicitly set to true", () => {
    const prev = process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE;
    try {
      delete process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE;
      expect(allowOperatorLicensedYoutube()).toBe(false);
      process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE = "";
      expect(allowOperatorLicensedYoutube()).toBe(false);
      process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE = "1";
      expect(allowOperatorLicensedYoutube()).toBe(false);
      process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE = "yes";
      expect(allowOperatorLicensedYoutube()).toBe(false);
      process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE = "true";
      expect(allowOperatorLicensedYoutube()).toBe(true);
      process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE = "TRUE";
      expect(allowOperatorLicensedYoutube()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE;
      else process.env.ALLOW_OPERATOR_LICENSED_YOUTUBE = prev;
    }
  });

  it("D. with the flag off, an explicit refusal is still a refusal", () => {
    const d = decide();
    expect(d.status).toBe("REJECTED");
    expect(d.action).toBe("REJECT");
    expect(d.allowed).toBe(false);
  });

  it("E. the two flags are independent — the unverified one does not open REJECTED", () => {
    // This is the mistake that would quietly widen the override: reusing one switch for both.
    const d = decide({ allowUnverified: true, allowOperatorLicensed: false });
    expect(d.allowed).toBe(false);
    expect(d.action).toBe("REJECT");
  });

  it("F. nor does the operator flag open anything the unverified flag governs", () => {
    const d = youtubeLicenseDecision({
      identifier: "youtube-abc",
      licenseUrl: null,
      rights: null,
      allowUnverified: false,
      allowOperatorLicensed: true,
    });
    expect(d.status).toBe("UNVERIFIED");
    expect(d.allowed).toBe(false);
  });
});

describe("RONDE 145 — the override is narrow", () => {
  it("G. a non-YouTube archive item is never opened by the flag", () => {
    const d = youtubeLicenseDecision({
      identifier: "some-other-archive-item",
      licenseUrl: NC,
      allowOperatorLicensed: true,
    });
    expect(d.status).toBe("REJECTED");
    expect(d.allowed).toBe(false);
    expect(d.youtubeVideoId).toBeNull();
  });

  it("H. a VERIFIED item is unaffected — it was already allowed, on its own licence", () => {
    const d = decide({ licenseUrl: CC_BY, allowOperatorLicensed: true });
    expect(d.status).toBe("VERIFIED");
    expect(d.action).toBe("ALLOW");
  });
});

describe("RONDE 145 — the record says what actually happened", () => {
  it("I. the log line states the licence forbids it and who decided otherwise", () => {
    /**
     * REWORDED BY RONDE 146, not weakened.
     *
     * The message used to name -nc/-nd specifically. RONDE 146 keys it on the BASIS instead, so
     * the same warning covers an operator-cleared UNVERIFIED item too, and it now names the id
     * list that authorised it. Both guarantees this test was written for are asserted below in
     * the new wording: the metadata's refusal is stated, and the authority is not FastVid's.
     */
    const line = formatYoutubeLicenseLine(decide({ allowOperatorLicensed: true }));
    expect(line).toContain("status=REJECTED");
    expect(line).toContain("action=ALLOW_OPERATOR_LICENSED_YOUTUBE");
    expect(line).toContain("archive metadata says REJECTED");
    // The crucial half: it must not read as something FastVid — or YouTube — established.
    expect(line).toContain("NOT any right FastVid or YouTube verified");
    expect(line).toContain("source=operator");
    expect(line).toContain(NC);
  });

  it("J. a refused item's line is unchanged", () => {
    const line = formatYoutubeLicenseLine(decide());
    expect(line).toContain("action=REJECT");
    expect(line).not.toContain("operator");
  });

  it("K. the usage report flags every REJECTED item that reached the film", () => {
    const entry: YoutubeUsageEntry = {
      sceneIndex: 2,
      beatIndex: 1,
      youtubeVideoId: "cS2JdEghHDo",
      title: "Göring at Nuremberg",
      licenseStatus: "REJECTED",
      // RONDE 146: the marker is keyed on the basis now, so the entry has to carry it. An item
      // that reached the film with status REJECTED can only have got there this way.
      licenseBasis: "operator_assertion",
      licenseUrl: NC,
      rights: null,
      previewStatus: "ok",
      visionVerdict: "fits",
    };
    const report = formatYoutubeUsageReport([entry]);
    expect(report).toContain("licenseStatus=REJECTED");
    expect(report).toContain("archive metadata says REJECTED");
    expect(report).toContain("ALLOW_OPERATOR_LICENSED_YOUTUBE");
    expect(report).toContain("FastVid verified no right to it");
    // Findable in one pass by someone doing a rights check.
    expect(report).toContain("⛔");
  });

  it("L. an UNVERIFIED item keeps its own, weaker warning — the two are not merged", () => {
    const report = formatYoutubeUsageReport([
      {
        sceneIndex: 0, beatIndex: 0, youtubeVideoId: "abc",
        licenseStatus: "UNVERIFIED", licenseUrl: null, rights: null,
        previewStatus: "ok", visionVerdict: "fits",
      },
    ]);
    expect(report).toContain("rights NOT verified by FastVid");
    expect(report).not.toContain("⛔");
  });
});

describe("RONDE 145 — both sourcing routes go through the one decision", () => {
  it("M. the pipeline and the scene pool both gate on `.allowed`", () => {
    // There are two copies of the archive licence check. Neither may grow its own override.
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const pipe = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const pool = fs.readFileSync(path.join(__dirname, "scenePool.ts"), "utf8");
    expect(pipe).toContain("if (!licenseDecision.allowed) {");
    expect(pool).toContain("if (!poolLicense.allowed) continue;");
    // Neither file reads the environment variable itself — the decision lives in one module.
    expect(pipe).not.toContain("ALLOW_OPERATOR_LICENSED_YOUTUBE");
    expect(pool).not.toContain("ALLOW_OPERATOR_LICENSED_YOUTUBE");
  });
});
