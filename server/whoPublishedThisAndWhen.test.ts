import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { classifyChannelAuthority, formatChannelAuthority } from "./channelAuthority";
import { poolCandidateToAsset, type RankablePoolCandidate } from "./poolRanking";

/**
 * WHO PUBLISHED THIS, AND WHEN — two facts the pipeline collected and never read.
 *
 * ── What the audit found ────────────────────────────────────────────────────────────────────
 *
 * `youtubePoolSource.ts` writes `channel` and `publishedAt` onto every candidate. A search for
 * `channelAuthority`, `sourceAuthority` or `authorityScore` across the server returns nothing
 * outside tests, and `poolCandidateToAsset` set `metadata: null` — while the ranking engine's
 * `freshnessScore` reads exactly `metadata.publishedAt`. So the freshness signal, weighted 0.02,
 * could never fire for any candidate in any render: a reader with no writer, the same shape as
 * RONDE 53's `recordClipAdopt` and RONDE 70's beat audit.
 *
 * Consequence: a national archive, a public broadcaster, a university and an anonymous re-uploader
 * were indistinguishable. All four scored `youtube_cc: 55`.
 */

const candidate = (over: Partial<RankablePoolCandidate> = {}): RankablePoolCandidate => ({
  id: "c1",
  assetId: "a1",
  source: "youtube_cc",
  remoteUrl: "https://example.invalid/v",
  thumbnailUrl: null,
  title: "A clip",
  description: null,
  tags: [],
  mediaType: "video",
  durationSec: 12,
  license: null,
  width: null,
  height: null,
  clipSimilarity: null,
  embeddingSimilarity: null,
  rankingScore: null,
  ...over,
});

/* ═══════════════════ A · the classifier ═══════════════════ */

describe("a channel is classified by what it says it is, not by a list", () => {
  it("an archive names itself an archive — in whatever language it publishes in", () => {
    for (const name of ["National Archives", "Nederlands Archief", "Bundesarchiv", "Archivo Histórico"]) {
      expect(classifyChannelAuthority(name).authorityClass, name).toBe("ARCHIVE");
    }
  });

  it("and so do the other institutional kinds", () => {
    expect(classifyChannelAuthority("Rijksmuseum").authorityClass).toBe("MUSEUM");
    expect(classifyChannelAuthority("Universiteit Leiden").authorityClass).toBe("UNIVERSITY");
    expect(classifyChannelAuthority("Ministerie van Defensie").authorityClass).toBe("GOVERNMENT");
    expect(classifyChannelAuthority("Reuters News").authorityClass).toBe("NEWS");
  });

  it("NO CHANNEL LIST ANYWHERE — the rule is vocabulary, not identity", () => {
    /**
     * The subject-neutrality guarantee, enforced on the source. A hardcoded roster of approved
     * channels would work for the videos whoever wrote it was making and for nothing else.
     */
    /**
     * Comments stripped: the module's own prose explains why a whitelist is the wrong answer, and
     * a test that reads the explanation as the offence would fail on the documentation.
     */
    const SRC = readFileSync(join(__dirname, "channelAuthority.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const banned of ["youtube.com/@", "channelId", "whitelist", "approvedChannels"]) {
      expect(SRC, `the classifier carries "${banned}"`).not.toContain(banned);
    }
    /**
     * A YouTube channel id, by its actual shape — `UC` plus 22 id characters. The first version of
     * this test banned the bare string "UC", which fires on the word EDUCATIONAL and says nothing
     * about channel lists.
     */
    expect(SRC, "a channel id is hardcoded").not.toMatch(/UC[A-Za-z0-9_-]{22}/);
  });

  it("a channel that claims nothing institutional is CREATOR, not a failure", () => {
    const a = classifyChannelAuthority("Dave's Video Corner");
    expect(a.authorityClass).toBe("CREATOR");
    expect(a.confidence).toBe(0);
  });

  it("UNKNOWN AND CREATOR ARE DIFFERENT ANSWERS", () => {
    /**
     * "Nobody claimed anything" is not "we could not look". A ranking that collapsed the two would
     * be asserting something about a channel it never saw.
     */
    expect(classifyChannelAuthority(null).authorityClass).toBe("UNKNOWN");
    expect(classifyChannelAuthority("").authorityClass).toBe("UNKNOWN");
    expect(classifyChannelAuthority("Dave's Video Corner").authorityClass).toBe("CREATOR");
  });

  it("the word must stand on its own — 'archived' does not make a channel an archive", () => {
    expect(classifyChannelAuthority("Archived Footage Uploads").authorityClass).not.toBe("ARCHIVE");
  });

  it("the description is read when the name says nothing", () => {
    expect(
      classifyChannelAuthority("Collectie Beeld", "Uploads from the national film archive")
        .authorityClass
    ).toBe("MUSEUM");
    expect(
      classifyChannelAuthority("Clips", "Uploads from the national film archive").authorityClass
    ).toBe("ARCHIVE");
  });

  it("every class carries a confidence and the reason it fired", () => {
    const a = classifyChannelAuthority("Bundesarchiv");
    expect(a.confidence).toBeGreaterThan(0);
    expect(a.matched.length).toBeGreaterThan(0);
    expect(formatChannelAuthority(a)).toContain("ARCHIVE");
  });

  it("AND IT NEVER APPROVES ANYTHING — a class is a signal, not a verdict", () => {
    /**
     * Stated structurally: the module exports a classifier and a formatter, and nothing that
     * returns a boolean an adoption path could read as permission.
     */
    const SRC = readFileSync(join(__dirname, "channelAuthority.ts"), "utf8");
    expect(SRC).not.toMatch(/export function (is|may|can|allow|approve)[A-Z]/);
  });
});

/* ═══════════════════ B · the metadata that had no writer ═══════════════════ */

describe("the publication facts now reach the ranking engine", () => {
  it("PUBLISHED-AT IS CARRIED — the freshness signal can fire at all", () => {
    const asset = poolCandidateToAsset(
      candidate({ youtube: { channel: "Bundesarchiv", publishedAt: "2011-04-02T00:00:00Z" } })
    );
    expect(asset.metadata).toBeTruthy();
    expect((asset.metadata as Record<string, unknown>).publishedAt).toBe("2011-04-02T00:00:00Z");
  });

  it("and the channel's class rides in the same object", () => {
    const asset = poolCandidateToAsset(
      candidate({ youtube: { channel: "Bundesarchiv", publishedAt: null } })
    );
    const m = asset.metadata as Record<string, unknown>;
    expect(m.channelAuthority).toBe("ARCHIVE");
    expect(m.channelAuthorityConfidence).toBe(1);
  });

  it("A CANDIDATE WITH NO PUBLICATION FACTS IS EXACTLY AS IT WAS", () => {
    /**
     * The compatibility guarantee. Every non-YouTube provider supplies neither field, and null is
     * what the engine wants: it redistributes an absent signal's weight instead of scoring a
     * fabricated zero.
     */
    expect(poolCandidateToAsset(candidate()).metadata).toBeNull();
    expect(poolCandidateToAsset(candidate({ youtube: null })).metadata).toBeNull();
    expect(
      poolCandidateToAsset(candidate({ youtube: { channel: null, publishedAt: null } })).metadata
    ).toBeNull();
  });

  it("authority is omitted when there is no channel to judge", () => {
    const m = poolCandidateToAsset(
      candidate({ youtube: { channel: null, publishedAt: "2011-04-02T00:00:00Z" } })
    ).metadata as Record<string, unknown>;
    expect(m.publishedAt).toBe("2011-04-02T00:00:00Z");
    expect(m.channelAuthority).toBeUndefined();
  });
});

/* ═══════════════════ C · recency is not a virtue on a dated beat ═══════════════════ */

describe("a beat about 1945 is not pulled toward recent uploads", () => {
  const POOL = readFileSync(join(__dirname, "poolRanking.ts"), "utf8");

  it("THE FRESHNESS WEIGHT IS ZERO WHEN THE BEAT ASKED FOR ARCHIVAL MATERIAL", () => {
    /**
     * `freshnessScore` is `1 - ageYears / 20`: newer always scores higher. Right for a current
     * event, backwards for 1945, where a 2024 upload is likelier to be a reconstruction than the
     * footage. The signal had never fired before this round, so the question is new.
     */
    expect(POOL).toContain('if (!need?.preferred.includes("ARCHIVAL_FOOTAGE"))');
    expect(POOL).toContain("freshness: 0");
  });

  it("and it is ZERO, not inverted — 'older is better' is a claim nobody proved", () => {
    expect(POOL).not.toMatch(/freshness:\s*-/);
    expect(POOL).not.toContain("invertFreshness");
  });

  it("every other weight is untouched, and a beat with no need gets the defaults", () => {
    expect(POOL).toContain("return DEFAULT_RANKING_CONFIG.weights;");
    expect(POOL).toContain("{ ...DEFAULT_RANKING_CONFIG.weights, freshness: 0 }");
  });

  it("no signal was given a weight this round — the thirteen are still thirteen", () => {
    /**
     * Channel authority is carried and NOT weighted. A fourteenth signal redistributes the other
     * thirteen, and that is a decision to make against measured data rather than in the same
     * change that first makes the data exist.
     */
    /**
     * The class IS written — into `metadata`, where it is carried and reported. What must not
     * exist is a WEIGHT for it, which is what would redistribute the other thirteen. The first
     * version of this test banned the field itself and so tested the opposite of the intent.
     */
    expect(POOL).toContain("channelAuthority: authority.authorityClass");
    expect(POOL).not.toMatch(/weights\.[a-zA-Z]*[Aa]uthority/);
    expect(POOL).not.toMatch(/authority[A-Za-z]*(Weight|Contribution)/);

    const WEIGHTS = readFileSync(
      join(__dirname, "visualMatchingV2", "candidateRanking.ts"),
      "utf8"
    );
    const block = WEIGHTS.slice(
      WEIGHTS.indexOf("DEFAULT_RANKING_WEIGHTS"),
      WEIGHTS.indexOf("DEFAULT_SOURCE_PRIORITY")
    );
    expect(block, "a signal was added to the engine's weights").not.toMatch(/authority/i);
  });
});
