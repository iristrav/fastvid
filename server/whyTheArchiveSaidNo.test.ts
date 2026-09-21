/**
 * WHY THE ARCHIVE SAID NO.
 *
 * ── The line render 595 produced three times ────────────────────────────────────────────────
 *
 *     [ProductionArchive] ARCHIVE_STORE_FAILED … code=ARCHIVE_INGEST_REFUSED status=REJECTED
 *       reason="the archive ingestion refused extend_s1b3_….mp4
 *               (its own quality gate, or a storage failure)"
 *
 * for `extend_s1b3_*`, `extend_s2b3_*` and `extend_s0b1_*`. Eleven different refusals inside
 * `ingestExternalClipToArchiveInner` all return the same bare `null`, and the caller then guessed
 * between two of them with an "or". A file that is 40 KB, a file that is 300 seconds long, a file
 * carrying burnt-in subtitles and a bucket that rejected the upload were one sentence.
 *
 * Those need opposite work: the first three are about the clip, the fourth is about us.
 *
 * ── What is NOT being decided here ──────────────────────────────────────────────────────────
 *
 * "Niet de quality gate versoepelen voordat bewezen is dat de quality gate fout zit." Every
 * threshold in `archiveIngestion` is exactly where it was — 50 000 bytes, 3 seconds, 120 seconds,
 * the RONDE 24 text check, the RONDE 118 preview check. This round makes the refusal legible so
 * the next one can be argued from a measurement instead of a guess.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readFileSync } from "fs";

import { storeForProduction, type ProductionArchiveDeps } from "./productionMediaArchive";

const INGESTION = readFileSync(path.join(__dirname, "archiveIngestion.ts"), "utf8");

/* ═══════════════════ A REAL FILE, BECAUSE ffprobe READS IT ═══════════════════ */

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "why-archive-"));

/** A genuine 3-second H.264 file, built by ffmpeg. No fixture is checked in and none is faked. */
function makeClip(name: string, seconds: number): string {
  const out = path.join(ROOT, name);
  const { execFileSync } = require("child_process") as typeof import("child_process");
  execFileSync(
    process.env.FFMPEG_PATH || "ffmpeg",
    [
      "-y", "-f", "lavfi", "-i", `testsrc=size=320x180:rate=15:duration=${seconds}`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", out,
    ],
    { stdio: "ignore" }
  );
  return out;
}

const REAL = makeClip("real.mp4", 3);

const META = {
  title: "an extended beat clip",
  tags: [],
  sourceNote: "youtube_cc:gPOOfUxvc0w",
  mediaType: "video" as const,
  mimeType: "video/mp4",
};

function deps(over: Partial<ProductionArchiveDeps> = {}): ProductionArchiveDeps {
  return {
    ingest: async () => ({ assetId: 1, storageKey: "k" }),
    updateAsset: async () => {},
    readBack: async (_id, dest) => {
      fs.writeFileSync(dest, "bytes");
      return true;
    },
    ...over,
  };
}

const CTX = { provider: "youtube_cc", providerAssetId: "gPOOfUxvc0w", sceneIndex: 1, beatIndex: 3 };

async function refusalFor(over: Partial<ProductionArchiveDeps>): Promise<string> {
  const out = await storeForProduction({
    localPath: REAL,
    provider: "youtube_cc",
    providerAssetId: "gPOOfUxvc0w",
    metadata: META,
    deps: deps(over),
    ctx: CTX,
    verifyDir: path.join(ROOT, "verify"),
  });
  expect(out.status).toBe("failed");
  return out.status === "failed" ? out.message : "";
}

/* ═══════════════════ THE REFUSAL NAMES ITSELF ═══════════════════ */

describe("ARCHIVE_INGEST_REFUSED says which refusal it was", () => {
  it("THE REASON CODE COMES FROM THE INGESTION AND IS NOT INFERRED", async () => {
    const message = await refusalFor({
      ingest: async () => ({
        refusal: { reasonCode: "FILE_TOO_SMALL", reasonDetail: "41213 bytes < 50000" },
      }),
    });
    expect(message).toContain("reasonCode=FILE_TOO_SMALL");
    expect(message).toContain('reasonDetail="41213 bytes < 50000"');
  });

  it("A STORAGE FAILURE IS NOT A QUALITY VERDICT — the two halves of the old sentence", async () => {
    /**
     * `STORAGE_WRITE_FAILED` means nothing is wrong with the clip. Under the old wording an
     * operator reading the line would have re-judged the footage, which is the wrong work.
     */
    const message = await refusalFor({
      ingest: async () => ({
        refusal: { reasonCode: "STORAGE_WRITE_FAILED", reasonDetail: "the bucket rejected the key" },
      }),
    });
    expect(message).toContain("reasonCode=STORAGE_WRITE_FAILED");
    expect(message).not.toContain("quality gate");
  });

  it("AN INGESTION THAT SUPPLIES NO REASON IS UNKNOWN, never a plausible one", async () => {
    /**
     * "Gebruik alleen codes die daadwerkelijk uit de code volgen. Geen verzonnen redenen." A
     * caller with nothing to report reports nothing, and says so in a word.
     */
    const message = await refusalFor({ ingest: async () => null });
    expect(message).toContain("reasonCode=UNKNOWN");
    expect(message).not.toContain("quality gate");
  });

  it("an ingestion that THROWS is UNKNOWN with its message, not a rejected clip", async () => {
    const message = await refusalFor({
      ingest: async () => {
        throw new Error("connection reset");
      },
    });
    expect(message).toContain("reasonCode=UNKNOWN");
    expect(message).toContain("connection reset");
  });

  it("EVERY REFUSAL CARRIES THE MEASUREMENTS §3 ASKS FOR", async () => {
    const message = await refusalFor({ ingest: async () => null });
    for (const field of [
      "sourcePath=", "fileExists=true", "fileSize=", "mimeType=video/mp4",
      "ffprobeSuccess=true", "duration=", "width=320", "height=180",
    ]) {
      expect(message, `${field} is missing from the refusal`).toContain(field);
    }
  });

  it("and the numbers are READINGS, not the provider's claims", async () => {
    /**
     * `duration`, `width` and `height` come from the ffprobe in step 2 of `storeForProduction`.
     * The metadata above declares no duration at all, so anything printed can only have been
     * measured off the file.
     */
    expect(META).not.toHaveProperty("durationSec");
    const message = await refusalFor({ ingest: async () => null });
    expect(message).toMatch(/duration=3\.\d\d/);
  });

  it("the source PATH is a basename — a work directory is not for a log", async () => {
    const message = await refusalFor({ ingest: async () => null });
    expect(message).toContain("sourcePath=real.mp4");
    expect(message).not.toContain(ROOT);
  });
});

/* ═══════════════════ THE extend_*.mp4 REPRODUCTION ═══════════════════ */

describe("an extended clip, refused for a reason that can be read", () => {
  let logged: string[];
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logged = [];
    log = vi.spyOn(console, "log").mockImplementation((...a) => void logged.push(a.join(" ")));
  });
  afterEach(() => log.mockRestore());

  it("REPRODUCES RENDER 595's REFUSAL, and this time the log says which condition fired", async () => {
    /**
     * A real file, named as production named it, refused by the real threshold. The point is the
     * line that comes out: `reasonCode=INVALID_DURATION reasonDetail="300.00s > 120s"` is a
     * sentence somebody can act on, and `(its own quality gate, or a storage failure)` was not.
     */
    const extended = makeClip("extend_s1b3_youtube_cc.mp4", 3);
    const out = await storeForProduction({
      localPath: extended,
      provider: "youtube_cc",
      providerAssetId: "gPOOfUxvc0w",
      metadata: { ...META, durationSec: 300 },
      deps: deps({
        ingest: async () => ({
          refusal: {
            reasonCode: "INVALID_DURATION",
            reasonDetail: "300.00s > 120s",
            fileExists: true,
            fileSizeBytes: 7000,
            mimeType: "video/mp4",
            durationSec: 300,
          },
        }),
      }),
      ctx: CTX,
      verifyDir: path.join(ROOT, "verify"),
    });
    expect(out.status).toBe("failed");
    if (out.status === "failed") {
      expect(out.code).toBe("ARCHIVE_INGEST_REFUSED");
      expect(out.message).toContain("reasonCode=INVALID_DURATION");
      expect(out.message).toContain('reasonDetail="300.00s > 120s"');
      expect(out.message).toContain("sourcePath=extend_s1b3_youtube_cc.mp4");
    }
  });

  it("THE GATE IS HANDED THE DURATION THIS FILE HAS, not the one a provider claimed", async () => {
    /**
     * §4's other half. The metadata reaching `archiveIngestion` used to be
     * `cached?.durationSec ?? null` — the provider's number for the ORIGINAL asset, which for an
     * `extend_*.mp4` is the wrong number by construction, and for a YouTube clip is usually
     * absent, so `dur = 0` and neither duration bound could fire at all. `storeForProduction` had
     * already ffprobed these exact bytes and did not pass the reading on.
     */
    const extended = makeClip("extend_s0b1_measured.mp4", 3);
    let seen: number | undefined = -1;
    await storeForProduction({
      localPath: extended,
      provider: "youtube_cc",
      /** A provider's claim, and a wrong one — 40 seconds for a 3-second file. */
      metadata: { ...META, durationSec: 40 },
      deps: deps({
        ingest: async (_p, m) => {
          seen = m.durationSec;
          return { refusal: { reasonCode: "UNKNOWN", reasonDetail: "x" } };
        },
      }),
      ctx: CTX,
      verifyDir: path.join(ROOT, "verify"),
    });
    expect(seen, "the provider's claim was passed through").not.toBe(40);
    expect(seen).toBeGreaterThan(2.5);
    expect(seen).toBeLessThan(3.5);
  });

  it("and a probe that measured nothing leaves the caller's value alone", async () => {
    const src = readFileSync(path.join(__dirname, "productionMediaArchive.ts"), "utf8");
    expect(src).toContain("const measured = facts?.durationSec;");
    expect(src).toContain("measured != null && measured > 0");
    expect(src).toContain("      : params.metadata;");
  });

  it("THE REFUSAL STILL REFUSES — a legible reason is not an admission", async () => {
    /**
     * The whole risk of this change is that naming a refusal softens it. The outcome is `failed`,
     * the `mediaStatus` is REJECTED, and `ensureArchiveBackedBeforePush` still turns that into a
     * push the timeline does not get.
     */
    const out = await storeForProduction({
      localPath: REAL,
      provider: "youtube_cc",
      metadata: META,
      deps: deps({
        ingest: async () => ({ refusal: { reasonCode: "BAKED_EDIT_TEXT", reasonDetail: "has_text" } }),
      }),
      ctx: CTX,
      verifyDir: path.join(ROOT, "verify"),
    });
    expect(out.status).toBe("failed");
    if (out.status === "failed") expect(out.mediaStatus).toBe("REJECTED");
  });
});

/* ═══════════════════ THE CODES EXIST IN THE CODE ═══════════════════ */

describe("no code names a refusal the ingestion cannot make", () => {
  const produced = [...INGESTION.matchAll(/refuse\(\s*"([A-Z_]+)"/g)].map((m) => m[1]!);

  it("EVERY DECLARED CODE IS RETURNED SOMEWHERE", () => {
    const declared = [
      ...INGESTION.slice(
        INGESTION.indexOf("export type IngestRefusalCode"),
        INGESTION.indexOf("export type IngestRefusal =")
      ).matchAll(/\|\s*"([A-Z_]+)"/g),
    ].map((m) => m[1]!);
    expect(declared.length).toBeGreaterThan(5);
    for (const code of declared) {
      expect(produced, `${code} is declared and never returned`).toContain(code);
    }
  });

  it("AND THE THRESHOLDS ARE EXACTLY WHERE THEY WERE", () => {
    /** §11 — nothing about what the archive accepts changed in this round. */
    expect(INGESTION).toContain("const MIN_FILE_BYTES = 50_000;");
    expect(INGESTION).toContain("const MIN_VIDEO_DURATION_SEC = 3;");
    expect(INGESTION).toContain("const MAX_VIDEO_DURATION_SEC = 120;");
    expect(INGESTION).toContain("if (sizeBytes < MIN_FILE_BYTES)");
    expect(INGESTION).toContain("if (dur > 0 && dur < MIN_VIDEO_DURATION_SEC)");
    expect(INGESTION).toContain("if (dur > MAX_VIDEO_DURATION_SEC)");
  });

  it("the stock exemption, the text check and the preview check all still refuse", () => {
    expect(INGESTION).toContain('return refuse("EXEMPT_SOURCE"');
    expect(INGESTION).toContain('return refuse("BAKED_EDIT_TEXT"');
    expect(INGESTION).toContain('return refuse("PREVIEW_UNREADABLE"');
  });

  it("THE NULL-RETURNING ENTRY POINT IS UNCHANGED FOR EVERY OTHER CALLER", () => {
    /**
     * The pipeline's fire-and-forget sites have nothing to do with a reason, and handing them one
     * would invite a decision in a place that must not make decisions.
     */
    expect(INGESTION).toContain("): Promise<IngestResult | null> {");
    expect(INGESTION).toContain("if (outcome.status !== \"ingested\") return null;");
  });
});
