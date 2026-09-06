/**
 * THE MODEL CACHE, AND THE SENTENCE THAT WAS NOT TRUE.
 *
 * ── The evidence ────────────────────────────────────────────────────────────────────────────
 *
 * Worker log, 2026-09-05, 18:04 to 18:54 — fifty minutes, eleven boots, and eleven of these:
 *
 *     [Worker] Pre-loading CLIP model (cache: /tmp/fastvid-transformers-cache)...
 *     [LocalVision] CLIP model not in cache (/tmp/fastvid-transformers-cache) — will download now
 *       (one-time, ~350MB, persists to volume)
 *     [LocalVision] First-time download — using 300s timeout (attempt 1)
 *
 * Ten `not in cache` lines and ten `warm-up complete` lines: every boot paid the download again.
 * The same log shows why. The web service reports `/data/uploads (✓ persistent volume)`; the
 * worker service — the process that renders — reports `/app/uploads (⚠ ephemeral)` and runs three
 * replicas. The volume is mounted on the wrong service, so `clipModelCacheDir()` fell through to
 * `os.tmpdir()`, which the container discards.
 *
 * Nothing crashed. `clip_vision` reported OK in all eleven preflights, correctly — the model does
 * load. What was wrong was the sentence next to it, which told an operator the download was
 * one-time and would persist, at the moment it was doing neither.
 *
 * ── What these tests hold ───────────────────────────────────────────────────────────────────
 *
 * Not "the cache is on a volume" — this repository cannot decide where Railway mounts a disk. They
 * hold that the code never CLAIMS persistence it has not checked, and that the preflight reports
 * the true answer where an operator is already looking.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { clipModelCacheLocation } from "./clipModelCache";
import { checkHost, type HostProbes } from "./productionPreflight";

const probes: HostProbes = {
  hasBinary: () => true,
  hasBrowser: () => true,
  canReachDatabase: async () => true,
  canReachRedis: async () => true,
  canLoadVisionModel: async () => true,
};

const cacheEntry = async (env: NodeJS.ProcessEnv) =>
  (await checkHost(probes, { DATABASE_URL: "mysql://h/d", ...env })).find(
    (h) => h.id === "clip_model_cache"
  )!;

describe("where the model is kept", () => {
  /** Render 569's worker, reconstructed from its log: no volume variable of any kind. */
  it("a service with no volume is reported as not keeping the model", () => {
    const where = clipModelCacheLocation({});
    expect(where.persists).toBe(false);
    expect(where.dir).toContain("fastvid-transformers-cache");
    expect(where.why).toMatch(/every boot/i);
  });

  it("a mounted volume is reported as keeping it", () => {
    const where = clipModelCacheLocation({ RAILWAY_VOLUME_MOUNT_PATH: "/data" });
    expect(where.persists).toBe(true);
    expect(where.dir).toBe("/data/transformers-cache");
  });

  it("UPLOADS_DIR on the volume puts the cache beside it", () => {
    const where = clipModelCacheLocation({ UPLOADS_DIR: "/data/uploads" });
    expect(where.dir).toBe("/data/transformers-cache");
    expect(where.persists).toBe(true);
  });

  /**
   * THE CASE THE OLD CODE GOT WRONG IN BOTH DIRECTIONS.
   *
   * An explicit `TRANSFORMERS_CACHE` was obeyed and then described as persistent regardless of
   * where it pointed. Pointing it at a scratch directory is exactly how a service ends up
   * re-downloading forever while its log insists otherwise.
   */
  it("an explicit path outside the volume is obeyed and NOT called persistent", () => {
    const where = clipModelCacheLocation({
      TRANSFORMERS_CACHE: "/tmp/somewhere",
      RAILWAY_VOLUME_MOUNT_PATH: "/data",
    });
    expect(where.dir).toBe("/tmp/somewhere");
    expect(where.persists).toBe(false);
    expect(where.why).toMatch(/NOT on a mounted volume/);
  });

  it("an explicit path inside the volume is", () => {
    const where = clipModelCacheLocation({
      TRANSFORMERS_CACHE: "/data/models",
      RAILWAY_VOLUME_MOUNT_PATH: "/data",
    });
    expect(where.persists).toBe(true);
  });

  /**
   * `/data` is a convention, not a mount. When the host names its volume somewhere else, a path
   * under `/data` is just a directory in the container — and the answer has to follow the mount.
   */
  it("/data is not persistent when the volume is mounted elsewhere", () => {
    expect(
      clipModelCacheLocation({
        TRANSFORMERS_CACHE: "/data/models",
        RAILWAY_VOLUME_MOUNT_PATH: "/mnt/vol",
      }).persists
    ).toBe(false);
  });
});

describe("a model baked into the image", () => {
  /**
   * The remedy this deployment actually took. A Railway volume caps the service at one replica and
   * the worker runs three, so the weights are fetched during the image build instead — see the
   * Dockerfile layer that sets both of these variables.
   */
  it("is permanent without any volume", () => {
    const where = clipModelCacheLocation({
      CLIP_MODEL_PREBAKED: "true",
      TRANSFORMERS_CACHE: "/opt/models/transformers-cache",
    });
    expect(where.persists).toBe(true);
    expect(where.dir).toBe("/opt/models/transformers-cache");
    expect(where.why).toMatch(/baked into the image/);
  });

  it("does not need a volume variable to say so", () => {
    expect(
      clipModelCacheLocation({
        CLIP_MODEL_PREBAKED: "true",
        TRANSFORMERS_CACHE: "/opt/models/transformers-cache",
      }).persists
    ).toBe(true);
  });

  /**
   * The claim needs BOTH halves. A marker with no directory names nothing, and this module's whole
   * rule is that persistence is never asserted without something to point at.
   */
  it("a marker with no directory falls through to the normal rules", () => {
    const where = clipModelCacheLocation({ CLIP_MODEL_PREBAKED: "true" });
    expect(where.persists).toBe(false);
    expect(where.why).toMatch(/no volume is mounted/);
  });

  it.each(["false", "", "1", "yes"])("is not claimed for a marker of %j", (value) => {
    const where = clipModelCacheLocation({
      CLIP_MODEL_PREBAKED: value,
      TRANSFORMERS_CACHE: "/opt/models/transformers-cache",
    });
    expect(where.persists).toBe(false);
  });

  /** The build layer and the runtime claim have to name the same directory. */
  it("the Dockerfile sets both variables in one place", () => {
    const df = fs.readFileSync(path.join(__dirname, "..", "Dockerfile"), "utf8");
    expect(df).toContain("ENV TRANSFORMERS_CACHE=/opt/models/transformers-cache");
    expect(df).toContain("ENV CLIP_MODEL_PREBAKED=true");
    expect(df).toContain("RUN node scripts/prefetch-clip-model.mjs");
  });
});

describe("the build asks what the runtime asks", () => {
  /**
   * The first prebaked build cached both towers and then failed its own check, because both the
   * check and `clipModelExistsLocally` read the model directory FLATLY while
   * @xenova/transformers writes `<model>/onnx/model_quantized.onnx`.
   *
   * A build check with its own opinion can pass while the runtime still downloads, so the two
   * rules are pinned together here rather than left to agree by accident.
   */
  const script = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "prefetch-clip-model.mjs"),
    "utf8"
  );
  const vision = fs.readFileSync(path.join(__dirname, "localClipVision.ts"), "utf8");

  it.each([
    ["the build check", () => script],
    ["clipModelExistsLocally", () => vision.slice(vision.indexOf("function clipModelExistsLocally"))],
  ])("%s lists the model directory recursively", (_label, read) => {
    expect(read()).toContain("recursive: true");
  });

  /** Both look under the same directory: cacheDir + the model id, not a path of their own. */
  it("both derive the directory from the model id", () => {
    expect(script).toContain("path.join(cacheDir, ...CLIP_MODEL.split(\"/\"))");
    expect(vision).toContain("path.join(cacheDir, modelSlug)");
  });

  /**
   * And when it fails it says WHERE the files went. "FAILED: no .onnx" cannot tell "nothing was
   * written" from "written somewhere else", and those need different fixes — a distinction that
   * cost a deploy cycle.
   */
  it("a failing build prints the real location", () => {
    expect(script).toContain("DID land under");
    expect(script).toContain("Tree:");
  });
});

describe("the preflight says it out loud", () => {
  it("reports the cache as a host entry, naming the directory", async () => {
    const entry = await cacheEntry({});
    expect(entry.available).toBe(false);
    expect(entry.detail).toContain("transformers-cache");
  });

  it("reports OK when the model is actually kept", async () => {
    const entry = await cacheEntry({ RAILWAY_VOLUME_MOUNT_PATH: "/data" });
    expect(entry.available).toBe(true);
    expect(entry.detail).toContain("downloaded once");
  });

  /**
   * A COST, NOT A BLOCKER — and the distinction is the whole point of three verdicts.
   *
   * The render runs either way and the film is identical. What an unkept cache buys is a 350MB
   * download per replica per deploy, and the operator should be able to see that without it ever
   * being confused with a reason not to start.
   */
  it("never blocks a render, only degrades it", async () => {
    const { productionPreflight } = await import("./productionPreflight");
    const report = await productionPreflight(probes, {
      DATABASE_URL: "mysql://h/d",
      ENFORCE_FUNNEL_ADOPTION: "true",
    });
    expect(report.blockers.join(" ")).not.toContain("clip_model_cache");
    expect(report.degradations.some((d) => d.startsWith("clip_model_cache:"))).toBe(true);
  });

  /** The two questions are separate: the model can load AND be thrown away afterwards. */
  it("is independent of whether the model loads", async () => {
    const loads = await checkHost(probes, { DATABASE_URL: "mysql://h/d" });
    expect(loads.find((h) => h.id === "clip_vision")!.available).toBe(true);
    expect(loads.find((h) => h.id === "clip_model_cache")!.available).toBe(false);
  });
});
