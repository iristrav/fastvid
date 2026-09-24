import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  sceneCandidatePoolEnabled,
  retrievalFunnelEnabled,
  archiveFirstBeatsEnabled,
  externalAssetIngestionEnabled,
} from "./sourcingPolicy";

// F3-27: these four flags gate the entire archive→web fallback→ingest→learning flow (F3-26).
// They previously defaulted OFF (opt-in), which meant the fully-built, fully-tested F3-26
// self-learning ingestion never ran in production. Flipped to default ON (opt-out) — the
// funnel path falls back to the legacy per-beat waterfall on any error (unchanged try/catch
// around its call site in videoPipeline.ts), so this activates a fallback layer ahead of the
// existing behavior rather than replacing it. Each flag keeps its explicit opt-out via
// <NAME>=false, unchanged for anyone already relying on the old opt-in behavior.
describe("sourcingPolicy — F3-27 live activation (default-on, explicit opt-out preserved)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.ENABLE_SCENE_CANDIDATE_POOL;
    delete process.env.ENABLE_RETRIEVAL_FUNNEL;
    delete process.env.ENABLE_ARCHIVE_FIRST_BEATS;
    delete process.env.ENABLE_EXTERNAL_ASSET_INGESTION;
    /**
     * RONDE 648 — these are the pool route's flags, tested as that route has them. YouTube-first
     * mode (the default since RONDE 648) turns the scene pool off whatever they say; that is
     * pinned in the last test here and in youtubeGoesFirstPerBeat.test.ts.
     */
    process.env.SOURCING_YOUTUBE_FIRST = "false";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("Test A — all four flags default to enabled when unset (the archive→web→ingest→learn flow is live)", () => {
    expect(sceneCandidatePoolEnabled()).toBe(true);
    expect(retrievalFunnelEnabled()).toBe(true);
    expect(archiveFirstBeatsEnabled()).toBe(true);
    expect(externalAssetIngestionEnabled()).toBe(true);
  });

  it("Test B — each flag can still be explicitly disabled via <NAME>=false", () => {
    process.env.ENABLE_SCENE_CANDIDATE_POOL = "false";
    process.env.ENABLE_RETRIEVAL_FUNNEL = "false";
    process.env.ENABLE_ARCHIVE_FIRST_BEATS = "false";
    process.env.ENABLE_EXTERNAL_ASSET_INGESTION = "false";
    expect(sceneCandidatePoolEnabled()).toBe(false);
    expect(retrievalFunnelEnabled()).toBe(false);
    expect(archiveFirstBeatsEnabled()).toBe(false);
    expect(externalAssetIngestionEnabled()).toBe(false);
  });

  it("any other value (not the literal string 'false') is still treated as enabled", () => {
    process.env.ENABLE_SCENE_CANDIDATE_POOL = "0";
    expect(sceneCandidatePoolEnabled()).toBe(true);
  });

  it("RONDE 648 — with YouTube-first mode on (its default), no scene pool runs", () => {
    delete process.env.SOURCING_YOUTUBE_FIRST;
    expect(sceneCandidatePoolEnabled()).toBe(false);
    process.env.ENABLE_SCENE_CANDIDATE_POOL = "true";
    expect(sceneCandidatePoolEnabled()).toBe(false);
  });
});
