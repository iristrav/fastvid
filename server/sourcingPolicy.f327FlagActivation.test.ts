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
});
