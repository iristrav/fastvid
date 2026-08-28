/**
 * RONDE 146 — the operator override, narrowed to the assets the operator actually cleared.
 *
 * ── What was wrong with RONDE 145 ────────────────────────────────────────────────────────────
 *
 * RONDE 145 shipped the flag alone. With `ALLOW_OPERATOR_LICENSED_YOUTUBE=true`, EVERY
 * `youtube-*` item whose licence said no was used — a general YouTube bypass inside the REJECTED
 * category. An override means "a human looked at this and cleared it"; a flag that clears
 * everything is not that.
 *
 * RONDE 146 requires two things instead of one:
 *
 *     ALLOW_OPERATOR_LICENSED_YOUTUBE=true       the mechanism is armed
 *     OPERATOR_LICENSED_YOUTUBE_IDS=<ids>        this asset was named in it
 *
 * An empty list allows nothing, however the flag is set. That is the whole point of the round.
 *
 * ── And the record has to say who decided ────────────────────────────────────────────────────
 *
 * `licenseBasis` is separate from `status` so a report can never read as though the platform
 * supplied a right it did not. `status` is what the metadata showed; `source=operator` is who
 * overrode it. Reading one without the other must not be enough to conclude anything.
 */
import { describe, expect, it } from "vitest";

import {
  classifyArchiveLicense,
  formatYoutubeLicenseLine,
  formatYoutubeUsageReport,
  isOperatorLicensedYoutubeAsset,
  isYoutubeOriginIdentifier,
  operatorLicensedYoutubeIds,
  youtubeLicenseDecision,
  youtubeVideoIdFromIdentifier,
  type YoutubeUsageEntry,
} from "./youtubeLicenseStatus";

const NC = "https://creativecommons.org/licenses/by-nc-nd/4.0/";
const CC_BY = "https://creativecommons.org/licenses/by/4.0/";
const CLEARED = "cS2JdEghHDo";
const NOT_CLEARED = "zUU-LNi7FBc";
const ids = (...v: string[]) => new Set(v);

/** The operator has armed the mechanism and cleared exactly one video. */
const armed = (over: Partial<Parameters<typeof youtubeLicenseDecision>[0]> = {}) =>
  youtubeLicenseDecision({
    identifier: `youtube-${CLEARED}`,
    licenseUrl: NC,
    allowUnverified: false,
    allowOperatorLicensed: true,
    licensedIds: ids(CLEARED),
    ...over,
  });

// ─── TEST A ──────────────────────────────────────────────────────────────────────────────────

describe("RONDE 146 TEST A — flag off, the ordinary rules still hold", () => {
  it("A1. a REJECTED YouTube item stays refused even when it is on the list", () => {
    const d = armed({ allowOperatorLicensed: false });
    expect(d.status).toBe("REJECTED");
    expect(d.action).toBe("REJECT");
    expect(d.allowed).toBe(false);
    expect(d.licenseBasis).toBe("archive_metadata");
  });

  it("A2. an UNVERIFIED item still obeys ALLOW_UNVERIFIED_YOUTUBE, not the operator flag", () => {
    const base = {
      identifier: `youtube-${CLEARED}`,
      licenseUrl: null,
      rights: null,
      allowOperatorLicensed: false,
      licensedIds: ids(CLEARED),
    };
    expect(youtubeLicenseDecision({ ...base, allowUnverified: false }).allowed).toBe(false);
    const on = youtubeLicenseDecision({ ...base, allowUnverified: true });
    expect(on.action).toBe("ALLOW_UNVERIFIED_YOUTUBE");
    // Still the archive's basis: ALLOW_UNVERIFIED_YOUTUBE is not an operator clearance.
    expect(on.licenseBasis).toBe("archive_metadata");
  });

  it("A3. a VERIFIED item is allowed on its own licence, with the archive as the basis", () => {
    const d = armed({ licenseUrl: CC_BY });
    expect(d.status).toBe("VERIFIED");
    expect(d.action).toBe("ALLOW");
    // Naming a video the operator did not need to clear must not rewrite why it was usable.
    expect(d.licenseBasis).toBe("archive_metadata");
  });
});

// ─── TEST B ──────────────────────────────────────────────────────────────────────────────────

describe("RONDE 146 TEST B — a named asset can be allowed by the operator rule", () => {
  it("B1. flag on plus id listed allows it, and records the operator as the authority", () => {
    const d = armed();
    expect(d.allowed).toBe(true);
    expect(d.action).toBe("ALLOW_OPERATOR_LICENSED_YOUTUBE");
    expect(d.licenseBasis).toBe("operator_assertion");
    // R124 intact: the status is still what the metadata said, and the URL is echoed verbatim.
    expect(d.status).toBe("REJECTED");
    expect(d.licenseUrl).toBe(NC);
  });

  it("B2. the list accepts bare ids and full youtube- identifiers alike", () => {
    expect(operatorLicensedYoutubeIds(`${CLEARED}, youtube-${NOT_CLEARED}`))
      .toEqual(new Set([CLEARED, NOT_CLEARED]));
    // Commas, spaces and newlines are all separators — the value gets pasted from many places.
    expect(operatorLicensedYoutubeIds(`  ${CLEARED}\n ${NOT_CLEARED}  `))
      .toEqual(new Set([CLEARED, NOT_CLEARED]));
    expect(operatorLicensedYoutubeIds("")).toEqual(new Set());
    expect(operatorLicensedYoutubeIds(null)).toEqual(new Set());
  });

  it("B3. an operator-cleared UNVERIFIED item is allowed too, and says so", () => {
    const d = armed({ licenseUrl: null, rights: null });
    expect(d.status).toBe("UNVERIFIED");
    expect(d.action).toBe("ALLOW_OPERATOR_LICENSED_YOUTUBE");
    expect(d.licenseBasis).toBe("operator_assertion");
  });
});

// ─── TEST C ──────────────────────────────────────────────────────────────────────────────────

describe("RONDE 146 TEST C — no other provider can reach the override", () => {
  const NON_YOUTUBE = [
    "pexels-12345",
    "pixabay-98765",
    "commons-Bundesarchiv_Bild_183",
    "some-ordinary-archive-item",
    "nasa-apollo11",
    "youtubelike-notactually",
  ];

  it("C1. a non-YouTube identifier is never opened, even when its id is on the list", () => {
    for (const identifier of NON_YOUTUBE) {
      const d = youtubeLicenseDecision({
        identifier,
        licenseUrl: NC,
        allowOperatorLicensed: true,
        // The id list is deliberately stuffed with the identifier itself, to prove the
        // youtube-origin check is what stops it and not a lookup miss.
        licensedIds: ids(identifier, CLEARED),
      });
      expect(d.allowed, `${identifier} must stay refused`).toBe(false);
      expect(d.action).toBe("REJECT");
      expect(d.licenseBasis).toBe("archive_metadata");
    }
  });

  it("C2. the predicate refuses non-YouTube assets directly", () => {
    for (const identifier of NON_YOUTUBE) {
      expect(
        isOperatorLicensedYoutubeAsset({
          identifier,
          allowOperatorLicensed: true,
          licensedIds: ids(identifier),
        })
      ).toBe(false);
    }
  });

  /**
   * C3/C4 — the two scope primitives, pinned separately.
   *
   * `isOperatorLicensedYoutubeAsset` checks the origin twice over: once explicitly, and once by
   * requiring `youtubeVideoIdFromIdentifier` to yield an id, which only a `youtube-*` identifier
   * does. That redundancy is deliberate defence-in-depth, but it means a mutation removing either
   * ONE of them changes no behaviour and no end-to-end test can see it. So both primitives are
   * asserted directly here: whichever half a future edit weakens, one of these fails.
   */
  it("C3. isYoutubeOriginIdentifier is true only for the youtube- prefix", () => {
    for (const identifier of NON_YOUTUBE) {
      expect(isYoutubeOriginIdentifier(identifier), identifier).toBe(false);
    }
    expect(isYoutubeOriginIdentifier(`youtube-${CLEARED}`)).toBe(true);
    expect(isYoutubeOriginIdentifier(`youtube_${CLEARED}`)).toBe(true);
    expect(isYoutubeOriginIdentifier(null)).toBe(false);
    expect(isYoutubeOriginIdentifier("")).toBe(false);
  });

  it("C4. youtubeVideoIdFromIdentifier yields an id only for the youtube- prefix", () => {
    for (const identifier of NON_YOUTUBE) {
      expect(youtubeVideoIdFromIdentifier(identifier), identifier).toBeNull();
    }
    expect(youtubeVideoIdFromIdentifier(`youtube-${CLEARED}`)).toBe(CLEARED);
    expect(youtubeVideoIdFromIdentifier(null)).toBeNull();
  });
});

// ─── TEST D ──────────────────────────────────────────────────────────────────────────────────

describe("RONDE 146 TEST D — an unlisted YouTube asset is NOT operator licensed", () => {
  it("D1. the flag alone does not clear a video the operator never named", () => {
    // This is exactly what RONDE 145 got wrong.
    const d = armed({ identifier: `youtube-${NOT_CLEARED}` });
    expect(d.allowed).toBe(false);
    expect(d.action).toBe("REJECT");
    expect(d.licenseBasis).toBe("archive_metadata");
  });

  it("D2. an empty list clears nothing, however the flag is set", () => {
    const d = armed({ licensedIds: ids() });
    expect(d.allowed).toBe(false);
    expect(d.action).toBe("REJECT");
  });

  it("D3. ids are case-sensitive — a near-miss is a different video", () => {
    expect(
      isOperatorLicensedYoutubeAsset({
        identifier: `youtube-${CLEARED.toLowerCase()}`,
        allowOperatorLicensed: true,
        licensedIds: ids(CLEARED),
      })
    ).toBe(false);
    // And the list itself does not fold case on the way in.
    expect(operatorLicensedYoutubeIds(CLEARED).has(CLEARED.toLowerCase())).toBe(false);
  });

  it("D4. a missing licenceUrl does not become a valid licence by being on the list", () => {
    // R124's rule: classification reads the metadata and nothing else.
    expect(classifyArchiveLicense(null, null)).toBe("UNVERIFIED");
    const d = armed({ licenseUrl: null, rights: null });
    expect(d.status).toBe("UNVERIFIED");
    expect(d.licenseUrl).toBeNull();
    // Allowed, yes — but on the operator's authority, never presented as a licence.
    expect(d.licenseBasis).toBe("operator_assertion");
  });
});

// ─── TEST E ──────────────────────────────────────────────────────────────────────────────────

describe("RONDE 146 TEST E — never presented as though YouTube supplied the right", () => {
  it("E1. the log line carries source=operator and names the real authority", () => {
    const line = formatYoutubeLicenseLine(armed());
    expect(line).toContain("source=operator");
    expect(line).toContain("status=REJECTED");
    expect(line).toContain("action=ALLOW_OPERATOR_LICENSED_YOUTUBE");
    expect(line).toContain("NOT any right FastVid or YouTube verified");
    expect(line).toContain("OPERATOR_LICENSED_YOUTUBE_IDS");
  });

  it("E2. an ordinary archive-verified item says source=archive", () => {
    const line = formatYoutubeLicenseLine(armed({ licenseUrl: CC_BY }));
    expect(line).toContain("status=VERIFIED");
    expect(line).toContain("source=archive");
    expect(line).not.toContain("source=operator");
  });

  it("E3. there is no line on which VERIFIED appears without its source", () => {
    // The combination the brief calls false — a VERIFIED status attributed to YouTube when a
    // human is the actual authority — must be unconstructible from this formatter.
    for (const d of [armed(), armed({ licenseUrl: CC_BY }), armed({ allowOperatorLicensed: false })]) {
      const line = formatYoutubeLicenseLine(d);
      expect(line).toMatch(/source=(operator|archive)/);
      if (line.includes("source=operator")) expect(line).not.toContain("status=VERIFIED");
    }
  });

  it("E4. the usage report marks operator-cleared items, whatever their status", () => {
    const entry = (over: Partial<YoutubeUsageEntry>): YoutubeUsageEntry => ({
      sceneIndex: 2, beatIndex: 1, youtubeVideoId: CLEARED,
      licenseStatus: "REJECTED", licenseBasis: "operator_assertion",
      licenseUrl: NC, rights: null, previewStatus: "ok", visionVerdict: "fits",
      ...over,
    });
    const rejected = formatYoutubeUsageReport([entry({})]);
    expect(rejected).toContain("source=operator");
    expect(rejected).toContain("⛔");
    expect(rejected).toContain("neither did YouTube");

    // An operator-cleared UNVERIFIED item gets the same strong marker, not the weak one.
    const unverified = formatYoutubeUsageReport([
      entry({ licenseStatus: "UNVERIFIED", licenseUrl: null }),
    ]);
    expect(unverified).toContain("⛔");
    expect(unverified).toContain("archive metadata says UNVERIFIED");
  });

  it("E5. an entry with no basis reads as the archive's, which is what old entries were", () => {
    const report = formatYoutubeUsageReport([
      {
        sceneIndex: 0, beatIndex: 0, youtubeVideoId: "abc",
        licenseStatus: "UNVERIFIED", licenseUrl: null, rights: null,
        previewStatus: "ok", visionVerdict: "fits",
      },
    ]);
    expect(report).toContain("source=archive");
    expect(report).toContain("rights NOT verified by FastVid");
    expect(report).not.toContain("⛔");
  });
});

// ─── scope, restated against the whole chain ─────────────────────────────────────────────────

describe("RONDE 146 — one decision, two call sites, no second engine", () => {
  it("F1. the pipeline and the scene pool both gate on `.allowed` and read no env of their own", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const pipe = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const pool = fs.readFileSync(path.join(__dirname, "scenePool.ts"), "utf8");
    expect(pipe).toContain("if (!licenseDecision.allowed) {");
    expect(pool).toContain("if (!poolLicense.allowed) continue;");
    for (const src of [pipe, pool]) {
      expect(src).not.toContain("ALLOW_OPERATOR_LICENSED_YOUTUBE");
      expect(src).not.toContain("OPERATOR_LICENSED_YOUTUBE_IDS");
    }
  });

  it("F2. the override lives in exactly one module", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const dir = path.join(__dirname);
    const owners = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) =>
        fs.readFileSync(path.join(dir, f), "utf8").includes("OPERATOR_LICENSED_YOUTUBE_IDS")
      );
    expect(owners).toEqual(["youtubeLicenseStatus.ts"]);
  });
});
